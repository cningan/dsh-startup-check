# 架构

**简体中文** · [English](architecture.md)

## 概述

`dsh-startup-check` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/dsh)（dsh）插件，把"插件装坏"这个
问题的发现时机**提前到重启之前**。它注册一个面向模型的工具 `plugin_check`：AI 在安装、修补或改动某个 `@local`
插件之后调用它，**在 dsh 重启之前**体检 Web profile 的插件树，于是"一重启就打不开"的问题在还能就地修的时候
就被报出来。

它消除的正是这条很短的回路：装插件 → 插件有问题 → 重启才发现打不开 → 手动禁用插件直到能开。`plugin_check`
把同样这几个问题提前问一遍：每个 `lib/*.js` 能不能解析、每个 `package.json` 自不自洽、`cordis.patch.yml`
引用的每个 `@local/*` 在磁盘上是否存在、组装出来的配置树能不能成型、真起的隔离实例能不能打印出它的
`dsh web:` URL、它服务的页面有没有客户端报错、以及**它起的那个实例到底退没退**。

此外本插件还内嵌一个配套技能 `plugin-fault-diagnosis`，内容是"`plugin_check` 返回 `ok:false` 之后该怎么办"。

### 它不做什么

- **它不是重启机制**：不重启、不重载、不改动正在跑的 profile；它只读它，并另起**隔离**实例。在跑的 dsh 只会
  服务它启动时载入的那份代码——见「进程模型与安全」。
- **它不是热载通道**：本插件是宿主侧静态插件，改代码要**重启 dsh** 才生效。
- **它不是常驻健康监控**：只有工具被调用时才动作，没有后台定时器、监听或轮询。
- **它今天不是跨平台的**：语法/结构/引用三项可移植，但实例审计（`lib/instances.js`）只实现了 Windows，
  页面那一半探测的也是 Windows 浏览器安装路径。
- **它不写被检查的 profile**：所有针对被检查 profile 的文件操作都是读。它唯一的自建物是 `%TEMP%` 下一次性
  浏览器 profile 目录和若干短命子进程。
- **它的检查名与明细是中文串**：`plugin_check` 的输出（检查项的 `name`/`detail`、以及工具描述）是中文；
  只有本文档与 README 是英文。

## 运行形态

本包是**只有宿主半边**的 Cordis 插件。`package.json` 声明
`exports["."].default = ./lib/index.js` 与 `main: ./lib/index.js`，没有 `dsh.client` 字段，因此不存在客户端
半边、浏览器产物、Slot 或主题相关代码。它唯一声明的 `dsh` 字段是
`dsh.bundle.patch = ./cordis.patch.yml`：`dsh plugin add` 正是靠它发现这个 bundle、把包追加进
`dsh.profile.bundles`，加载器随后按 `name: 'dsh-startup-check'` 在所有 bundle 层之后挂载本插件。

- **身份与注入**：`lib/index.js` 导出 `name = "startup-check"`（`lib/index.js:10`）与
  `inject = ["tools", "subprocess", "fs", "skills"]`（`lib/index.js:11`）。四项都是硬依赖：Cordis 提供齐
  之前插件处于等待状态，齐了之后才以已声明的 `ctx` 属性访问。
- **`apply(ctx)`**（`lib/index.js:128`）只做两件事，都归属当前 Host Fiber：
  1. `ctx.skills.registerProvider(() => faultDiagnosisSkillProvider)`（`lib/index.js:129`）发布内嵌技能；
  2. `ctx.tools.register(defineTool({ … }))`（`lib/index.js:130`）注册 `plugin_check`。
- **工具注册**：`defineTool` 来自 `@deepseek-ai/dsh-tools`（`lib/index.js:1`，使用于 `lib/index.js:130`）。
  工具声明五个可选参数 `target` / `live` / `page` / `sweep` / `killStray`（`lib/index.js:149-170`）、一个
  JSON 输出模式（渲染就是把值 `JSON.stringify`，`lib/index.js:171-176`）以及一个
  `execute(args, exec)`（`lib/index.js:177-426`），返回 `{ ok, checks }`。
- **`exec.signal`** 从工具调用一路透传到每个子进程，使取消的调用能带走它的子进程（`lib/index.js:178`，
  以及在 `lib/index.js:257`、`:277`、`:291`、`:295`、`:310` 的传递）。
