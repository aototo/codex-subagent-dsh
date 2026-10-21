# codex-subagent-dsh

[简体中文](README.md) | [English](README_EN.md)

`codex-subagent-dsh` 是一个社区 Codex 插件，通过本地 STDIO MCP 把边界明确的任务交给已运行的 DeepSeek Harness（DSH）。Codex 主 Agent 仍负责选择使用 DSH 还是 Codex 原生子 Agent，并负责检查文件、diff、测试与最终验收。

仓库同时提供 Codex marketplace 入口和可直接运行的插件产物。真实 DSH 文本、文件读取和隔离 worktree 修改均已通过；新桌面对话直接调用插件的只读任务也已通过。关闭窗口和整个应用正常退出均已验证：DSH 可继续执行，插件先保留 unknown。重开后可用原 taskId 和 conversationKey 调用 dsh_task，按完整证据恢复终态与结果；崩溃场景仍待验证。

0.4.0 新增浏览器确认连接：Codex 发起连接，在已登录的 DSH 页面确认后自动连接，无需运行连接命令或复制登录链接。详情见[发布说明](docs/RELEASE_NOTES_0.4.0.md)。

## Web 与桌面端（0.5.0）

0.5.0 新增桌面连接、按任务指定模型和推理档位，并支持与凹凸助手同时使用。随包组件为 desktop bridge 0.1.1 和 companion 0.4.1。本次 PR 合并前，GitHub `main` 仍为 0.4.0；下面的桌面能力需要 0.5.0。

| 你使用的 DSH | 安装的配套组件 | 首次连接 |
|---|---|---|
| Web | `dsh-companion`，仅限兼容性记录中的已验证版本组合 | 在 Codex 说“连接 Web DSH”，在已登录的浏览器确认匹配码并允许 |
| 桌面客户端 | 随插件提供的 `dsh-desktop-bridge` | 在客户端安装并启用桥接组件，点击“允许连接”，在 Codex 说“连接桌面 DSH” |

桌面组件的安装、授权和卸载见 [桌面连接组件说明](plugins/codex-subagent-dsh/dsh-desktop-bridge/README.md)。它是社区组件，不是 DSH 官方内置能力。请完整复制到 Codex 缓存之外的稳定版本目录，使用客户端支持的插件安装入口；不要使用 `dsh plugin --profile desktop`，当前 CLI 拒绝管理 desktop profile。先确认无运行任务，再按客户端要求重载。

Codex 可在第一次 `dsh_status` 或 `dsh_connect` 中指定 `connectionMode: web | desktop | auto`。默认 auto 先检查 Web，只有其端口不可达才发现桌面实例；显式配置 `DSH_SUBAGENT_URL` 而未配置模式时保留固定地址行为。也可使用环境变量 `DSH_CONNECTION_MODE` 设置默认模式。

- 连接成功返回实际模式和地址。两端同时运行时，先说清希望使用哪一个。
- 桌面动态端口从用户授权生成的私有文件发现；Codex 专用发现文件和凭据位于 `~/.codex-subagent-dsh/codex-desktop/`（自定义 `DSH_SUBAGENT_HOME` 时使用其下的同名子目录）。凹凸助手继续使用原根目录，两组件可同时启用，不覆盖彼此连接文件。
- 新版本不会读取或复制旧根目录里的桌面授权，升级后请在“Codex 连接”中重新允许一次。不扫描端口、不读取 Cookie 数据库、不要求把 token 发到对话。
- 每个 MCP 进程选定实例后固定。切换端、桌面重启或换端口后，重新授权并开新 Codex 对话；鉴权失败不自动换端。
- 任务去重和恢复按 origin 隔离。换端口后不能用新地址恢复旧任务；先在 DSH 核对，不重发 unknown 任务。
- `ready` 只代表基础连接。指定模型需要 `includeModels: true` 返回支持的目录；桌面缺少模型路由时仍可按 DSH 当前模型执行普通任务，不能静默替代用户指定的模型或修改共享默认模型。

