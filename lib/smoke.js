/**
 * dsh-startup-check · 实跑冒烟引擎（宿主 + 页面两半）
 *
 * 这一层是"启动一个隔离 dsh web 实例并判定它是否可用"的全部算法：
 * - 宿主那一半：`dsh --profile <p> --port 0 --no-open` 启动，边跑边从 stdout 里
 *   读它打印的 `dsh web: <url>`（`--port 0` 由 OS 分配端口，URL 只能从输出拿）。
 * - 页面那一半（`page: true`）：把 URL 交给 `./page-smoke.js` 用无头 Edge + CDP 打开，
 *   收集页面侧异常（宿主进程自己不打印这些）。
 * - 收尾：`terminate()` 之后**再确认它真的退了**（`verifyShutdown`）。这一步不能省：
 *   我们起的是 `cmd.exe /c dsh …`，直接子进程是 cmd.exe、真正的实例是它的孙子，
 *   只喊一声 terminate 既不知道 cmd.exe 退出没有，更不知道那个 `node … dsh/lib/bin.js`
 *   实例退出没有。2026-09-11 实测的残留正是"父进程已死、实例还在"。
 *   进程表级的最终确认与残留清理在 `lib/instances.js`（`plugin_check` 的第 7/8 项）。
 *
 * 为什么不放在 index.js 里：`spawn` 由调用方注入（插件里是 `ctx.subprocess.spawn`，
 * `_projects/插件预检/tools/smoke.mjs` 里是 `node:child_process` 适配器），这样
 * 同一份算法既能跑在 dsh 宿主进程里，也能被工作区脚本直接复用——不留第二份实现。
 * 本文件不 import 任何 dsh 包，可被普通 node 脚本直接加载。
 */
import { pageSmoke } from "./page-smoke.js";

/** 只判宿主时给多久（ms）。 */
export const LIVE_TIMEOUT_MS = 12000;
/** 还要跑页面那一半时，给宿主启动留的预算（ms）。 */
export const PAGE_LIVE_TIMEOUT_MS = 30000;
/** 页面观察窗口默认值（ms）。 */
export const PAGE_OBSERVE_MS = 15000;
/** 收尾时等隔离实例退出的上限（ms）；超时后再喊一次 terminate 并再等 `SHUTDOWN_RETRY_MS`。 */
export const SHUTDOWN_TIMEOUT_MS = 8000;
/** 第二层收尾的观察窗（ms）。 */
export const SHUTDOWN_RETRY_MS = 2500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从采集流里按字节偏移读一段（`SubprocessOutputReader.readFrom` 契约，非消耗式）。 */
export function readCollected(handle, side, fromByte) {
  try {
    const reader = handle.collected && handle.collected[side];
    if (!reader || typeof reader.readFrom !== "function") return undefined;
    return reader.readFrom(fromByte);
  } catch (error) {
    return undefined;
  }
}

/** 读尽某个采集流的全部文本（进程结束后用）。 */
export function collectedText(handle, side) {
  const read = readCollected(handle, side, 0);
  return read ? read.text || "" : "";
}

/** 给 waitForExit 的超时信号；宿主 Node 太老没有 `AbortSignal.timeout` 时退回 undefined（外层 race 仍兜底）。 */
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  } catch (error) {
    /* 退回外层超时 */
  }
  return undefined;
}

/**
 * 收尾并**确认隔离实例真的退出了**。
 *
 * 为什么不能只调 terminate()：terminate 只是"喊一声"，契约（`SubprocessHandle`）里
 * `terminate()` 返回 void、`waitForExit()` 才是"观察到管理范围真的静止"。更关键的是：
 * 我们起的是 `cmd.exe /c dsh …`，**直接子进程是 cmd.exe，真正的实例是它的孙子**——
 * `done` 只证明 cmd.exe 没了，不证明那个 `node … dsh/lib/bin.js` 实例没了
 * （2026-09-11 实测到的残留正是"父进程已死、实例还在"这种形态）。
 * 所以这一层只给"我观察到的"事实，最终以进程表复查为准（见 `lib/instances.js`）。
 *
 * @param handle `ctx.subprocess.spawn` 返回的句柄
 * @param timeoutMs 第一层等待上限
 * @returns `{exited, ms, outcome, detail}`；`exited` 仅代表"直接子进程/管理范围已静止"
 */