- **内嵌技能 Provider**：`SKILL_PROVIDER_NAME = "dsh-startup-check"`（`lib/index.js:90`）是 *Provider* 名，
  技能本身叫 `plugin-fault-diagnosis`（`lib/index.js:97`）。Provider 暴露 `list()` 与 `get()`
  （`lib/index.js:113-125`），`get()` 从 `assets/plugin-fault-diagnosis.md` 读正文（`lib/index.js:91`、
  `:123`）。候选声明为 `source: "bundled"`（`lib/index.js:105`）、`rank: BUNDLED_SKILL_RANK`
  （`lib/index.js:107`，常量来自 `@deepseek-ai/dsh-skill`，`lib/index.js:2`）。形态刻意照官方内嵌包
  `@deepseek-ai/dsh-skill-badge`。

**为什么技能要内嵌，而不是放进用户技能根。** 这个技能只有在本插件（即拥有该工具的一方）启用时才有意义；
放进包内，两者同生同灭，不会出现"插件已停用、说明书还在"的错位。若日后在用户技能根放一个同名技能，磁盘
那份仍会覆盖内嵌这份——技能分层按 rank 就近合并、数字小者胜：内嵌这份的 rank 是 `BUNDLED_SKILL_RANK`（600），
磁盘技能 rank 更小。

**为什么引擎拆在 `lib/` 三个文件里。** `lib/smoke.js` 与 `lib/instances.js` 刻意**不 import 任何 dsh 包**：
`spawn` 由调用方注入，于是同一份算法既能跑在 dsh 宿主进程里（传 `ctx.subprocess.spawn`），也能被普通 Node
脚本直接加载（传 `node:child_process` 适配器）。冒烟引擎与实例审计各自**只有一份实现**，插件是它们的
*消费者*而不是第二份拷贝。`lib/page-smoke.js` 是唯一直接使用 Node 内建的文件（`WebSocket`、`node:http`、
`node:net`、`mkdtempSync`/`rmSync`），这是登记在其头注释里的技术债：`ctx.fs` 与 `ctx.subprocess` 都没有
"建临时目录"或 WebSocket 原语。若日后 dsh 提供正规机制，该文件应迁回 `ctx.*`。

## 对象地图