桌面端按任务选模型还需安装同包的 **`dsh-companion` 0.4.1**：把完整目录复制到稳定版本路径，通过客户端插件管理安装并启用。它与 `dsh-desktop-bridge` 分工：桥接负责连接授权，companion 负责会话模型路由。旧 companion 0.4.0 的依赖范围不包含 Desktop 0.2.1-rc.2，可能被桌面加载器跳过。安装后先用 `dsh_status { connectionMode: "desktop", includeModels: true }` 确认能力，再按目录返回的 provider/model/reasoningEffort 派发。详见 [配套组件说明](plugins/codex-subagent-dsh/dsh-companion/README.md)。

实现与验收范围见 [双端计划](docs/WEB_DESKTOP_PLAN.md)、[桌面验证记录](docs/DESKTOP_CONNECTION_VERIFICATION.md)及[兼容性记录](docs/COMPATIBILITY.md)。以下快速开始只适用于 Web；桌面端请按上方组件说明安装。macOS Desktop 0.2.1-rc.2 已完成实际 UI 安装、用户允许/拒绝、双组件共存和 DeepSeek Flash/low、swe-2/high 并发任务验收；客户端重启后重新授权的完整 UI 流程仍未验收。

## Web 快速开始

1. 从 GitHub marketplace 安装插件（仓库已提交可运行产物，不需要克隆或 npm 构建）：

   ```bash
   codex plugin marketplace add aototo/codex-subagent-dsh --ref main
   codex plugin add codex-subagent-dsh@codex-subagent-dsh
   ```

2. 确认本机 DSH 已启动，默认地址为 `http://127.0.0.1:3080`。在浏览器中完成 DSH 自己的登录；多个 Codex 对话共用此实例。
3. 让 Codex 协助将随插件提供的 `dsh-companion` 安装到实际运行的 DSH profile；浏览器连接和指定模型都需要它。无需克隆仓库或 npm 构建：

   ```bash
   dsh plugin --profile web add -w "/absolute/path/to/installed-plugin/dsh-companion"
   ```

   `web` 可替换为实际 Web profile，不要替换为 `desktop`。安装/升级后需要重启该 profile：先检查有无运行任务，避免打断共享实例。安装位置可由 Codex 根据已加载 Skill 定位。为避免 Codex 缓存清理导致 DSH 引用失效，建议由 Codex 将 companion 完整复制到稳定的、带版本号的本地数据目录后，从该目录安装；保留旧目录可供回滚。若直接引用缓存路径，升级/卸载后需重新绑定仍存在的路径。
4. 开启新 Codex 对话，直接说 **“连接我的 DSH”**。Codex 检查状态并打开确认页；核对页面与对话里的匹配码，点击 **“允许连接”**，再告诉 Codex 已确认。插件检查成功后返回 `ready`。若浏览器还没登录 DSH，先通过 DSH 启动时打开的页面登录，再重开确认链接。首次 DSH 登录仍需要完成，但不需要把登录链接复制给 Codex。
5. 需要指定模型时，先让 Codex 用 `includeModels: true` 调用 `dsh_status`，从返回目录复制精确的 `provider`、`model` 和可选 `reasoningEffort`，然后用自然语言委派，例如：

   > 把这个边界明确的任务交给 DSH，使用 deepseek-official/deepseek-v4-flash（effort low）；你负责检查完整 diff 和验收。

6. 路由验收：`dsh_task` 分别返回 `modelRouting.requested`、`configured` 和由真实 request/header 观察到的 `actualRequest`。显式指定模型的 completed 任务必须有精确匹配的实际 header；缺失或不匹配不会静默回退、不会报告成功。

## 环境

- Node.js 22.13+（支持 22 LTS 和 24+）
- npm
- 已在本机回环地址启动的 DSH；默认地址为 `http://127.0.0.1:3080`
- Web 首次登录使用 DSH 启动时的本机页面；桌面端使用客户端授权入口

