<h1 align="center">dsh-startup-check</h1>

<p align="center">
  简体中文 · <a href="README.md">English</a>
</p>

<p align="center">
  重启 dsh 之前的插件树体检 —— 把「装了插件 → 重启打不开 → 才发现」提前到<b>重启之前</b>。
</p>

`dsh-startup-check` 是一个 DSH（DeepSeek Harness）插件，也就是一个 npm 包。它给模型一个工具
**`plugin_check`**：在你重启之前，只读地体检 dsh 将要加载的整棵插件树，并可以真起一个**隔离实例**
证明它起得来。它还内嵌了技能 **`plugin-fault-diagnosis`**——体检失败之后该怎么定位、怎么修。

---

## 它解决什么问题

装/改 DSH 插件现在是一次"信仰之跃"：

1. 加一个插件（或改一个插件）；
2. 重启 dsh；
3. **然后**才发现起不来——有时还是白屏、看不到明显报错。

到这一步，你正在用的那个 dsh 已经没了，只能带着压力排查。

`plugin_check` 把"发现问题"这件事提前到**重启之前**：那时模型还读得到源码，还能当场修。

## 检查什么

| # | 检查项 | 能抓到什么 |
|---|---|---|
| 1 | **语法检查** | 插件 `lib/*.js` 过不了 `node --check`（手滑、在纯 JS 插件里写了 TS/JSX……） |
| 2 | **包结构** | `main` 指向的文件不存在、声明了 `dsh.client` 却没有 `exports["./client"]` 入口、包名前缀不对 |
| 3 | **patch 引用存在性** | `cordis.patch.yml` 引用了一个已经不存在（改名/删除/拼错）的插件目录 |
| 4 | **配置树组装** | `dsh --profile <p> --dump-config` 失败——加载器根本装不起这棵树 |
| 5 | **实跑冒烟**（`live: true`） | 隔离实例始终打印不出它自己的 `dsh web: <url>` |
| 6 | **页面侧冒烟**（`page: true`） | 页面抛异常、console 报错，或根本没渲染——宿主进程看不见的客户端插件故障 |
| 7 | **实例关闭确认**（跟着 `live`） | 隔离实例**其实没有退出**（用进程表证实，而不是"我喊过它停了"） |
| 8 | **残留实例审计**（`sweep: true`） | 遗留的隔离冒烟实例，以及正在运行的宿主清单——除非你明确要求，**只报不杀** |

工具返回结构化 JSON：`{ ok, checks: [{ name, ok, detail }] }`，`ok` 就是唯一的裁决信号。

### 安全边界

`plugin_check` 对**你的 profile 只读**，绝不重启、也绝不碰你正在用的那个 dsh。冒烟检查另外起一个
**独立实例**（端口交给 OS 分配 `--port 0`、`--no-open`、有硬超时），跑完还要用进程表证实它真的退了。
清理（`killStray: true`）**只按 pid 精确杀**隔离的 `--port 0` 冒烟实例；驻留宿主永不清理。

## 环境要求

- **DeepSeek Harness**，且使用 `web` profile（`~/.dsh/profiles/web`）。
- **Windows**。实例审计用 PowerShell/WMI，页面侧冒烟用无头 Edge/Chrome + CDP，两者目前都只有
  Windows 实现；本包在 npm 上也声明为 Windows-only。
- **Node.js ≥ 22**（dsh 自身的运行时）。
- 想跑页面侧检查需要装 Edge 或 Chrome（可选）。

## 安装

```bash
dsh plugin --profile web add dsh-startup-check
```

`dsh plugin` 是 dsh 的 profile 插件管理器：它转发到 profile 目录里的 `pnpm`；由于本包声明了
`dsh.bundle.patch`，装完会自动被加进 profile 的 bundle 层。

**装完要重启 dsh**——安装插件会改动 `dsh.profile.bundles`，而它在启动时才读。

之后让模型体检，或者自己调：

```
plugin_check                      # 只做静态检查（快）
plugin_check { live: true }       # 再起一个隔离实例（约 12s）
plugin_check { page: true }       # 再加无头浏览器页面检查（约 30–45s，隐含 live）
plugin_check { sweep: true }      # 再审计在跑的 DSH 进程（约 1–2s）
plugin_check { live: true, killStray: true }   # 顺带清理本次跑出来的残留
```

## `ok` 意味着什么，又不意味着什么

- `ok: true` 是说**跑过的那些检查**通过了。只跑静态检查说明不了运行时行为；只有 `live` 能证明这棵树
  真能启动。
- **「未测」不等于「失败」**：找不到浏览器、进程表读不出来时，相关检查会写明原因并按未测处理
  （`tested: false`），不会栽赃给你的插件。
- 静态检查（第 1–3 项）扫描的是 `~/.dsh/profiles/web/plugins/**`，也就是 `@local` 插件目录布局；
  从 npm 装进 profile `node_modules` 的插件不在这三项范围内（配置树组装与冒烟检查仍然覆盖它们）。
- profile 目前固定为 `web`；指向别的 profile 是待办项。

完整设计、每个对象的生命周期与已知限制见 [`docs/architecture.zh.md`](docs/architecture.zh.md)。

## 参与开发

```bash
git clone https://github.com/cningan/dsh-startup-check.git
cd dsh-startup-check
npm test        # 逐文件 node --check + 工具体自检
```

`npm test` 会跑 [`test/tool-body-selftest.mjs`](test/tool-body-selftest.mjs)：把 `lib/` 复制进一个临时
装置，用桩包替换 `@deepseek-ai/*` 导入、用桩 `ctx` 提供 fs/subprocess/skills，然后在**全新 Node 进程**
里 `apply()` 并真调工具的 `execute()`。这一层是 `node --check` 和"树能启动"都看不见的：运行中的 dsh
一直在跑它启动时载入的那份代码，工具体改坏了会一路绿灯，直到下次重启。

想对着真实 dsh 迭代，就在 `~/.dsh/profiles/web/plugins/dsh-startup-check/` 里改，然后跑
`plugin_check { live: true }` 并重启。

欢迎贡献——见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可证

[MIT](LICENSE.zh.md) © cningan