| 对象 | 职责 | 代码位置 | 状态 |
|---|---|---|---|
| `name` / `inject` | 插件名 `startup-check`；要求 `tools`、`subprocess`、`fs`、`skills` | `lib/index.js:10-11` | 运行时注入 |
| `PROFILE` / `PROFILE_DIR` / `PLUGINS_DIR` / `PATCH_FILE` | 固定 web profile 及其 `plugins/`、`cordis.patch.yml` | `lib/index.js:13-16` | 静态路径配置 |
| `run(ctx, argv, …)` | 执行命令并收集退出码/stdout/stderr（`spawn` 显式带 `cwd`） | `lib/index.js:26-40` | 每次检查临时状态 |
| `readFileText` / `listDirNames` / `fsPath` | 经 `ctx.fs` 读文本、列目录、解析进程路径 | `lib/index.js:51-78` | 每次检查临时状态；曾被重构误删后补回——见「回归与测试」第 3 层 |
| `SKILL_PROVIDER_NAME` / `SKILL_CANDIDATE` / `faultDiagnosisSkillProvider` | 内嵌技能 `plugin-fault-diagnosis` 的 Provider（`source:"bundled"`、`rank: BUNDLED_SKILL_RANK`、正文读 `assets/plugin-fault-diagnosis.md`） | `lib/index.js:90-126` | `apply` 时注册到 `ctx.skills`；归属当前 Host Fiber |
| `plugin_check` 工具 | 组织静态检查 + 实例关闭确认 + 残留实例审计，返回 `{ ok, checks }` | `lib/index.js:131-427` | 已注册；不写被检查的 profile |
| `target` / `live` / `page` / `sweep` / `killStray` 参数 | 只查一个插件 / 起隔离实例 / 连页面一起跑（`page` 隐含 `live`）/ 只做实例审计 / 审计时精确清理隔离残留 | `lib/index.js:150-169`、`:179-183`、`:303-423` | 每次调用输入 |
| `LIVE_TIMEOUT_MS` / `PAGE_LIVE_TIMEOUT_MS` / `PAGE_OBSERVE_MS` | 宿主启动预算 12s / 带页面时 30s / 页面观察窗 15s | `lib/smoke.js:23-27` | 静态常量 |
| `SHUTDOWN_TIMEOUT_MS` / `SHUTDOWN_RETRY_MS` | 收尾等实例退出的上限 8s / 第二层观察窗 2.5s | `lib/smoke.js:29-31` | 静态常量 |
| `readCollected` / `collectedText` | 按字节偏移读采集输出（`SubprocessOutputReader` 契约，非消耗式） | `lib/smoke.js:36-50` | 复用工具函数 |
| `verifyShutdown(handle, timeoutMs)` | 收尾并**确认**实例退出：`done` + `waitForExit(signal)` + 有界等待，未退则补喊一次 terminate 再观察；返回 `{ exited, ms, outcome, detail }` | `lib/smoke.js:76-109` | 每次冒烟收尾；只证明**直接子进程/管理范围**静止，最终以进程表为准 |
| `liveSmoke(options)` | 起隔离实例、**边跑边读** `dsh web: <url>`、按需把 URL 交给页面半边、收尾并确认退出（结果里带 `shutdown`，其中含 `instanceUrl`） | `lib/smoke.js:124-257` | 仅 `live`/`page` 时执行；临时进程 |
| `STALE_SMOKE_SECONDS` | "残留"判据：隔离冒烟合法寿命只有几十秒，活过 300s 只能是没人收的残留（只清这个年龄以上的，避免误杀别的会话正在跑的冒烟） | `lib/instances.js:39` | 静态常量 |
| `parseInvocation` / `classifyCommandLine` / `commandLinePort` | 拆 Windows 命令行 → 按**进程身份**（`node.exe` + 首参 `@deepseek-ai/dsh/lib/bin.js`）分类成 `smoke` / `host` / `other` | `lib/instances.js:46-83` | 纯函数；负控见「回归与测试」 |
| `listDshInstances(options)` | 只读审计：跑 PowerShell CIM 列出全部 `node.exe` 再分类（年龄在 PS 里算成整数秒）；非 Windows 或查询失败 → `ok:false`（"未测"而非"没有残留"） | `lib/instances.js:126-181` | 每次 live/sweep 调用 2–3 次 |
| `killPid(options)` | 精确清理：按 pid `taskkill /PID <pid> /T /F` 并复查进程表确认已退出；拒绝非法 pid 与当前进程 | `lib/instances.js:191-214` | 仅 `killStray:true` 时对 `smoke` 类使用 |
| `findBrowser()` | 找 Edge/Chrome 可执行文件（Edge 优先），找不到返回 undefined | `lib/page-smoke.js:37-46` | 纯函数 |
| `pickFreePort` / `httpGetJson` / `openSocket` | 取空闲 CDP 端口（`node:net`）、读 `/json/list`（`node:http`）、开 WebSocket（全局 `WebSocket`，老 Node 回落 `ws`） | `lib/page-smoke.js:51-114` | 每次冒烟临时资源 |
| `pageSmoke(options)` | 无头 Edge + CDP：开会话、导航、收 `Runtime.exceptionThrown` / console / log 错误、取渲染证据、清理临时目录；返回 `tested`（浏览器这一层有没有真的跑起来） | `lib/page-smoke.js:138-295` | 仅 `page:true` 时执行 |
| 渲染证据（`evidence`） | `{ title, hasBoot, bootKeys, bodyText, pluginMarkers }`，用于区分"零错误"与"白屏" | `lib/page-smoke.js:248-267`，消费于 `lib/smoke.js:217-219` 与 `lib/page-smoke.js:291-294` | 每次冒烟临时值 |

## 检查流水线

下面的编号与工具描述和源码注释一致。第 1–4 项总会执行；第 5、6 项需要 `live:true` 与 `page:true`；第 7 项跟着
`live`；第 8 项在 `live` 或 `sweep` 时执行。