Web 浏览器配对与可选的 Session 模型固定都需要把随插件分发的 DSH companion 安装到 Codex 实际连接的同一个 DSH profile。companion 目录已包含在 marketplace 安装的插件根目录中，普通使用者直接指向已安装插件根目录下的 `dsh-companion` 即可，不需要克隆仓库或运行 npm 构建；仓库开发者也可以使用仓库内路径：

```bash
dsh plugin --profile web add -w "/absolute/path/to/installed-plugin/dsh-companion"
```

安装后重启该 profile。桌面端通过客户端插件管理安装，已验证组合为 Desktop 0.2.1-rc.2 / Cordis 4.0.5。它不会修改 DSH 的共享默认模型。Web 兼容性门禁针对 `@deepseek-ai/dsh` 0.1.5-rc.1、其实际加载的 `dsh-agent`/Session Controller/Connection 0.1.5-rc.2 和 Cordis 4.0.2；其他组合必须重新运行隔离主机探针。

## 构建

```bash
npm ci
npm run build
```

构建会把 MCP 服务和连接入口连同 npm 运行依赖打包为：

```text
plugins/codex-subagent-dsh/runtime/server.mjs
plugins/codex-subagent-dsh/runtime/connect.mjs
```

完整开发检查使用 Node 22.13+：

```bash
npm run check
```

插件清单位于 `plugins/codex-subagent-dsh/.codex-plugin/plugin.json`，MCP 配置使用插件根目录相对路径启动 `runtime/server.mjs`。本机 marketplace 安装快照、新桌面对话的直接调用，以及隔离 Codex 配置从 GitHub 来源安装均已验证。

## 从 GitHub 安装

仓库已经提交可运行的 `runtime/*.mjs`，普通使用者不需要安装 npm 依赖或在本地构建：

```bash
codex plugin marketplace add aototo/codex-subagent-dsh --ref main
codex plugin add codex-subagent-dsh@codex-subagent-dsh
```

安装后开启新 Codex 对话加载插件。当前实测基于 Codex 桌面应用内置 CLI；精确最低 Codex 版本仍未确定，见[兼容性记录](docs/COMPATIBILITY.md)。

更新 GitHub marketplace 和插件后运行：

```bash
codex plugin marketplace upgrade codex-subagent-dsh
codex plugin add codex-subagent-dsh@codex-subagent-dsh
```

卸载插件及 marketplace：

```bash
codex plugin remove codex-subagent-dsh@codex-subagent-dsh
codex plugin marketplace remove codex-subagent-dsh
```

本地开发时先运行 `npm ci && npm run build`，再使用 `codex plugin marketplace add /absolute/path/to/codex-subagent-dsh` 安装仓库目录。修改插件后需更新清单 cachebuster 并重新安装，不能只修改源码后假定缓存已更新。

## Web 首次连接

在 Codex 中说 **“连接我的 DSH”**。`dsh_status` 只检查状态，不会自动打开网页。

- DSH 未启动：先启动显示地址上的 DSH。
- companion 缺失或过旧：先在对应 profile 安装/升级本插件附带的 companion，再安全重启。
- 需要认证：`dsh_connect` 的 `start` 打开确认页；自动打开失败时可以点击返回的确认链接。页面和 Codex 显示相同匹配码。
- 用户允许后：告诉 Codex 已确认，调用 `dsh_connect` 的 `check`；只有实际 API 验证及凭证保存成功才返回 `ready`。
- 拒绝/过期：本次配对结束，不自动重试。`cancel` 可取消本次配对。

浏览器配对目前支持 HTTP 的 `127.0.0.1`、`localhost` 和 `[::1]`，默认使用 `http://127.0.0.1:3080`；不支持 HTTPS 或反向代理配对。

配对页面复用浏览器已登录的 DSH 身份，不会自动登录，也不会代替用户点击确认。确认授予插件访问当前 DSH 的能力；文件、Shell 等操作仍由 DSH 权限策略管理。本版复用已有 DSH 登录 Cookie 的有效期，尚不是可独立撤销或按任务限权的专用凭证。删除插件本地凭证不等于服务端撤销已复制的 Cookie。

