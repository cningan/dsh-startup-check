# publish-dsh-startup-check.ps1 — 由你本人执行的「发布 dsh-startup-check 到 npm」向导
#
# 为什么让你跑：`npm login` 要你亲手输密码与 2FA 码（凭据不进 AI 上下文），
# 而且「登录 + 发布」这一次动作由你本人发起最干净——不是代跑。
# 每一步都会停下等你确认；中途 Ctrl+C 退出不会留下半成品。
#
# 用法（在这个仓库目录里）：
#     pwsh -File scripts\publish-dsh-startup-check.ps1
# 或：
#     powershell -ExecutionPolicy Bypass -File scripts\publish-dsh-startup-check.ps1

$ErrorActionPreference = 'Stop'
$OfficialRegistry = 'https://registry.npmjs.org/'
$Package = 'dsh-startup-check'
$Total = 6
$script:Stage = 0

# 确保从仓库根目录运行（本脚本在 scripts/ 下）
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Show-Stage([string]$Title) {
  $script:Stage++
  Clear-Host
  Write-Host ''
  Write-Host ("═" * 68) -ForegroundColor DarkGray
  Write-Host ("[{0}/{1}] {2}" -f $script:Stage, $Total, $Title) -ForegroundColor Cyan
  Write-Host ("═" * 68) -ForegroundColor DarkGray
}

function Pause-Step([string]$Hint = '回车继续') {
  Write-Host ''
  Read-Host "▶ $Hint" | Out-Null
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host "dsh-startup-check → npm 发布向导" -ForegroundColor Green
Write-Host "仓库：$repoRoot"
Write-Host "共 $Total 步，每步都会停下等你。Ctrl+C 可随时退出（不会留下半成品）。"
Pause-Step '开始'

# ────────────────────────────────────────────────────────────────────────────
Show-Stage '环境体检：确认 npm 在、且包还没被发布'
if (-not (Test-Command 'npm')) { throw 'PATH 里找不到 npm，请先装 Node.js 22+。' }
Write-Host ("npm 版本：" + (npm -v)) -ForegroundColor DarkGray
Write-Host ''
Write-Host '检查包名是否已被占用（404 = 可用）：'
npm view $Package version --registry $OfficialRegistry 2>&1 | ForEach-Object { "  $_" }
Write-Host ''
Write-Host '如果上面是 404，说明包名可用，继续。' -ForegroundColor DarkGray
Pause-Step '回车继续'

# ────────────────────────────────────────────────────────────────────────────
Show-Stage '把 registry 指向官方（淘宝镜像是只读缓存，不能发布）'
Write-Host '本机全局 registry 现状：'
npm config get registry
Write-Host ''
Write-Host '这个向导不会改你的全局配置（装包继续走镜像更快），只在发布命令上显式指定官方源。'
Pause-Step '回车继续'

# ────────────────────────────────────────────────────────────────────────────
Show-Stage '登录 npm（这一步只有你能做：要输密码 + 2FA 码）'
Write-Host @'
现在会在你面前启动 npm 的登录流程，请按提示输入：

  · Username : 你的 npm 用户名
  · Password : 你的 npm 密码
  · OTP      : 手机验证器 App 里的 6 位动态码（开了 2FA 才问）

说明：npm 11 默认的 --auth-type=web 会开浏览器去 npmjs.com 授权，
而你的 IP 目前访问该网站会被拦（HTTP 403），所以这里显式用 legacy 模式：
认证直接走 registry 接口（我实测该接口是通的），不需要打开网站。
'@ -ForegroundColor Gray
Write-Host ''
Pause-Step '回车开始登录'
npm login --auth-type=legacy --registry $OfficialRegistry
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '登录没有成功。可能的原因与对策：' -ForegroundColor Yellow
  Write-Host '  · 403 / 网络层拒绝 → 这条 IP 的 registry 出口也被拦了：等封禁到期再试，或换网络（手机热点）后重跑本向导。'
  Write-Host '  · 401 / 认证失败 → 用户名或密码错，或 2FA 码过期（30 秒一换，重新取一个）。'
  Write-Host '  · EOTP / one-time password required → 你的账号要求 2FA，把 App 里的当前码填进 OTP 提示。'
  Write-Host '  · 提示账号被暂停（security hold）→ 见本向导最后一段。'
  throw '登录失败，未做任何发布动作。'
}
Pause-Step '回车继续'

# ────────────────────────────────────────────────────────────────────────────
Show-Stage '确认身份与"包里到底有什么"'
$who = (npm whoami --registry $OfficialRegistry 2>&1 | Out-String).Trim()
Write-Host ("已登录身份：{0}" -f $who) -ForegroundColor Green
Write-Host ''
Write-Host '即将发布的文件清单（dry-run，不会真的发布）：'
Write-Host ''
npm publish --dry-run --registry $OfficialRegistry
Write-Host ''
Write-Host '核对要点：应当只有 lib/ assets/ docs/ cordis.patch.yml README* LICENSE* CHANGELOG.md package.json；' -ForegroundColor Gray
Write-Host '不应出现 test/、.github/、node_modules/ 或任何 .bak 文件。' -ForegroundColor Gray
Pause-Step '清单没问题就回车继续'