**1. 语法检查——所有 `@local` 插件的 `lib/*.js`。**
遍历 `PLUGINS_DIR` 下每个插件目录，把 `lib/` 里每个 `*.js` 经 `ctx.fs` 解析后送 `node --check <path>`
（`lib/index.js:247-261`）。宿主与客户端源码都会被查到，因为它们都是 `lib/` 下的 `.js`。失败项拼接成一条
`语法检查` 检查并整体判失败（`lib/index.js:263-268`）。`target` 可把循环收窄到单个插件名（`lib/index.js:213`）。

**2. `package.json` 结构——所有 `@local` 插件。**
逐个读取并解析清单（`lib/index.js:215-226`）：清单缺失是失败，JSON 不合法也是失败。随后
（`lib/index.js:227-246`）：
- `pkg.name` 必须是带 `@local/` 前缀的字符串；
- `pkg.main`（默认 `lib/index.js`）必须指向存在的文件；
- 若声明了 `pkg.dsh.client`，则 `pkg.exports["./client"]` 必须存在，且它指向的文件（取 `default`，或整个
  spec）必须能解析。

语法与结构分成两条检查（`语法检查`、`package.json 结构`）报出，避免一个坏插件把两类失败混在一起。

**3. 引用存在性——`cordis.patch.yml`。**
读 `PATCH_FILE`，读不到直接判失败（`lib/index.js:188-191`）。否则用正则收集并去重全部
`name: '@local/…'`（`lib/index.js:193-194`），每个引用必须在 `plugins/` 下有同名真实目录
（`lib/index.js:197-198`）。插件实体以 `profiles/web/plugins` 为准，**刻意不查**可选的
`node_modules/@local` junction：loader 从插件目录解析 `@local/*`，部分插件没有 junction 也能加载。

**4. 配置树组装。**
在 `PROFILE_DIR` 下执行 `cmd.exe /c dsh --profile web --dump-config`，stdout 上限 256 KiB
（`lib/index.js:277`）。退出码非 0 即失败，附最多 800 字符的 stderr 或 stdout（`lib/index.js:278-280`）；
成功则报出非空输出行数（`lib/index.js:282-283`）。

**5. 实跑冒烟（`live:true`）。**
起实例之前先读一次进程表建立基线（`lib/index.js:304`，`auditInstances` 见 `lib/index.js:291`）。随后
`liveSmoke` 启动 `cmd.exe /c dsh --profile web --port 0 --no-open`（`lib/smoke.js:141`），宿主预算 12s，
要跑页面时 30s（`lib/smoke.js:128`、`:134`）。因为 `--port 0` 由 OS 分配端口，URL 只能从子进程自己的输出
里拿，所以引擎**在进程还活着时**轮询已采集的 stdout，对累积文本匹配 `/dsh web:\s*(http:\/\/\S+)/`
（`lib/smoke.js:150-169`）；匹配到 URL 即判通过（`lib/smoke.js:171`）。stderr 中命中
`error|fail|pending|waiting for service|did not activate|throw` 的行会被收集为告警并写进 detail，但**不**
单独判失败——通过判据是实例能打印出 URL（`lib/smoke.js:200-210`）。失败时 detail 带退出码与 stderr/stdout
摘录（`lib/smoke.js:189-199`）。

**6. 页面冒烟（`page:true`，隐含第 5 项）。**
把第 5 项拿到的 URL 交给 `pageSmoke`：先找浏览器（`findBrowser`，Edge 优先于 Chrome，
`lib/page-smoke.js:29-46`），在 `%TEMP%` 下建一次性浏览器 profile（`lib/page-smoke.js:151`），取一个空闲
CDP 端口（`lib/page-smoke.js:152`），以 `--headless=new --remote-debugging-port=<port> --user-data-dir=<temp>`
启动无头 Edge/Chrome（`lib/page-smoke.js:159-172`）。它最多等 20s 直到 `/json/list` 冒出调试目标
（`lib/page-smoke.js:175-190`），连上 CDP WebSocket（`lib/page-smoke.js:193-198`），并且**关键地：先开域
再导航**（`Runtime.enable`、`Log.enable`、`Page.enable`，然后 `Page.navigate`，`lib/page-smoke.js:238-244`），
这样装载期抛的错才真能收到：
- `Runtime.exceptionThrown` → 收成 `[exception] …`；
- `Runtime.consoleAPICalled` 且 type 为 `error`/`warning` → 收成 `[console.error] …` / `[console.warning] …`；
- `Log.entryAdded` 且 level 为 `error`/`warning` → 收成 `[log.…] …`。

