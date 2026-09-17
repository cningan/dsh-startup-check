/**
 * dsh-startup-check · DSH 实例审计（残留进程：可查、可确认、可精确清理）
 *
 * 为什么需要这一层（2026-09-11 实测根因）：
 * - 隔离冒烟会真起一个 `dsh --profile web --port 0 --no-open` 进程。它只要没退干净，
 *   就会一直活着。而在 Windows 上，会话的写租约是一枚**具名内核信号量**
 *   （`dsh-session-persistence-jsonl` 的 lease：POSIX 用 flock(2)、Windows 用内核信号量，
 *   句柄一关就释放、进程一死就释放，**故意没有过期时间**）。也就是说：一个活着的残留
 *   实例会把"新会话 resume"永久挡在 `SessionAlreadyOwnedError` 之外，直到那个进程退出。
 * - 所以"起实例 → 判能否启动 → 关实例"必须闭环，而且"关掉了"这件事必须能被**证实**：
 *   `terminate()` 只是"喊一声"，不等于"已经退出"（见 `lib/smoke.js` 的 verifyShutdown）。
 *
 * 本模块只做两件事：
 *   listDshInstances()  只读审计：按**进程身份**（node.exe，且第一个参数就是
 *                       `@deepseek-ai/dsh/lib/bin.js`）找出 DSH 进程并分类；
 *   killPid()           精确清理：只按 pid 调 `taskkill /PID <pid> /T /F`，
 *                       只用于 `--port 0` 的隔离冒烟实例 —— GUI 宿主永不自动清。
 *
 * 纪律（血的教训）：分类只认"进程身份 + 应用参数"，**不认"命令行里出现过 dsh 字样"**。
 * 2026-09-11 实测：一条 `-match 'dsh|deepseek|harness'` 的手写清理脚本，因为工作区路径
 * 里带 `DSH-plugin`，把无关的 4 个 Codex 进程一起杀了。
 */
import { collectedText } from "./smoke.js";

/** DSH 本体：node 的第一个参数就是这个入口文件。 */
const DSH_BIN = /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i;
/** `--port 0`（接受 `--port 0` / `--port=0`）：隔离冒烟实例的唯一标记。 */
const PORT_ZERO = /(^|\s)--port[=\s]+"?0"?(?=\s|$)/;
/** 显式端口值（取端口用）。 */
const PORT_ANY = /(^|\s)--port[=\s]+"?(\d+)"?/;
/** 一次性调用（不驻留、不占会话租约）：配置树组装 / 帮助 / pnpm 转发。 */
const TRANSIENT = /(^|\s)(--dump-config|--dump-default-config|--help|-h)(\s|$)|^plugin(\s|$)/;

/**
 * "残留"的判据：隔离冒烟实例的合法寿命是几十秒（12s / 30s 预算 + 收尾），
 * 活过 5 分钟不可能是"正在跑的冒烟"，只能是没人收的残留。
 * 只清这个年龄以上的实例，是为了绝不误杀**别的会话正在进行的**冒烟。
 */
export const STALE_SMOKE_SECONDS = 300;

/**
 * 拆一条 Windows 命令行：镜像 → 第一个参数 → 其余。
 * @param commandLine - WMI 给的原始命令行（可能带引号、可能为 null）
 * @returns `{image, firstArg, tail}`，无法解析时 undefined
 */
function parseInvocation(commandLine) {
  if (typeof commandLine !== "string" || commandLine.trim().length === 0) return undefined;
  const head = /^\s*("([^"]*)"|(\S+))/.exec(commandLine);
  if (!head) return undefined;
  const image = head[2] ?? head[3] ?? "";
  const afterImage = commandLine.slice(head[0].length);
  const arg = /^\s*("([^"]*)"|(\S+))/.exec(afterImage);
  const firstArg = arg ? (arg[2] ?? arg[3] ?? "") : "";
  const tail = arg ? afterImage.slice(arg[0].length) : "";
  return { image, firstArg, tail };
}

/**
 * 给一条命令行分类。**只有 DSH 本体才算**，别的进程一律不计。
 *
 * 分类刻意偏"保守"：不是隔离冒烟、也不是一次性调用的，一律算 `host`（驻留实例，
 * 可能是用户正在用的 GUI 宿主）。宿主永远不会被自动清理，所以宁可多认成宿主。
 *
 * @returns `"smoke"`（隔离冒烟实例，唯一可被清理的一类）/ `"host"`（驻留实例）/
 *          `"other"`（`--dump-config`、`--help`、`plugin …` 这类一次性调用）/ undefined（不是 DSH）
 */
export function classifyCommandLine(commandLine) {
  const parsed = parseInvocation(commandLine);
  if (parsed === undefined) return undefined;
  if (!DSH_BIN.test(parsed.firstArg)) return undefined;
  const tail = parsed.tail.replace(/\s+/g, " ").trim();
  if (PORT_ZERO.test(tail)) return "smoke";
  if (TRANSIENT.test(tail)) return "other";
  return "host";
}

/** 从命令行里取显式端口（无则 undefined）。 */
export function commandLinePort(commandLine) {
  const parsed = parseInvocation(commandLine);
  if (parsed === undefined) return undefined;
  const match = PORT_ANY.exec(parsed.tail);
  return match ? Number(match[2]) : undefined;
}