领取凭据只保存在插件运行时内存，不会出现在对话、URL 或确认页。配对有效期为 5 分钟；尚未完成的配对在关闭 Codex 或插件重启后需要重新发起。已保存且仍有效的连接凭证可继续使用。不要把登录链接、token 或 Cookie 发到聊天里。

兼容回退：没有配对 companion 时，仍可在本地终端执行 `dsh_status` 返回的完整 `connectCommand`，按提示粘贴 DSH 登录链接。正常浏览器配对流程无需执行此命令。插件不会自动安装或重启 DSH。

## 使用方式

插件公开五个工具：

| 工具 | 用途 |
| --- | --- |
| `dsh_status` | 区分 DSH 未启动、需要认证和已就绪；`includeModels: true` 会通过 companion 返回净化后的 provider/model/effort 目录 |
| `dsh_connect` | Web 发起、检查或取消浏览器配对；Desktop 返回客户端授权指引并检查连接。用户亲自确认，凭证由运行时处理 |
| `dsh_submit` | 提交一个边界明确的任务，返回 taskId；可选 `modelSelection` 在首个 prompt 前固定该 Session 的精确 route；相同请求不会重复派发 |
| `dsh_task` | 查询指定任务的状态、结果，或进行有界等待；检测到等待授权结果时提前返回，等待超时不取消任务 |
| `dsh_cancel` | 请求取消指定任务；请求被接受不等于已停止，也不回滚文件修改 |

通常直接告诉 Codex：

> 把这个边界明确的小任务交给 DSH，你负责检查完整 diff 和运行关键测试。

多个 Codex 对话共用一个已运行的 DSH 实例，每个委派任务创建独立 Session。首次连接完成后，各 MCP 进程复用凭证。主 Agent 会在当前对话首次委派时创建并后续复用一个 `conversationKey`。它只是逻辑分组标签，不是安全身份。只读模式也是任务约束，不代表操作系统级只读隔离。

写任务只支持主 Agent 已准备并核对基线提交的 Git linked worktree。DSH 返回完成后，主 Agent 仍需独立检查实际产物；取消请求不回滚已经发生的修改。

需要指定模型时，先调用 `dsh_status` 并传 `includeModels: true`，从返回目录复制精确的 `provider`、`model` 和可选 `reasoningEffort`。不要根据任务关键词猜 route。`modelSelection` 一旦为该 Session 持久化便不可更改，且参与幂等参数哈希；配置、能力或持久化确认失败时不会发送首个 prompt。未传 `modelSelection` 时保持原有默认路由行为。

`dsh_task` 将 `requested`、`configured` 与真实 `request/header` 观察到的 `actualRequest` 分开返回。显式指定模型的 completed 任务必须有匹配的真实 header；不匹配或缺失时不会静默回退并报告成功。

## 故障排查