`failed to apply loader entry …` 这类纯客户端故障就在这里现形——宿主进程自己不打印它们。观察窗（默认 15s，
`lib/page-smoke.js:140`、`:244`）之后用一次取值探针拿渲染证据（`lib/page-smoke.js:248-267`）。判定要求
**无页面错误且（拿到证据时）确实渲染**：`rendered` 为 `bodyText > 0 || hasBoot === true`，零错误但白屏照样
判失败（`lib/page-smoke.js:291-294`）。**"未测"与"失败"严格分开**：找不到浏览器、调试目标没出现、socket
连不上时结果带 `tested:false`，`liveSmoke` 报成 `pageOk:true, pageTested:false` 并写明原因，不计入插件失败
（`lib/smoke.js:220-231`）。`finally` 里关 socket、terminate 浏览器并等它退出、`rmSync` 临时 profile
（`lib/page-smoke.js:270-286`）。

**7. 关闭确认（跟着 `live` 自动做）。**
冒烟之后再读一次进程表（`lib/index.js:328`）。审计由 `listDshInstances` 执行一条 PowerShell CIM 查询：
`Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'node.exe' } | Select-Object ProcessId,
ParentProcessId,@{n='AgeSeconds';e={[int]($now-$_.CreationDate).TotalSeconds}},CommandLine | ConvertTo-Json
-Compress -Depth 3`（`lib/instances.js:91-94`），行由 `classifyCommandLine` 分类（`lib/instances.js:67-75`）。
实例被拆成"本次起的"（现在有、基线里没有）与"既有的"（基线里就有）——基线是把 pid 归因到本次运行的唯一
证据（`lib/index.js:329-336`）。分支：
- 进程表读不到 → 报 `ok:true` 的"未测"，附引擎侧观察；
- 没有基线 → "未测"，只有当确实存在隔离实例时才失败（分不清是谁的）；
- 有基线且无新增 → 通过，附引擎侧 `shutdown.detail`；
- 有基线但本次起的仍在跑 → **失败**，列出 pid 与存活时长，并写明后果：活着的实例会占住会话写租约，
  新会话 resume 会报 `SessionAlreadyOwnedError`（`lib/index.js:380-390`）。

**8. 残留实例审计（`sweep:true`，或跟着 `live` 一起看）。**
在 `live || sweep` 时执行（`lib/index.js:327`）。它不出实例，只读进程表并报出隔离冒烟实例、驻留 web 宿主
（已知端口的带上端口）与一次性调用的数量。默认只报不杀；`killStray:true` 时只清两组
（`lib/index.js:341-356`）：
1. 本次泄漏的——能归因，因为它们出现在基线之后；
2. 存活超过 `STALE_SMOKE_SECONDS`（300s）的既有实例——合法冒烟只有几十秒寿命。

存活不足阈值的既有实例可能正被别的会话使用，只报不杀；web 宿主永远不碰。杀完再读第三次进程表确认 pid 已
消失，凡复查未成功的清理都标注"结果未证实"（`lib/index.js:348-354`、`:397-401`）。

## 进程模型与安全

**实例怎么起。** 隔离实例一律以 `cmd.exe /c dsh --profile web --port 0 --no-open` 启动
（`lib/smoke.js:141`），与配置检查用的 `cmd.exe /c` 形态相同（`lib/index.js:277`）。`--port 0` 让 OS 分配
空闲端口，这正是冒烟不占用在跑 GUI 端口的原因；`--no-open` 阻止它自己开浏览器。一个硬定时器在"宿主预算 +
（跑页面时的）观察窗与浏览器收尾"处中止整个冒烟，外部 `exec.signal` 也以 abort 监听的形式透传，使取消的调用
能带走子进程（`lib/smoke.js:132-136`）。`liveSmoke` 不传 `env`，实例继承宿主的 `~/.dsh`。

