# codex-subagent-dsh

`codex-subagent-dsh` 是一个社区 Codex 插件，通过本地 STDIO MCP 把边界明确的任务交给已运行的 DeepSeek Harness（DSH）。Codex 主 Agent 仍负责选择使用 DSH 还是 Codex 原生子 Agent，并负责检查文件、diff、测试与最终验收。

仓库同时提供 Codex marketplace 入口和可直接运行的插件产物。真实 DSH 文本、文件读取和隔离 worktree 修改均已通过；新桌面对话直接调用插件的只读任务也已通过。关闭窗口和整个应用正常退出均已验证：DSH 可继续执行，插件先保留 unknown。重开后可用原 taskId 和 conversationKey 调用 dsh_task，按完整证据恢复终态与结果；崩溃场景仍待验证。

## 环境

- Node.js 22.13+（支持 22 LTS 和 24+）
- npm
- 已在本机回环地址启动的 DSH；默认地址为 `http://127.0.0.1:3080`
- DSH 启动时生成的登录链接，用于首次本地连接

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

## 首次连接

通过 marketplace 安装后，在 Codex 中直接说：

> 检查 DSH 连接状态。

Codex 会调用 `dsh_status`：

- 如果 DSH 未启动，会明确提示先启动 DSH，并显示检查的本机地址。
- 如果 DSH 已启动但尚未认证，会给出包含实际安装目录的完整连接命令。
- 如果状态为 `ready`，可以直接派发任务。

首次认证时，把 Codex 返回的完整命令复制到本地终端执行，例如：

```bash
node <实际插件根目录>/runtime/connect.mjs
```

命令中的实际插件目录由插件自动解析，不需要运行 `codex plugin list` 手动查找。按终端提示输入 DSH 启动登录链接。登录链接和 token 不要粘贴到 Codex 对话、MCP 参数或项目文件中；连接入口只在本机处理并保存凭证。凭证失效时，`dsh_status` 会再次返回连接命令。插件不会安装、升级或重启 DSH。

## 使用方式

插件公开四个工具：

| 工具 | 用途 |
| --- | --- |
| `dsh_status` | 区分 DSH 未启动、需要认证和已就绪，并返回明确下一步；不查询具体任务状态 |
| `dsh_submit` | 提交一个边界明确的任务，返回 taskId；相同请求不会重复派发 |
| `dsh_task` | 查询指定任务的状态、结果，或进行有界等待；等待超时不取消任务 |
| `dsh_cancel` | 请求取消指定任务；请求被接受不等于已停止，也不回滚文件修改 |

通常直接告诉 Codex：

> 把这个边界明确的小任务交给 DSH，你负责检查完整 diff 和运行关键测试。

多个 Codex 对话共用一个已运行的 DSH 实例，每个委派任务创建独立 Session。首次连接完成后，各 MCP 进程复用凭证。主 Agent 会在当前对话首次委派时创建并后续复用一个 `conversationKey`。它只是逻辑分组标签，不是安全身份。只读模式也是任务约束，不代表操作系统级只读隔离。

写任务只支持主 Agent 已准备并核对基线提交的 Git linked worktree。DSH 返回完成后，主 Agent 仍需独立检查实际产物；取消请求不回滚已经发生的修改。

## 故障排查

- `node` 找不到或版本过低：确认 `node --version` 至少为 22.13，然后重新构建。
- DSH 未启动：`dsh_status` 返回 `dsh_not_running`；先启动返回地址对应的 DSH，再检查状态。
- 未连接或认证失效：`dsh_status` 返回 `authentication_required` 和完整 `connectCommand`；在本地终端运行该命令，不要把登录链接发给模型。
- `runtime/server.mjs` 不存在：运行 `npm ci && npm run build`。
- 任务长时间保持 `running`：当前版本无法可靠识别 DSH 是否正在等待权限或用户输入，状态可能继续显示 `running`。请到 DSH 查看并处理对应请求；插件不会代替用户授权或回答。
- 任务为 `unknown`：使用原 taskId 和 conversationKey 再调用 `dsh_task`，插件会有界读取原会话核对终态；不会创建或重派任务。证据不足时仍保持 unknown，请到 DSH 和工作区核对，写任务占用不会提前释放。
- 取消后仍显示 `cancel_requested`：这只表示停止请求已发送，必须等到可确认的终止状态；已产生的文件修改不会自动恢复。
- Codex 找不到工具：确认插件已安装并启用，更新后开启新对话加载工具；再核对构建产物和清单，参见 `docs/COMPATIBILITY.md`。

## 当前限制

- GitHub marketplace 的隔离配置安装已验证，Git 来源的更新与卸载回归尚未完成；本地 marketplace 中的新对话工具发现和只读任务已验证，关闭测试窗口的生命周期边界已验证；整个应用正常退出并重开已验证；崩溃尚未验证。
- 每个任务使用独立 DSH Session；不支持继续原会话返工或任务列表。支持查询时按需恢复已证实的终态与结果，不支持后台自动恢复或运行中任务接管。
- Codex/MCP 进程退出后，插件不保证继续计时、自动取消或唤醒对话。
- 插件无法可靠区分正常执行与等待 DSH 权限或用户输入；等待期间任务可能一直显示 `running`。
- 无法确认终态时返回 `unknown`，不会自动重发。按需恢复要求完整连续历史、原任务关联和一致的空闲/空队列证据；DSH 返回的历史快照若已截断，本版本不会分页补齐。恢复结果超过 65,536 个字符上限或快照超过传输大小上限时，也会保留 unknown。
- 仅允许回环地址；不支持跨机器 DSH。
- 这是 Codex 调用外部 DSH 的社区 MCP 插件，不是 Codex 原生子 Agent 后端。

版本与参考来源见 [兼容性记录](docs/COMPATIBILITY.md)。

## 开发验证

`npm run check` 执行类型检查、可分发构建与 62 项自动化测试。自动化集成测试使用本地 HTTP/WS 模拟 DSH，不代表真实模型任务已完成。

完成首次连接后，以下命令会向真实 DSH 提交一次受限任务：

```bash
npm run smoke -- text
npm run smoke -- read
```

脚本打印 taskId / sessionId，以返回报告中的准确标记和文件实际内容验收。DSH 可能附带说明，本插件不保证纯文本严格格式输出。两分钟未完成会请求取消；无法确认的任务保留 unknown，不自动重试。临时测试目录保留供核查，避免删除仍被 DSH Session 引用的工作区。

公开验证摘要见 [验证记录](docs/VERIFICATION.md)。
