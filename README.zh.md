<div align="center">

<img src="assets/banner.svg" alt="dsh-startup-check —— 在重启之前抓住坏插件" width="880">

# dsh-startup-check

**在重启之前，抓住坏掉的那个插件。**

*一个工具 `plugin_check`，专治「刚装了插件」到「dsh 打不开」之间的那段时间。*

[![CI](https://github.com/cningan/dsh-startup-check/actions/workflows/ci.yml/badge.svg)](https://github.com/cningan/dsh-startup-check/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-startup-check?color=3fb950&label=npm)](https://www.npmjs.com/package/dsh-startup-check)
[![provenance](https://img.shields.io/badge/provenance-signed-3fb950)](https://www.npmjs.com/package/dsh-startup-check)
[![node](https://img.shields.io/badge/node-%E2%89%A522-3fb950)](package.json)
[![platform](https://img.shields.io/badge/platform-Windows-0078d4)](#环境要求)
[![license](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)

**简体中文** · [English](README.md)

</div>

---

## 它解决的问题

每一次装 DSH 插件，都是一次信仰之跃：

```text
装插件 → 重启 → 才发现起不来
```

跃失败的时候，你手上的 dsh 已经打不开、没有页面可以问、只能手工二分排查那棵插件树。
而这时候，那个本来能读懂源码的智能体已经不在了。

`plugin_check` 把「发现问题」挪到**重启之前**：模型先体检这棵树——需要的话还真起一个隔离实例
证明它起得来——趁它还能当场把问题修掉。

<div align="center">
<img src="assets/before-after.svg" alt="没有预检：装插件、重启、dsh 打不开；有了预检：静态检查通过、隔离实例起得来又确实退出，然后才告诉你「可以重启了」。" width="880">
</div>

## 一次失败长什么样

某个插件语法坏了，重启之前就被抓到，并且点名到文件：

```jsonc
// plugin_check { "target": "dsh-oauth" }
{
  "ok": false,
  "checks": [
    { "name": "语法检查", "ok": false,
      "detail": "dsh-oauth/lib/index.js: Unexpected token '}' (node --check exit 1)" },
    { "name": "package.json 结构", "ok": true, "detail": "1 个插件结构一致" },
    { "name": "配置树组装", "ok": true, "detail": "配置树组装成功 (162 行)" }
  ]
}
```

模型读到它、改掉那个文件、重跑体检，然后你才重启。若裁决是真失败，内嵌的
**`plugin-fault-diagnosis`** 技能接手：读裁决 → 定位文件 → 判错误类型 → 修 / 禁用 / 回退。

## 检查什么

| # | 检查项 | 能抓到什么 |
|:-:|---|---|
| 1 | **语法检查** | 插件 `lib/*.js` 过不了 `node --check`（手滑、在纯 JS 插件里写 TS/JSX） |
| 2 | **包结构** | `main` 指向的文件不存在、声明了 `dsh.client` 却没有 `exports["./client"]`、包名前缀不对 |
| 3 | **patch 引用** | `cordis.patch.yml` 引用了一个已经不存在的插件目录 |
| 4 | **配置树组装** | `dsh --profile <p> --dump-config` 失败——加载器根本装不起这棵树 |
| 5 | **实跑冒烟** `live: true` | 隔离实例始终打印不出 `dsh web: <url>` |
| 6 | **页面侧冒烟** `page: true` | 页面抛异常、console 报错，或根本没渲染——宿主看不见的客户端故障 |
| 7 | **实例关闭确认**（跟 `live`） | 隔离实例**其实没退**——用进程表证实，不是"我喊过它停了" |
| 8 | **残留实例审计** `sweep: true` | 遗留的冒烟实例，以及在跑的宿主清单——除非你要求，**只报不杀** |

<div align="center">

**🛡️ 设计上只读**

它绝不重启、也绝不碰你正在用的那个 dsh。
冒烟实例跑在 `--port 0` + `--no-open` 上并有硬超时；
清理**只**杀隔离的冒烟实例、只按精确 pid —— 驻留宿主永远不会被杀。

</div>

## 安装

```bash
dsh plugin --profile web add dsh-startup-check
```

然后**重启 dsh**——安装插件会改动 `dsh.profile.bundles`，而它在启动时才读。
这也是你最后一次信仰之跃。

npm 上的包由 GitHub Actions 发布，并带**签名存证**（provenance）：任何拿到包的人都能核验
「它确实是从这个仓库、这段提交构建出来的」，而不是某台机器上手打上去的：

```bash
npm view dsh-startup-check dist.attestations
```

```bash
plugin_check                          # 静态检查（快）
plugin_check { live: true }           # ＋ 起一个隔离实例            （约 12s）
plugin_check { page: true }           # ＋ 无头浏览器页面检查        （约 30–45s，隐含 live）
plugin_check { sweep: true }          # ＋ 审计在跑的 DSH 进程       （约 1–2s）
plugin_check { live: true, killStray: true }   # 顺带清理本次跑出来的残留
```

## 怎么读裁决

- `ok: true` 是说**跑过的那些检查**通过了。只跑静态检查说明不了运行时行为；只有 `live` 能证明树真能启动。
- **「未测」不等于「失败」**：没有浏览器、进程表读不出来时，相关检查会写明原因并按未测处理
  （`tested: false`），不栽赃给你的插件。
- 第 1–3 项扫描 `~/.dsh/profiles/web/plugins/**`（`@local` 布局）；从 npm 装进 profile `node_modules`
  的插件由第 4–8 项覆盖。
- profile 目前固定为 `web`；支持别的 profile 是待办。

## 环境要求

| | |
|---|---|
| **宿主** | 带 `web` profile 的 DeepSeek Harness |
| **系统** | Windows —— 实例审计用 PowerShell/WMI，页面那半用 CDP 驱动 Edge/Chrome |
| **Node** | ≥ 22（dsh 自身运行时） |
| **浏览器** | Edge 或 Chrome，只在你要跑页面侧检查时需要 |

## 参与开发

```bash
git clone https://github.com/cningan/dsh-startup-check.git
cd dsh-startup-check
npm test
```

`npm test` 先对 `lib/` 逐个 `node --check`，再跑
[`test/tool-body-selftest.mjs`](test/tool-body-selftest.mjs)：在全新 Node 进程里用桩 `ctx`
真调 `apply()` 与工具的 `execute()`。这一层是 `node --check` 和"树能启动"都看不见的——
运行中的 dsh 一直在跑它启动时载入的那份代码，工具体改坏了会一路绿灯，直到下次重启。

完整设计、每个对象的生命周期与已知限制见 [`docs/architecture.zh.md`](docs/architecture.zh.md)。
欢迎贡献——见 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 [`CHANGELOG.md`](CHANGELOG.md)。

<div align="center">

**[MIT](LICENSE.zh.md) © cningan** · 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 而作

</div>
