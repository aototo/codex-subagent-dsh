# 0.4.0 — Browser connection / 浏览器确认连接

Release candidate. GitHub `main` supplies this version after the PR is merged.
This change does not create a tag or GitHub Release.

## 中文

首次连接不再要求用户执行 Node 命令和复制 DSH 登录链接。在 Codex 中说“连接我的 DSH”，核对浏览器与对话中的匹配码，点击“允许连接”，再告诉 Codex 已确认。插件验证连接并保存本机凭证后才返回 `ready`。

- 新增第五个工具 `dsh_connect`，支持发起、检查和取消配对；`dsh_status` 仍只检查状态。
- 需要升级 Codex 插件及同一 DSH profile 中的 companion 到 0.4.0。检查共享实例有无任务后再重启 DSH，并开启新 Codex 对话加载新版。
- 浏览器须已登录 DSH；插件不绕过 DSH 首次登录，也不自动批准任务权限。未安装配对 companion 时仍可使用原终端连接方式。
- 允许后自动验证和保存；拒绝、取消或 5 分钟过期均不保存新凭证、不自动重新配对。未完成配对不能跨进程重启恢复；已保存的有效凭证不受影响。
- 凭证复用 DSH 浏览器 Cookie 的权限和期限，尚无独立服务端撤销或按任务限权。模型选择、任务派发与等待授权识别保持兼容。

安装与操作见 [README](../README.md)。建议将 companion 放在稳定的版本目录，避免 Codex 缓存清理使 DSH 引用失效。

## English

Connect from Codex, compare the matching code in the browser and conversation,
choose Allow connection, then ask Codex to check. The new `dsh_connect` tool
verifies and saves credentials locally before reporting `ready`; no Node command
or login-link copy is required for this flow.

Upgrade both the Codex plugin and the companion in the same DSH profile to 0.4.0.
Check for active tasks before restarting the shared DSH instance, then open a new
Codex conversation. The browser must already be signed into DSH. Terminal-based
connection remains a fallback without a pairing companion.

Rejection, cancellation, and five-minute expiry do not save new credentials or
automatically retry. Unfinished pairings cannot survive a process restart;
saved credentials remain usable while valid. Pairing reuses the browser cookie's
permissions and lifetime, without independent revocation or task-level scopes.
It does not approve execution permissions or change model routing.

## Validation

- Type checking, distributable build, and all 145 automated tests passed.
- Production companion and bundled MCP passed isolated integration against DSH
  0.1.5-rc.2 without paid model calls or changes to the user's shared instance.
- Real Chrome checks passed: allow, reject, and an untouched full five-minute
  expiry (300708 ms). Expired forms could not authorize; rejection and expiry
  left no saved credentials and did not restart pairing.
- Isolated local-marketplace installation passed. Browser multi-window behavior
  and automatic opening on other operating systems remain untested manually.

Detailed evidence: [verification record](BROWSER_PAIRING_VERIFICATION.md).
