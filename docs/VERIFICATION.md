# 验证记录

记录日期：2026-09-20。

## 已验证

- `npm run check`：TypeScript 类型检查、可分发构建和 74 项自动化测试通过。
- 插件清单、MCP 配置与 `dsh-delegate` Skill 通过本地校验。
- 0.1.1 历史版本完成本地 marketplace 安装后，新 Codex 对话可以发现并调用四个 DSH 工具。
- 0.1.1 历史版本的首次连接、认证失效提示、真实文本任务、真实文件读取和 Git linked worktree 写任务已通过。
- 用户输入等待、权限允许、权限拒绝、取消、关闭窗口和整个 Codex 应用正常退出后重开均完成真实路径验证。
- MCP owner 退出时，运行中的任务保持 `unknown`；插件没有误报完成或自动重发。
- 使用原 `taskId`、`conversationKey`、Session 和 attempt 的完整证据，可以按需恢复已完成结果或已取消终态。
- 0.1.1 历史安装缓存中的清单、Skill 和运行时产物与当时仓库构建结果一致。
- 隔离 Codex 配置成功从 GitHub `main` 获取 marketplace，并安装启用 `codex-subagent-dsh@codex-subagent-dsh` 版本 `0.1.1`；记录的 marketplace 来源类型为 Git，新运行时对真实 DSH 返回 `ready`。
- 状态诊断覆盖 DSH 未启动、DSH 已启动但需要认证、连接就绪三种情况；认证状态返回安装目录中的准确连接命令。
- 官方 hook 探针使用实际安装的 `installModelSelection` 和 Cordis waterfall，验证 Session 级 prompt assembly 与 request 覆写优先级，以及未固定 Session 保持下游结果。
- 隔离 DSH 主机探针使用临时状态目录和随机端口，验证 companion 的未认证 401、认证后的能力发现与 set/get、A/B 并发隔离、冷重启恢复、Session C 未固定行为、共享默认值不变，以及 A/B/C 的实际 request header。
- 同一隔离主机探针通过打包后的 MCP runtime 完成一次 `dsh_submit(modelSelection)`，任务为 completed，`modelRouting.requested`、`configured` 和 `actualRequest` 三者精确一致。
- 当前兼容性门禁记录顶层 DSH 0.1.5-rc.1、实际加载的 agent/Session Controller/Connection 0.1.5-rc.2 和 Cordis 4.0.2；仓库与 companion 包版本一致为 0.2.0。

## 验证边界

- 当前 0.2.0 尚未发布到 GitHub marketplace。此前 marketplace 来源安装和生命周期验证属于 0.1.1 历史结果；本轮 0.2.0 本地验收见下节。
- 自动化集成测试使用本地 HTTP/WS 模拟 DSH；隔离主机探针使用真实 DSH host 和合成 adapter。另已通过下述 DeepSeek 实际 provider 验收；其他 provider/模型仍需分别验证，不能推断 GPT-5.6 Sol 等模型在 DSH 中可用。
- 尚未完成 GitHub marketplace 的更新、卸载和其他用户环境回归。
- 尚未验证宿主或 DSH 崩溃、历史快照分页、跨机器运行和其他操作系统。
- 插件无法可靠区分正常执行与等待权限或用户输入，阻塞时需要到 DSH 查看。
- Codex/MCP 进程退出后不会后台接管任务、恢复原超时或主动唤醒对话。
- `unknown` 不会触发自动重派；证据不足时必须人工核对。

DSH 返回完成只表示执行结束。主 Codex Agent 仍需检查实际文件、完整 diff 和关键测试后才能验收。

## 0.2.0 本地实际模型验收（2026-09-20）

- 已备份共享 web profile 配置，并将 companion 0.2.0 安装到固定本地目录。确认没有运行中任务后重启共享 DSH；既有连接凭证继续有效。
- 使用构建后的 MCP runtime，通过 `dsh_submit` 提交无工具调用的短文本任务，再通过 `dsh_task` 等待结果。
- 指定 `deepseek-official / deepseek-v4-flash / low`，任务 completed，返回随机标记匹配。requested、configured、actualRequest 三者精确一致，实际 request/header 序号为 12。
- 任务 ID：`828d569a-48f3-4be6-b07a-b99c52cbae9f`。共享默认模型仍为 `devin-proxy / devin/swe-2 / high`；任务执行前后 settings 文件 SHA-256 一致。
- 本次证明上述实际 provider 的会话模型覆盖闭环；不代表全部模型、其他用户环境或 GitHub 发布安装路径已验证。
- 本地 Codex marketplace 已安装并启用 0.2.0，旧 selector 已停用但来源与缓存保留。主代理直接启动安装缓存中的 MCP runtime，确认运行时版本 0.2.0、四工具齐全、`dsh_submit` 暴露模型参数，且状态为 ready、modelRouting.available 为 true。桌面新对话的工具发现仍需单独确认。
