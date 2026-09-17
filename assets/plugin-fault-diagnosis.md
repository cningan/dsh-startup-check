# 插件故障诊断（dsh 插件预检失败后的处置流程）

`plugin_check`（由 `@local/dsh-startup-check` 提供）只做**体检并返回裁决信号** `{ ok, checks }`。它告诉你「哪一项、哪一句报错」，但**如何定位根因、决定是修还是禁用、怎么安全回退**，需要你按下面的步骤判断并动手。**本 skill = 失败后的诊断与修复；触发与否由 plugin_check 报 `ok:false` 决定，不需要每次自动跑。**

## 〇、先记住三条底线

1. **只诊断与修复，不臆断**：不确定根因就标 ⚠️待核实，并给用户可复现的报错信息，绝不用「应该没问题」掩盖。
2. **改前备份、最小改动**：任何文件改动前先复制备份（或先记录原内容），只做能定位到根因的最小修改，不打大补丁。
3. **禁用/回退属于用户可感知变动**：涉及禁用插件、改 `cordis.patch.yml`、回退配置，先向用户说明「是什么 / 影响什么 / 不改变什么」，再按全局「做事·先问再动」的确认线取得同意后动（确认线不在此另立）。

## 一、读裁决（找到失败的项）

`plugin_check` 返回 `{ ok, checks }`，其中 `checks` 是一组 `{ name, ok, detail }`。先看 `ok === false` 的项，`detail` 是定位线索。

检查项的名称与含义（对应 `dsh-startup-check/lib/index.js`）：

| name | 含义 | 常见失败点 |
|---|---|---|
| `patch 引用存在性` | `cordis.patch.yml` 里引用的 `@local/*` 插件目录是否真的存在 | 装了插件/重命名/删除但 patch 还引用 |
| `语法检查` | 每个 `@local` 插件 `lib/*.js` 过 `node --check` | 语法错误、写了 TS/JSX、`import` 了不存在的包 |
| `package.json 结构` | `main`/`exports./client`/`dsh.client` 一致性 | 入口文件缺失、`dsh.client` 声明了但 `exports` 缺 `./client` |
| `配置树组装` | `dsh --profile web --dump-config` 能否组装成功 | `cordis.patch.yml` 引用不存在、插件缺依赖、配置语法错 |
| `实跑冒烟(--live)` | `live:true` 时 spawn 隔离 `dsh --profile web --port 0 --no-open` 能否打印 `dsh web:` URL | 运行时/事件/时序/装配错误，静态检查拦不住 |

## 二、定位（由 check 指向具体插件与文件）

- 插件目录：`~/.dsh/profiles/web/plugins/<插件名>/`
- 补丁文件：`~/.dsh/profiles/web/cordis.patch.yml`
- 常用入口：`plugins/<名>/package.json`、`plugins/<名>/lib/index.js`、`plugins/<名>/lib/<子文件>.js`

对照失败的 `name`/`detail`：

- 语法 / 结构失败：`detail` 通常带 `插件名/lib/文件`，直接定位该文件。
- patch 引用失败：`detail` 列出缺失的插件名，去 `cordis.patch.yml` 找引用行并在 `plugins/` 下核实是否存在。
- 配置树失败：`detail` 带 `dsh --profile web --dump-config` 的 stderr，通常是装配/引用/依赖问题。

## 三、判断错误类型（按 type 分治法）

### A. 结构 / 语法（`语法检查`、`package.json 结构` 失败）
- **找最近改动**：这个插件/文件最近由谁、改了什么（翻 `_docs`、项目文档、git 历史）。
- **对照定义**：`package.json` 的 `name` 是否 `@local/*` 前缀、`main` 指向的入口是否存在、声明了 `dsh.client` 就一定有 `exports['./client']` 且指向的文件存在。
- **验证语法**：`node --check <该文件>` 单独跑，确认是不是这一处。

### B. 配置树组装失败（`配置树组装`）
- 看 `cordis.patch.yml` 引用是否都指向存在的插件、插件是否缺依赖、是否有语法错误。
- 手动跑 `dsh --profile web --dump-config` 复现并读完整报错。

### C. 实跑失败（`实跑冒烟(--live)`）
- 只看 stderr 的关键行 + 退出码；多为插件加载失败、事件/时序冲突、运行时异常。
- 排查顺序：先确认静态四项全绿（排除结构性）→ 再看运行时错误栈 → 缩小到报错插件。

## 四、修法分级（能修则最小修，否则降级）

1. **能修 → 改**：先备份（复制原文件或记录原内容），做最小改动；改完 `node --check` 自检 + 重跑 `plugin_check`（必要时 `live:true`）验证全绿。
2. **不能即刻修 / 高度疑似某插件 → 建议禁用该插件**：向用户说明后，按确认线取得同意再在 `cordis.patch.yml` 里注释/移除该插件行，重跑 `plugin_check` 确认是否恢复。**禁用是临时止血，须同步登记技术债（说明为什么禁、何时/如何改回正规）。**
3. **都失败 / 已改坏 → 回退到上一稳定配置**：用 git 快照或备份恢复 `cordis.patch.yml` 与改动文件，把「改了什么 / 报了什么错 / 如何复现」整理给用户。

## 五、留痕

把「改了什么 / 什么导致 / 验证结果」记录到对应项目文档（`_projects/<项目>/` 下；跨主题零星 → 归入最相关的项目文件夹，区根不设流水文件），含：失败 check 名 + detail、判断出的根因、改的文件与内容、`plugin_check` 复跑结果、是否残留待办（⚠️待核实 / 技术债）。

## 六、边界

- **只诊断与修复建议**，不做「每次自动跑」（那是 plugin_check 工具的事）。
- 禁止绕过正规机制：插件修复优先用官方 Skill/Slot/Service/事件（见 `cordis-plugin-development`、`editing-cordis-compositions`），不靠猜 DOM、不打编译产物补丁。
- 改动 `cordis.patch.yml`、禁用/回退前，遵守「先说明 + 按确认线取得同意」；不确定的根因一律标 ⚠️待核实，不写死结论。