# ────────────────────────────────────────────────────────────────────────────
Show-Stage '打 tag 并推送（让 GitHub 上有 v0.4.0 这个发布点）'
Write-Host '当前 git 状态：'
git status --short
Write-Host ''
$tagExists = git tag -l 'v0.4.0'
if ($tagExists) {
  Write-Host 'v0.4.0 这个 tag 已存在，跳过创建。' -ForegroundColor DarkGray
} else {
  Write-Host '将执行：git tag v0.4.0 && git push origin v0.4.0'
  Pause-Step '回车执行'
  git tag v0.4.0
  git push origin v0.4.0
  if ($LASTEXITCODE -ne 0) { Write-Host 'tag 推送失败（本地 tag 已建，可稍后重推）：git push origin v0.4.0' -ForegroundColor Yellow }
}
Write-Host ''
Write-Host '注意：本仓库的 publish.yml 用的是 npm 可信发布（OIDC），配好之前它不会成功；' -ForegroundColor Yellow
Write-Host '本次发布由你本地完成，所以 tag 只是存档点，不会重复发布。' -ForegroundColor Yellow
Pause-Step '回车继续'

# ────────────────────────────────────────────────────────────────────────────
Show-Stage '正式发布到 npm'
Write-Host '将要执行（公开发布，不可撤销地占用 dsh-startup-check@0.4.0 这个版本号）：' -ForegroundColor Yellow
Write-Host ''
Write-Host "    npm publish --registry $OfficialRegistry" -ForegroundColor White
Write-Host ''
Write-Host '如果这次发布需要提供一次性验证码，用：npm publish --registry <官方> --otp=<6位码>'
$answer = Read-Host '▶ 输入 PUBLISH 并回车才会真的发布（其它输入则跳过）'
if ($answer -ceq 'PUBLISH') {
  npm publish --registry $OfficialRegistry
  if ($LASTEXITCODE -eq 0) {
    Write-Host ''
    Write-Host '发布成功。验证：' -ForegroundColor Green
    npm view $Package version --registry $OfficialRegistry
    Write-Host ''
    Write-Host "包页（等你的 IP 解封后可见）：https://www.npmjs.com/package/$Package" -ForegroundColor Green
    Write-Host '仓库 README 里的 npm 徽章会自动从 not found 变成 0.4.0。' -ForegroundColor Green
    Write-Host ''
    Write-Host '别人现在就可以装了：dsh plugin --profile web add dsh-startup-check' -ForegroundColor Green
  } else {
    Write-Host ''
    Write-Host '发布失败。常见原因：' -ForegroundColor Yellow
    Write-Host '  · 包名已被占用（不可能，除非别人刚抢注）→ 换名后重来。'
    Write-Host '  · 需要 OTP → 加 --otp=<6位码> 重试。'
    Write-Host '  · security hold / 账号暂停 → 见最后一段。'
    Write-Host '  · 403 → 出口 IP 被拦，换网络再来。'
  }
} else {
  Write-Host '已跳过发布（没有产生任何 npm 侧改动）。' -ForegroundColor DarkGray
}

# ────────────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host ("═" * 68) -ForegroundColor DarkGray
Write-Host '收尾提示' -ForegroundColor Cyan
Write-Host ("═" * 68) -ForegroundColor DarkGray
Write-Host @'
1. 发布之后建议再做一件事（需要能打开 npmjs.com 网页，等你的 IP 解封后）：

   包页 → Settings → Trusted Publisher → 填：
       Publisher            : GitHub Actions
       Organization or user : cningan
       Repository           : dsh-startup-check
       Workflow filename    : publish.yml
       Environment          : npm-publish

   配好之后，以后只要 `npm version patch && git push --follow-tags`，
   CI 就用一次性凭证发布（无需 token、无需你本地登录），
   而且带 provenance 签名。仓库里的 .github/workflows/publish.yml 已按这个写好。

2. 如果你遇到的是「能登录但所有敏感写入被拒」：那是 npm 的 72 小时安全暂停
   （官方公告：recovery code 登录后所有账号强制暂停 publish / 建 token 等写入）。
   它按登录事件计时、到点自动解除，用户无法提前解除，也不必联系支持。
   此时什么都别重试，等满 72 小时再跑本向导。

3. 本机全局 registry 仍是淘宝镜像（装包更快）。发布命令都显式带了官方源，
   不受影响；若你想改为全局官方源：npm config set registry https://registry.npmjs.org/
'@ -ForegroundColor Gray
Pause-Step '完成，回车退出'