export async function verifyShutdown(handle, timeoutMs) {
  const startedAt = Date.now();
  let exited = false;
  let outcome = { exitCode: null, signal: null };
  const doneObserved = Promise.resolve(handle.done).then(
    (value) => { exited = true; outcome = value ?? outcome; },
    () => { exited = true; },
  );
  const waitObserved = typeof handle.waitForExit === "function"
    ? Promise.resolve()
      .then(() => handle.waitForExit(timeoutSignal(timeoutMs)))
      .then((value) => { if (value === true) exited = true; }, () => { /* 观察失败不改变结论 */ })
    : Promise.resolve();
  await Promise.race([doneObserved, waitObserved, sleep(timeoutMs)]);
  let forcedSecond = false;
  if (!exited) {
    forcedSecond = true;
    try {
      handle.terminate();
    } catch (error) {
      /* 已经退出 */
    }
    await Promise.race([doneObserved, sleep(SHUTDOWN_RETRY_MS)]);
  }
  const ms = Date.now() - startedAt;
  return {
    exited,
    ms,
    outcome,
    detail: exited
      ? "隔离实例的直接子进程已退出（" + ms + "ms" + (forcedSecond ? "，含一次补喊 terminate" : "") + "）"
      : "隔离实例在 " + ms + "ms 内未观察到退出（terminate 已发两次）",
  };
}

/**
 * 启动隔离实例做冒烟。
 *
 * @param options.spawn  与 `ctx.subprocess.spawn` 同形的启动函数（必填，依赖注入）
 * @param options.cwd    子进程工作目录（必填：0.1.5 起 spawn 会校验 cwd）
 * @param options.profile profile 名（默认 "web"）
 * @param options.page   是否连页面那一半一起跑（默认 false）
 * @param options.observeMs 页面观察时长（默认 15000）
 * @param options.signal 外部取消信号
 * @param options.env    额外环境变量（命令行工具传 DSH_HOME 指向隔离 HOME 时用）
 * @param options.log    进度回调
 * @returns {{hostOk:boolean, hostDetail:string, hostWarnings:string[], shutdown:{exited:boolean,ms:number,detail:string}, pageOk:boolean, pageDetail:string, pageLogs?:string[]}}
 */