**为什么关闭必须用进程表证实。** `terminate()` 只是"喊一声"：在 `SubprocessHandle` 契约里它返回 `void`，
真正"观察到管理范围静止"的是 `waitForExit()`。更要紧的是，我们起的是 `cmd.exe`，**真正的实例是它的孙子**
——`handle.done` 只证明 `cmd.exe` 没了，不证明 `node … dsh/lib/bin.js --port 0` 没了；实测到的残留形态正是
"父进程已死、实例还在"。所以 `verifyShutdown` 只给**引擎侧**的观察（`{exited, ms, outcome, detail}`，
`lib/smoke.js:76-109`），权威结论来自第 7 项那组"起之前/跑完之后"的进程表对照。后果是具体的：Windows 上
会话写租约是一枚**具名内核信号量**，只在持有进程退出时释放，且**故意没有过期时间**——一个活着的残留实例会
一直把新会话 resume 挡在 `SessionAlreadyOwnedError` 之外。

**`killStray` 被允许杀什么。** 只杀分类为 `smoke` 的实例：`node.exe` 且首参是
`@deepseek-ai/dsh/lib/bin.js`、参数里带 `--port 0`（`lib/instances.js:26-28`、`:72`），且只限于第 8 项那两组。
杀进程走 `killPid`：先校验 pid（拒绝非整数、非正数与当前进程），执行 `taskkill /PID <pid> /T /F`
（`lib/instances.js:191-214`），再读一次进程表确认该 pid 已消失——因此"已清理"意味着"已证实消失"，无法证实的
会照实报出。驻留 web 宿主与 `other` 类一次性调用，任何代码路径都不会杀。

**为什么分类只认进程身份，绝不按"命令行里出现 dsh 字样"。** 曾有一条手写清理脚本用
`-match 'dsh|deepseek|harness'` 匹配，因为某条路径里带 `dsh`，把 4 个无关进程一起杀了。因此对命令行
做子串匹配一律视为不安全。`classifyCommandLine` 要求解析出的**第一个参数**匹配
`/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i`（`lib/instances.js:26`、`:70`）；不匹配的一律不是 DSH 进程
——包括 pwsh 诊断脚本、以及只是"提到 dsh"的 `node -e` 单行。分类还刻意偏保守：在真正的 DSH 进程里，既不是
隔离冒烟（`--port 0`）、也不是已登记的一次性调用（`--dump-config`、`--dump-default-config`、`--help`、`-h`，
或 `plugin …`/`plugin` 命令，`lib/instances.js:32`）的，一律算 `host`——驻留实例，可能是用户正开着的窗口。
多认成宿主是安全的，因为宿主永不自动清理。

## 外部关联

| 关联 | 作用 | 证据 |
|---|---|---|
| `@deepseek-ai/dsh-tools` 的 `defineTool` | 定义 `plugin_check` 契约 | `lib/index.js:1`，使用于 `lib/index.js:130` |
| `@deepseek-ai/dsh-skill` 的 `BUNDLED_SKILL_RANK` | 内嵌技能的层内 rank（600） | `lib/index.js:2`，使用于 `lib/index.js:107` |
| `skills` 服务（`ctx.skills.registerProvider`） | 发布内嵌技能 `plugin-fault-diagnosis` | `lib/index.js:11`、`:129` |
| `subprocess` 服务（`ctx.subprocess.spawn`） | 跑 `node --check`、`dsh --dump-config`、隔离实例、PowerShell 审计、`taskkill`、无头浏览器 | 注入 `lib/index.js:11`；使用 `lib/index.js:27`、`:290`；`lib/smoke.js:140`；`lib/instances.js:103`；`lib/page-smoke.js:159` |
| `fs` 服务（`ctx.fs.resolve` / `readText` / `listDir`） | 读 patch/清单、列 `plugins/` 与 `lib/`、解析进程路径 | 注入 `lib/index.js:11`；使用 `lib/index.js:53-54`、`:63-64`、`:74` |
| `node` / `dsh` 命令 | 语法检查 / 配置树组装 / 起隔离实例 | `lib/index.js:257`、`:277`；`lib/smoke.js:141` |
| `powershell` + WMI（`Get-CimInstance Win32_Process`） | 实例审计：列 `node.exe` 与命令行，年龄在 PS 内算成整数秒 | `lib/instances.js:91-94`，调用点 `lib/instances.js:138` |
| `taskkill /PID <pid> /T /F` | 精确清理隔离冒烟残留（仅 `killStray:true`，仅 `smoke` 类） | `lib/instances.js:198` |
| `dsh-session-persistence-jsonl` 的写租约 | 为什么"活着的残留实例"会挡住新会话：Windows 上租约是**具名内核信号量**、只在持有进程退出时释放、故意没有过期时间 ⇒ `SessionAlreadyOwnedError` | 官方包实现（诊断依据，非代码依赖） |
| Web profile `cordis.patch.yml` | 被动读取，核对 `@local` 引用实体是否存在 | `lib/index.js:16`，读取于 `lib/index.js:188`，匹配于 `:193-198` |
| 无头 Edge/Chrome + CDP | 页面侧错误与渲染证据 | `lib/page-smoke.js`（`--headless=new --remote-debugging-port`，`lib/page-smoke.js:160-167`） |
| `node:fs` 的 `mkdtempSync` / `rmSync`、`node:http`、`node:net`、全局 `WebSocket`（回落 `ws`） | CDP 传输与一次性浏览器 profile（已登记技术债；dsh 出正规机制后应迁回 `ctx.*`） | `lib/page-smoke.js:21-26`、`:51-114` |

