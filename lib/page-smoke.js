/**
 * dsh-startup-check · 页面侧冒烟引擎（page-side smoke）
 *
 * 为什么有这个文件：`plugin_check --live` 只判宿主进程能不能打印 `dsh web:` URL，
 * 看不到浏览器页面里的失败——纯客户端错误（客户端插件装载抛错 / keyed slot 重复键 /
 * console 报错）宿主全绿、页面却 `failed to apply loader entry`。本模块把
 * `_projects/插件预检/tools/smoke.mjs` 那套"无头 Edge + CDP 抓页面错误"的算法收进插件，
 * 作为 `plugin_check({ page: true })` 的页面那一半。
 *
 * 边界与纪律：
 * - 只读：不写被检查 profile 的任何文件；唯一自建物是 %TEMP% 下一次性的浏览器 profile
 *   目录，用完即删（rmSync）。
 * - 依赖注入：`spawn` 由调用方给（插件里传 `ctx.subprocess.spawn`，命令行工具里传
 *   `node:child_process` 适配器），因此同一份引擎既能跑在 dsh 宿主进程里，也能被
 *   `_projects/插件预检/tools/` 下的脚本直接复用，避免两处算法漂移。
 * - 本文件是引擎的唯一实现；`tools/smoke.mjs` 只是它的薄封装。
 * - 技术债登记：CDP 需要一个 WebSocket 客户端与一个临时目录。ctx.fs 没有"建临时目录"的
 *   能力、也没有 WebSocket 原语，故此处直接用 Node 内建（全局 WebSocket / node:http /
 *   node:fs 的临时目录）。若日后 dsh 提供正规机制，应迁回 ctx.*。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 候选浏览器（Edge 优先：Windows 自带，装了就能用）。 */
const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** 找一个可用的无头浏览器；找不到返回 undefined（调用方按"页面侧不可测"处理）。 */
export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch (e) {
      /* 探测失败继续试下一个 */
    }
  }
  return undefined;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 取一个当前空闲的本地端口（用后即关；仅用于 CDP 调试端口）。 */
async function pickFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 读一次 http://127.0.0.1:<port><path> 的 JSON（用 node:http，避开宿主可能装的全局 dispatcher/代理）。 */
function httpGetJson(port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("CDP HTTP 超时")));
    req.on("error", reject);
  });
}

/**
 * 打开一个 WebSocket：优先用 Node 22+ 的全局 WebSocket；老 Node 回退到
 * `~/.dsh/profiles/node_modules/ws`（dsh 自身的依赖，必然存在）。
 * 返回统一适配层，屏蔽两套事件 API 的差异。
 */
function openSocket(url) {
  let socket;
  if (typeof WebSocket === "function") {
    socket = new WebSocket(url);
  } else {
    const require = createRequire(join(homedir(), ".dsh", "profiles", "node_modules", "index.js"));
    const WS = require("ws");
    socket = new WS(url);
  }
  const domStyle = typeof socket.addEventListener === "function";
  return {
    on(event, handler) {
      if (domStyle) socket.addEventListener(event, (payload) => handler(event === "message" ? payload.data : payload));
      else socket.on(event, handler);
    },
    send(text) {
      socket.send(text);
    },
    close() {
      try {
        socket.close();
      } catch (error) {
        /* 关不掉就算了：下面还会 terminate 浏览器进程 */
      }
    },
  };
}

/** 把 console 参数变成一个可读字符串（值 / 对象预览 / 描述）。 */
function describeArg(arg) {
  if (arg === undefined || arg === null) return String(arg);
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  if (arg.preview !== undefined) {
    const props = (arg.preview.properties || []).map((p) => `${p.name}=${p.value ?? p.type}`).join(" ");
    return `${arg.preview.description ?? arg.preview.subtype ?? "object"} {${props}}`;
  }
  return arg.description ?? arg.type ?? "?";
}

/**
 * 跑一次页面冒烟。
 *
 * @param options.spawn 与 ctx.subprocess.spawn 同形的启动函数（依赖注入）
 * @param options.cwd   子进程工作目录（必填：0.1.5 起 spawn 校验 cwd）
 * @param options.url   已经起来的 web 实例 URL（如 http://127.0.0.1:53123/）
 * @param options.observeMs 页面观察时长，默认 15000ms
 * @param options.signal 外部取消信号
 * @param options.log   进度回调（可选）
 * @returns {{ok:boolean, browser:(string|undefined), pageErrors:string[], pageLogs:string[], notes:string[]}}
 */