export async function liveSmoke(options) {
  const { spawn, cwd, signal, env } = options;
  const profile = options.profile || "web";
  const wantPage = options.page === true;
  const bootTimeoutMs = wantPage ? PAGE_LIVE_TIMEOUT_MS : LIVE_TIMEOUT_MS;
  const observeMs = Number(options.observeMs) > 0 ? Number(options.observeMs) : PAGE_OBSERVE_MS;
  const log = typeof options.log === "function" ? options.log : () => {};

  const abort = new AbortController();
  // 硬上限：宿主启动预算 +（要跑页面时）浏览器启动、观察与收尾
  const timer = setTimeout(() => abort.abort(), bootTimeoutMs + (wantPage ? observeMs + 25000 : 0));
  const onOuterAbort = () => abort.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });

  let handle;
  try {
    handle = spawn({
      argv: ["cmd.exe", "/c", "dsh", "--profile", profile, "--port", "0", "--no-open"],
      cwd,
      graceMs: 1500,
      signal: abort.signal,
      ...(env ? { env } : {}),
      stdio: { stdin: "ignore", stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
    });

    // 边跑边读 stdout 找 URL——不能等进程退出，页面那一半要用这个实例
    let stdoutOffset = 0;
    let stdout = "";
    let url;
    let exited = false;
    const deadline = Date.now() + bootTimeoutMs;
    handle.done.then(() => { exited = true; }, () => { exited = true; });
    while (Date.now() < deadline && !abort.signal.aborted) {
      const read = readCollected(handle, "stdout", stdoutOffset);
      if (read && read.text) {
        stdout += read.text;
        stdoutOffset = read.nextOffset;
        const match = /dsh web:\s*(http:\/\/\S+)/.exec(stdout);
        if (match) {
          url = match[1];
          break;
        }
      }
      if (exited) break;
      await sleep(250);
    }

    const hostOk = url !== undefined;
    let page;
    if (hostOk && wantPage) {
      page = await pageSmoke({ spawn, cwd, url, observeMs, signal: abort.signal, log });
    }

    // 收尾：先停实例，**再确认它真的退了**（terminate 只是"喊一声"，不等于已退出）
    abort.abort();
    try {
      handle.terminate();
    } catch (error) {
      /* 已经退出 */
    }
    const shutdown = { ...(await verifyShutdown(handle, SHUTDOWN_TIMEOUT_MS)), instanceUrl: url };
    const outcome = shutdown.outcome;
    await sleep(300);
    const stderr = collectedText(handle, "stderr");

    if (!hostOk) {
      return {
        hostOk: false,
        hostDetail: "未见到 'dsh web:' URL（启动疑似失败）; exit=" + outcome.exitCode
          + " " + (stderr.trim().slice(0, 800) || stdout.trim().slice(0, 400)),
        hostWarnings: [],
        shutdown,
        pageOk: false,
        pageDetail: "宿主没起来，页面侧未测",
      };
    }
    // 宿主侧告警：插件装载失败（failed to apply loader entry）、等待服务、抛错等都会落在 stderr。
    // 只做"报出来"，判定仍以能否打印 URL 为准——除非调用方按自己的严格度把它算作失败。
    const hostWarnings = stderr.split(/\r?\n/)
      .filter((line) => /error|fail|pending|waiting for service|did not activate|throw/i.test(line))
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);
    const warnSuffix = hostWarnings.length > 0
      ? " | 宿主 stderr 告警 " + hostWarnings.length + " 条: " + hostWarnings.join(" ; ").slice(0, 600)
      : "";
    const hostDetail = "隔离 dsh web 实例成功启动: " + url + warnSuffix;
    if (!wantPage) return { hostOk: true, hostDetail, hostWarnings, shutdown };

    if (page === undefined) {
      return { hostOk: true, hostDetail, hostWarnings, shutdown, pageOk: false, pageDetail: "页面侧未执行" };
    }
    const shown = (page.pageErrors || []).slice(0, 8);
    const proof = page.evidence
      ? `；渲染证据: 正文 ${page.evidence.bodyText} 字 / data-plugin 标记 ${page.evidence.pluginMarkers} 个 / boot ${page.evidence.hasBoot ? "有" : "无"}`
      : "";
    if (page.tested === false) {
      // 浏览器/调试端口没起来属基础设施问题：按"未测"处理，不误报成插件失败。
      return {
        hostOk: true,
        hostDetail,
        hostWarnings,
        shutdown,
        pageOk: true,
        pageTested: false,
        pageDetail: "页面侧未能执行（" + (page.notes.join("；") || "无原因") + "）——按未测处理，未计入失败",
      };
    }
    const pageDetail = page.pageErrors.length === 0
      ? "页面加载无异常（浏览器: " + (page.browser || "?") + "；观察 " + observeMs + "ms" + proof + "）"
      : page.pageErrors.length + " 条页面侧错误: " + shown.join(" | ")
        + (page.pageErrors.length > shown.length ? " …" : "");
    return {
      hostOk: true,
      hostDetail,
      hostWarnings,
      shutdown,
      pageOk: page.ok,
      pageTested: true,
      pageDetail: pageDetail + (page.notes.length > 0 ? "（" + page.notes.join("；") + "）" : ""),
      pageLogs: (page.pageLogs || []).slice(0, 5),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
    if (handle) {
      try {
        handle.terminate();
      } catch (error) {
        /* 已经退出 */
      }
    }
  }
}