## 已知限制

**固定的页面观察时长。** 页面半边固定观察 15s（`PAGE_OBSERVE_MS`，`lib/smoke.js:27`）。`pageSmoke` 与
`liveSmoke` 都接受 `observeMs` 覆盖（`lib/smoke.js:129`、`lib/page-smoke.js:140`），但工具没把它暴露成参数。
属"已登记未实现"：若将来出现慢装载场景，再加 `observeMs` 参数。

**非 Edge/Chrome 浏览器。** 只探测 Edge 与 Chrome 的常见安装路径（`lib/page-smoke.js:29-34`）。都找不到时
跳过页面半边并记 note，不误报成插件失败。

**非 Windows 的实例审计。** `listDshInstances` 只实现了 Windows（WMI + PowerShell）。其它平台返回
`ok:false`（"未测"），第 7 项此时退化为"只报引擎侧观察"（`lib/instances.js:128-135`）。要做的话按平台各写一条
进程表查询。

**隔离实例的 DSH_HOME 隔离。** `liveSmoke` 目前让实例继承宿主的 `~/.dsh`（不传 `env`，`lib/smoke.js:125`），
好处是**验证的就是真家目录**，代价是残留实例会与 GUI 共用 sessions/storages。插件之外已有镜像家目录的做法
（命令行外壳接受 `--home=` 覆盖，且 `liveSmoke` 本就支持 `env` 选项，`lib/smoke.js:120`），是否收进插件是
待拍板的产品决定，不是已实现的行为。

**不自动清理留在宿主侧的残留。** 审计只清 `--port 0` 的隔离冒烟实例；驻留宿主（可能是用户正开着的窗口）
永远只报不杀。

**输出只有中文。** 检查名、明细、note 与工具描述都是插进返回 JSON 的中文串，没有本地化层。

## 回归与测试

本插件不带自动化测试文件，验证按成本分三层组织：

**第 1 层——引擎自检（快，带负控）。** 冒烟引擎与实例审计各自在公开仓库里有自检：
- 页面冒烟自检跑正控（干净页面报 0 错误）、负控（页面 throw 与 `console.error` 必须都被抓到）与白屏控制
  （零错误但正文为空必须判不通过）。四项全 `ok:true` 才算探测器可信；
- 实例审计自检覆盖分类器：负控（pwsh 诊断脚本、或只是提到 dsh 的 `node -e` 单行，都不得被认成 DSH 本体）、
  正控（`smoke`/`host`/`other` 三类样例分类正确，在跑的宿主必须被认成 `host`——否则会被 `killStray` 误杀）、
  守卫（`killPid` 拒绝当前进程与非法 pid），以及可选的 `--stray` 模式：真造一个无人收的隔离实例（父进程退出、
  实例留下）→ 审计必须认出来 → 精确杀掉 → 复查为 0。

**第 2 层——真实 profile。** 成本递进：`plugin_check`（静态四项）→ `plugin_check({live:true})`（隔离实例起得来
且关闭被证实）→ `plugin_check({page:true})`（页面零错误且渲染证据非空）→ 怀疑有残留时
`plugin_check({sweep:true})`。