/**
 * PowerShell 审计脚本：只列 node.exe，结构化输出。
 * - 只用 cmdlet（`Get-CimInstance` / `Where-Object` / `Select-Object` / `ConvertTo-Json`），
 *   兼容受限语言模式（ConstrainedLanguage）下的只读运行。
 * - 年龄在 PowerShell 里就算成整数秒，省得在 JS 里解析各版本 WMI 的日期格式。
 */
const PS_SCRIPT = "$ErrorActionPreference='SilentlyContinue';$now=Get-Date;"
  + "Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' } | "
  + "Select-Object ProcessId,ParentProcessId,@{n='AgeSeconds';e={[int]($now-$_.CreationDate).TotalSeconds}},CommandLine | "
  + "ConvertTo-Json -Compress -Depth 3";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 用注入的 spawn 跑一条命令并读尽它的 stdout/stderr（进程退出后）。
 * @returns `{exitCode, stdout, stderr}`
 */
async function runCommand(spawn, cwd, argv, signal) {
  const handle = spawn({
    argv,
    cwd,
    graceMs: 1500,
    ...(signal ? { signal } : {}),
    stdio: { stdin: "ignore", stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 32 * 1024 } },
  });
  const outcome = await handle.done.catch(() => ({ exitCode: null }));
  return {
    exitCode: outcome.exitCode,
    stdout: collectedText(handle, "stdout"),
    stderr: collectedText(handle, "stderr"),
  };
}

/**
 * 只读审计：列出本机正在跑的 DSH 进程并分类。
 *
 * @param options.spawn 与 `ctx.subprocess.spawn` 同形的启动函数（依赖注入）
 * @param options.cwd   子进程工作目录（必填，0.1.5 起 spawn 校验 cwd）
 * @param options.signal 外部取消信号
 * @returns `{ok, platform, items, detail}`；`ok:false` 表示**没测成**（不是"没有残留"）
 */
export async function listDshInstances(options) {
  const { spawn, cwd, signal } = options;
  if (process.platform !== "win32") {
    return {
      ok: false,
      platform: process.platform,
      items: [],
      detail: "实例审计目前只实现了 Windows（WMI + PowerShell）；本平台按未测处理",
    };
  }
  let run;
  try {
    run = await runCommand(spawn, cwd, ["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], signal);
  } catch (error) {
    return { ok: false, platform: process.platform, items: [], detail: "实例审计未测成：" + (error?.message ?? error) };
  }
  const text = run.stdout.trim();
  if (run.exitCode !== 0 || text.length === 0) {
    return {
      ok: false,
      platform: process.platform,
      items: [],
      detail: "实例审计未测成：powershell 退出码 " + run.exitCode + " " + (run.stderr.trim().slice(0, 200) || "（无输出）"),
    };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, platform: process.platform, items: [], detail: "实例审计未测成：进程列表不是合法 JSON" };
  }
  const rows = Array.isArray(raw) ? raw : [raw];
  const items = [];
  for (const row of rows) {
    const commandLine = typeof row?.CommandLine === "string" ? row.CommandLine : "";
    const kind = classifyCommandLine(commandLine);
    if (kind === undefined) continue;
    items.push({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      ageSeconds: Number.isFinite(Number(row.AgeSeconds)) ? Number(row.AgeSeconds) : undefined,
      kind,
      port: commandLinePort(commandLine),
      commandLine: commandLine.replace(/\s+/g, " ").slice(0, 300),
    });
  }
  const smoke = items.filter((i) => i.kind === "smoke");
  const hosts = items.filter((i) => i.kind === "host");
  const others = items.filter((i) => i.kind === "other");
  return {
    ok: true,
    platform: process.platform,
    items,
    detail: "DSH 进程 " + items.length + " 个（隔离冒烟 " + smoke.length + " / 驻留实例 " + hosts.length + " / 一次性 " + others.length + "）",
  };
}

/**
 * 精确清理：按 pid 杀一棵进程树（`taskkill /PID <pid> /T /F`），并回读进程表确认它真的没了。
 *
 * **只用于 `--port 0` 的隔离冒烟实例**：调用方负责保证 pid 来自 `listDshInstances`
 * 且 `kind === "smoke"`。不按命令行宽匹配、不碰 web 宿主。
 *
 * @returns `{pid, killed, detail}`
 */
export async function killPid(options) {
  const { spawn, cwd, pid, signal } = options;
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0 || id === process.pid) {
    return { pid: id, killed: false, detail: "拒绝清理: pid 非法或是当前进程 (" + pid + ")" };
  }
  try {
    const run = await runCommand(spawn, cwd, ["taskkill", "/PID", String(id), "/T", "/F"], signal);
    const text = (run.stderr + run.stdout).trim().replace(/\s+/g, " ").slice(0, 200);
    await sleep(300);
    const after = await listDshInstances({ spawn, cwd, signal });
    if (!after.ok) return { pid: id, killed: false, detail: "已执行 taskkill(" + text + ")，但复查未测成：" + after.detail };
    const still = after.items.some((i) => i.pid === id);
    return {
      pid: id,
      killed: !still,
      detail: still
        ? "taskkill 后 PID " + id + " 仍在（" + text + "）"
        : "PID " + id + " 已退出" + (text ? "（taskkill: " + text + "）" : ""),
    };
  } catch (error) {
    return { pid: id, killed: false, detail: "清理 PID " + id + " 抛错：" + (error?.message ?? error) };
  }
}
