# 验证记录

记录日期：2026-09-20。

## 已验证

- `npm run check`：TypeScript 类型检查、可分发构建和 62 项自动化测试通过。
- 插件清单、MCP 配置与 `dsh-delegate` Skill 通过本地校验。
- 本地 marketplace 安装后，新 Codex 对话可以发现并调用四个 DSH 工具。
- 首次连接、认证失效提示、真实文本任务、真实文件读取和 Git linked worktree 写任务已通过。
- 用户输入等待、权限允许、权限拒绝、取消、关闭窗口和整个 Codex 应用正常退出后重开均完成真实路径验证。
- MCP owner 退出时，运行中的任务保持 `unknown`；插件没有误报完成或自动重发。
- 使用原 `taskId`、`conversationKey`、Session 和 attempt 的完整证据，可以按需恢复已完成结果或已取消终态。
- 安装缓存中的清单、Skill 和运行时产物与仓库构建结果一致。
- 隔离 Codex 配置成功从 GitHub `main` 获取 marketplace，并安装启用 `codex-subagent-dsh@codex-subagent-dsh` 版本 `0.1.1`；记录的 marketplace 来源类型为 Git，新运行时对真实 DSH 返回 `ready`。
- 状态诊断覆盖 DSH 未启动、DSH 已启动但需要认证、连接就绪三种情况；认证状态返回安装目录中的准确连接命令。

## 验证边界

- 自动化集成测试使用本地 HTTP/WS 模拟 DSH；真实模型任务另行人工验收。
- 尚未完成 GitHub marketplace 的更新、卸载和其他用户环境回归。
- 尚未验证宿主或 DSH 崩溃、历史快照分页、跨机器运行和其他操作系统。
- 插件无法可靠区分正常执行与等待权限或用户输入，阻塞时需要到 DSH 查看。
- Codex/MCP 进程退出后不会后台接管任务、恢复原超时或主动唤醒对话。
- `unknown` 不会触发自动重派；证据不足时必须人工核对。

DSH 返回完成只表示执行结束。主 Codex Agent 仍需检查实际文件、完整 diff 和关键测试后才能验收。