export async function pageSmoke(options) {
  const { spawn, cwd, url, signal, log = () => {} } = options;
  const observeMs = Number(options.observeMs) > 0 ? Number(options.observeMs) : 15000;
  const pageErrors = [];
  const pageLogs = [];
  const notes = [];
  let evidence;

  const browser = findBrowser();
  if (browser === undefined) {
    return { ok: false, tested: false, browser: undefined, pageErrors, pageLogs, notes: ["未找到 Edge/Chrome，页面侧冒烟跳过"] };
  }

  const profileDir = mkdtempSync(join(tmpdir(), "dsh-page-smoke-"));
  const debugPort = await pickFreePort();
  const errors = pageErrors;
  const logs = pageLogs;
  let browserHandle;
  let socket;
  try {
    log("启动无头浏览器: " + browser);
    browserHandle = spawn({
      argv: [
        browser,
        "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--disable-extensions", "--mute-audio", "--disable-background-networking",
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        "about:blank",
      ],
      cwd,
      graceMs: 1500,
      stdio: { stdin: "ignore", stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
      ...(signal ? { signal } : {}),
    });

    // 1) 等浏览器把调试目标开出来
    let target;
    const targetDeadline = Date.now() + 20000;
    while (Date.now() < targetDeadline) {
      try {
        const list = await httpGetJson(debugPort, "/json/list", 2000);
        target = (list || []).find((t) => t.type === "page");
        if (target) break;
      } catch (error) {
        /* 调试端口还没起来，继续等 */
      }
      await sleep(300);
    }
    if (!target) {
      notes.push("无头浏览器未暴露调试目标（CDP /json/list 无 page）");
      return { ok: false, tested: false, browser, pageErrors, pageLogs, notes };
    }

    // 2) 连 CDP，先开域再导航，才能收到装载期抛错
    socket = openSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), 10000);
      socket.on("open", () => { clearTimeout(timer); resolve(); });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    let messageId = 0;
    const pending = new Map();
    /** 发一条需要回包的 CDP 命令（用于取值探针）。 */
    const call = (method, params) => new Promise((resolve) => {
      const id = ++messageId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) resolve(undefined);
      }, 8000);
    });
    const send = (method, params) => socket.send(JSON.stringify({ id: ++messageId, method, params }));
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(typeof data === "string" ? data : String(data));
      } catch (error) {
        return;
      }
      if (message.id !== undefined) {
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        errors.push("[exception] " + (details.exception?.description ?? details.text));
      } else if (message.method === "Runtime.consoleAPICalled" && (message.params.type === "error" || message.params.type === "warning")) {
        errors.push(`[console.${message.params.type}] ` + message.params.args.map(describeArg).join(" "));
      } else if (message.method === "Log.entryAdded") {
        const entry = message.params.entry;
        if (entry.level === "error" || entry.level === "warning") {
          logs.push(`[log.${entry.level}] ${entry.text} ${entry.url ?? ""}`.trim());
        }
      }
    });
    send("Runtime.enable");
    send("Log.enable");
    send("Page.enable");
    await sleep(300);
    log("导航到 " + url + " 并观察 " + observeMs + "ms");
    send("Page.navigate", { url });
    await sleep(observeMs);

    // 取值探针：没有它，"零错误"分不清"真没问题"还是"页面压根没渲染"。
    // 只看结构不猜业务 DOM：是否注入官方 boot 标记 + 正文是否有字 + 有多少 data-plugin 标记。
    const probe = await call("Runtime.evaluate", {
      expression: "JSON.stringify({"
        + "title: document.title,"
        + "hasBoot: typeof window.__DSH_BOOT__ === 'object' && window.__DSH_BOOT__ !== null,"
        + "bootKeys: (window.__DSH_BOOT__ && Object.keys(window.__DSH_BOOT__)) || [],"
        + "bodyText: ((document.body && document.body.innerText) || '').trim().length,"
        + "pluginMarkers: document.querySelectorAll('[data-plugin]').length"
        + "})",
      returnByValue: true,
    });
    const raw = probe && probe.result && probe.result.result && probe.result.result.value;
    if (typeof raw === "string") {
      try {
        evidence = JSON.parse(raw);
      } catch (error) {
        notes.push("渲染证据解析失败: " + raw.slice(0, 120));
      }
    } else {
      notes.push("未能取得渲染证据（Runtime.evaluate 无回包）");
    }
  } catch (error) {
    notes.push("页面冒烟异常: " + (error && error.message ? error.message : String(error)));
  } finally {
    if (socket) socket.close();
    if (browserHandle) {
      try {
        browserHandle.terminate();
        await browserHandle.waitForExit();
      } catch (error) {
        /* 杀不掉也要往下走：临时目录清理不阻塞结论 */
      }
    }
    await sleep(300);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      notes.push("临时浏览器目录未清理: " + profileDir);
    }
  }

  // 判定：无页面错误 **且**（拿到证据时）页面确实渲染出了东西——否则"零错误"可能只是白屏。
  // `tested=false` 表示浏览器/调试端口这一层就没起来（基础设施问题，不是插件问题），
  // 调用方据此按"未测"处理，不误报成插件失败。
  const rendered = evidence === undefined ? true : (evidence.bodyText > 0 || evidence.hasBoot === true);
  const tested = evidence !== undefined || pageErrors.length > 0;
  if (tested && !rendered) notes.push("页面无错误但正文为空（应用疑似没渲染）");
  return { ok: tested && rendered && pageErrors.length === 0, tested, browser, pageErrors, pageLogs, notes, evidence };
}