**第 3 层——工具体自检（新进程真跑工具）。** 这一层是机器可校验的那一层，现位于本公开仓库的
`test/tool-body-selftest.mjs`。它按脚本顶部的显式文件清单把 `lib/` 复制进桩包，搭一个桩 `ctx`（含**桩进程表**：
一个残留冒烟实例与一个宿主，`taskkill` 后残留消失），然后在**全新 Node 进程**里 `apply()` 并**真调
`execute()`**；只有成功才打印 `VERDICT: OK`，同时报出技能 Provider 的 `rank / bytes / whenToUse`。用
`--plugin <目录>` 即负控：含坏代码的插件必须抛错。

第 3 层存在，是因为第 1–2 层看不见它的盲区：`plugin_check --live` 只证明**树能启动**，从不执行工具的函数体，
而在跑的 dsh 只会服务它启动时载入的那份代码。于是源码层的损坏可以过 `node --check`、过 `plugin_check` 五检
全绿，却在下一次重启后第一次被调用时崩掉。这不是假设：把 `liveSmoke` 挪进 `lib/smoke.js` 时删掉了
`readFileText` / `listDirNames` / `fsPath` 三个辅助函数，**调用点却留着**——所有检查一路绿灯，而重启后工具
第一次被调用就会抛 `ReferenceError: readFileText is not defined`。补回这三个辅助函数
（`lib/index.js:51-78`，原因记在 `lib/index.js:42-50` 的注释里）并复现"修复前必崩、修复后跑通"，正是第 3 层的
用途；任何"工具体里有真逻辑"的插件都适用同一条纪律。新增/改名 `lib/` 文件时，该自检顶部的拷贝清单必须同步，
否则会 `ERR_MODULE_NOT_FOUND`。

**两条硬得来的契约，各自值得一条独立回归：**

- **`ctx.subprocess.spawn` 必须显式传 `cwd`（DSH 0.1.5）。** spec 的 `cwd` 会直接被拿去做环境校验
  （`validateNoNullByte("options.cwd", spec.cwd)`，即 `spec.cwd.includes("\0")`），缺 `cwd` 时在启动前就抛
  `Cannot read properties of undefined (reading 'includes')`——症状是工具整体返回该 `TypeError`，看起来像工具
  坏了，其实是 spawn 缺字段。两个调用点都已显式带 `cwd`：`run()` 在 `lib/index.js:29`，`liveSmoke()` 在
  `lib/smoke.js:142`。引擎侧模块出于同样原因把 `cwd` 记为必填（`lib/smoke.js:115`、`lib/instances.js:122`、
  `lib/page-smoke.js:131`）。
- **读采集输出用 `readFrom(offset)`，不要用 `finalize()`。** `ctx.subprocess` 的采集读取器契约是
  `{text, nextOffset, lossy}` 的**按字节偏移、非消耗式**读（`SubprocessOutputReader`）；`finalize()` 不属于
  该契约，且 0.1.5 实测恒为空字符串，旧代码据此拿到的 stdout/stderr 永远是空的。非消耗式偏移读也正是实跑
  冒烟能成立的前提：页面那一半需要在**实例还活着时**拿到 URL（`lib/smoke.js:36-50`，用于轮询循环
  `lib/smoke.js:157-160` 与退出后的 `lib/smoke.js:187`、`lib/instances.js:113-114`）。

**"未测"与"失败"必须分开。** 浏览器找不到/起不来/调试端口连不上时页面结果是 `tested:false`，`liveSmoke`
相应地报成 `pageOk:true, pageTested:false` 并在 detail 写明原因：基础设施问题绝不得报成插件问题。同一条规则
也适用于进程表——读不到进程表时审计返回 `ok:false`，据此报"未测"而非"没有残留"。

## 维护说明

**改检查范围、解析规则，或改 `lib/smoke.js`、`lib/page-smoke.js`、`lib/instances.js` 的注入契约之后，必须同步
更新本文件。** 尤其保持三条说明准确：插件实体在 `plugins/`、`node_modules/@local` junction 是可选的；存在两套
启动预算（外加收尾与残留阈值两类超时）；引擎只有一份（在本包内，`spawn` 由调用方注入）。