- `node` 找不到或版本过低：确认 `node --version` 至少为 22.13，然后重新构建。
- DSH 未启动：`dsh_status` 返回 `dsh_not_running`；先启动返回地址对应的 DSH，再检查状态。
- 未连接或认证失效：按 `dsh_status` 指引使用 `dsh_connect`；Web 完成浏览器配对，Desktop 在客户端“Codex 连接”中重新授权。`connectCommand` 仅作 Web 兼容回退。
- `runtime/server.mjs` 不存在：运行 `npm ci && npm run build`。
- 任务为 `waiting_permission`：插件从连续事件中观察到仍未决定的授权申请；请按返回的 sessionId 打开 DSH 会话检查。处理后继续查询原任务，授权拒绝本身不等于任务失败。插件不会代替用户授权，原任务超时仍继续计时。
- 任务长时间保持 `running`：普通用户提问及缺少可识别授权事件的等待仍可能显示 running，请到 DSH 检查。
- 任务为 `unknown`：使用原 taskId 和 conversationKey 再调用 `dsh_task`，插件会有界读取原会话核对终态；不会创建或重派任务。证据不足时仍保持 unknown，请到 DSH 和工作区核对，写任务占用不会提前释放。
- 取消后仍显示 `cancel_requested`：这只表示停止请求已发送，必须等到可确认的终止状态；已产生的文件修改不会自动恢复。
- Codex 找不到工具：确认插件已安装并启用，更新后开启新对话加载工具；再核对构建产物和清单，参见 `docs/COMPATIBILITY.md`。
- `MODEL_ROUTING_COMPANION_MISSING`：Web 把 bundled companion 安装到实际连接的 profile 并安全重启；Desktop 通过客户端安装启用 companion 0.4.1，再检查模型目录；不要用 `session/selectModel` 代替，它会写共享默认模型。
- `MODEL_ROUTING_CAPABILITY_UNSUPPORTED` 或模型配置失败：用 `dsh_status { includeModels: true }` 重新读取目录，并核对精确 provider/model/effort；插件不会自动换模型。

## 当前限制

- GitHub marketplace 的隔离配置安装已验证，Git 来源的更新与卸载回归尚未完成；本地 marketplace 中的新对话工具发现和只读任务已验证，关闭测试窗口的生命周期边界已验证；整个应用正常退出并重开已验证；崩溃尚未验证。
- 每个任务使用独立 DSH Session；不支持继续原会话返工或任务列表。支持查询时按需恢复已证实的终态与结果，不支持后台自动恢复或运行中任务接管。
- Codex/MCP 进程退出后，插件不保证继续计时、自动取消或唤醒对话。
- 授权等待识别只适用于在线、连续且关联到本任务的事件；400ms 合并窗口用于抑制即时决定，不保证浏览器已显示人工审批框。普通用户输入等待不识别，断线或重启后的旧申请不会被还原成当前等待。关闭 Codex 后不保证主动提醒。
- 等待授权功能的隔离服务与自动化验证见[验证记录](docs/APPROVAL_WAIT_VERIFICATION.md)；浏览器人工审批验收状态以该记录为准。
- 无法确认终态时返回 `unknown`，不会自动重发。按需恢复要求完整连续历史、原任务关联和一致的空闲/空队列证据；DSH 返回的历史快照若已截断，本版本不会分页补齐。恢复结果超过 65,536 个字符上限或快照超过传输大小上限时，也会保留 unknown。
- 仅允许回环地址；不支持跨机器 DSH。
- 这是 Codex 调用外部 DSH 的社区 MCP 插件，不是 Codex 原生子 Agent 后端。

版本与参考来源见 [兼容性记录](docs/COMPATIBILITY.md)。

## 开发验证

`npm run check` 执行类型检查、可分发构建与自动化测试。以下隔离探针还会启动临时 DSH profile、安装 companion 与 synthetic adapter、验证鉴权、双 Session 隔离、默认 Session 不受影响、冷重启恢复、真实 request header，以及 bundled MCP 的 `dsh_submit`→`dsh_task` 完整链路：

```bash
DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/probe-dsh-companion.mjs
```

授权事件与 bundled MCP 状态链路使用另一隔离探针验证：

```bash
DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/probe-dsh-approval.mjs
```

synthetic adapter 只证明路由机制，不证明某个外部 provider 或商业模型在当前用户配置中可用。

完成首次连接后，以下命令会向真实 DSH 提交一次受限任务：

```bash
npm run smoke -- text
npm run smoke -- read
```

脚本打印 taskId / sessionId，以返回报告中的准确标记和文件实际内容验收。DSH 可能附带说明，本插件不保证纯文本严格格式输出。两分钟未完成会请求取消；无法确认的任务保留 unknown，不自动重试。临时测试目录保留供核查，避免删除仍被 DSH Session 引用的工作区。

公开验证摘要见 [验证记录](docs/VERIFICATION.md)。
