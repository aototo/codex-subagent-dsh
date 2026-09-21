# 等待授权识别验证记录

日期：2026-09-21。基线：`63334fd78e13052216cd99d7a0bf3af75a0a7322`。
开发分支：`feature/approval-wait`。本地未发布，已安装的 GitHub 插件快照未更新。

## 实现

- 使用既有 Session 事件流匹配 `approval/asked` 与 `approval/decided`；无需新增工具或 companion 接口。
- 仅当前任务的在线连续事件可建立等待状态。400ms 合并窗口后仍待决定时返回 `waiting_permission`，`dsh_task(waitMs)` 提前返回。
- 对外仅状态、既有会话 ID 和固定处理提示；不返回原始 reason、工具参数或命令。内存审计集合最多 1024 个请求 ID，单个 ID、工具名及可选 callId 最长 256 个字符；超限转为 unknown，不静默丢弃。
- 所有决定均只结束对应审批等待，拒绝不直接判任务失败。取消优先，任务截止时间不延长。断线、退出与未确认终态仍走 unknown/按需核验。
- 恢复终态时同样检查授权配对，防止在线发现悬空审批后，又被历史恢复错误标为完成。

## 自动化证据

`npm run check`：类型检查、分发产物构建和 **106 项测试通过**。

其中新增 29 项 manager 行为测试、3 项恢复测试，覆盖持续等待及早返、四种授权结果、即时决定、多请求、同序号重放、重复/冲突决定、事件缺口、归属不明、请求数上限、敏感 reason、取消/截止时间、跨 manager 取消、断线/重启、终态竞态及模型路由。

独立审核发现新序号重复 `turn/start` 会覆盖等待状态，已修复并通过回归。相同序号的传输重放仍幂等忽略；新的第二次回合开始被视为任务归属异常。

## 隔离真实主机证据

命令：

```bash
DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/probe-dsh-approval.mjs
```

本机实测顶层 DSH、`dsh-user-approval`、`dsh-api-session-controller` 均为 **0.1.5-rc.2**。探针使用临时 `DSH_HOME`、随机回环端口、测试模型 adapter 和受控 answerer；审批审计事件由真实 `approval.request()` 服务产生，不手工伪造。

| 场景 | 实测结果 |
| --- | --- |
| 延迟允许/拒绝 | live asked/decided ID 配对；结果 allowed-once/rejected |
| AbortSignal 取消 | 真实决定 cancelled |
| never 策略 | 真实决定 rejected |
| answerer 抛错 | 真实决定 unavailable；此项不声称覆盖所有“没有处理器”配置 |
| 等待期间重新订阅 | 可读到尚未配对的 asked；只是快照观察，不据此恢复活跃任务 |
| 完成后快照 | 保留真实配对事件；snapshot cursor 与 projection cursor 一致 |
| bundled MCP 两任务并行 | 两个 Session 均提前返回 waiting_permission；一次测量总耗时 608ms，等待预算 10s；此值不是性能保证 |
| bundled MCP 允许/拒绝后继续 | 两个任务均 completed，requested/configured/actualRequest 模型证据一致 |
| bundled MCP 显式取消 | 真实授权决定 cancelled，任务终态 cancelled |
| 等待期间隔离 DSH 被 SIGKILL 终止 | 任务转 unknown，attempt=1；不残留等待状态、不重派 |

自动探针在 finally 中关闭 MCP、WebSocket 与隔离 DSH，移除临时数据。没有调用付费模型，没有修改共享 DSH 的默认权限、配置或会话。

主代理已独立重跑完整自动探针通过：五种授权结果、双任务早返（607ms）、模型证据、取消及真实断线。探针处理 SIGINT/SIGTERM，并为 HTTP 和 MCP 调用设置时间界限。

人工验收入口（macOS）：

```bash
DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh node scripts/probe-dsh-approval.mjs --manual
```

它会打开隔离网页，页面加载后在探针终端输入 `ready`，依次按提示在网页选择允许一次和拒绝；只调用真实授权服务，不执行文件写入或 Shell 命令。登录链接仅在进程内传给浏览器，不打印凭证。每一步最长等待五分钟，可按 Ctrl+C 清理退出。

## P4 人工浏览器验收（通过）

用户在真实 DSH 网页操作，主代理核对真实审批审计结果及 bundled MCP 终态：

| 操作 | Session | 实际结果 | 任务状态 |
| --- | --- | --- | --- |
| 允许一次 | `session-260ea0bc-fe71-4a61-a8a1-ac7e66225c86` | `allowed-once` | `completed` |
| 拒绝 | `session-3f4e6efd-1c21-4c5f-9c79-4bc4dc671133` | `rejected` | `completed` |

两项操作前，插件均已返回 `waiting_permission`。拒绝后 completed 表示测试夹具处理完拒绝结果并结束，不表示被拒绝的操作获准执行；夹具没有执行命令或写入工作区文件。

人工过程暴露会话入口问题：测试会话位于左侧折叠的“未分组”中，需要展开并选择标有“等待审批”的会话。允许项已通过；随后拒绝项因等待超时/测试进程退出未完成，因此用 `--manual-reject` 单独重试，最终核对成功。中间浏览器工具曾被其他插件缺失的 hook 文件阻断，不计为授权链路通过证据。

最终拒绝探针退出码为 0，已完成 finally 清理。旧测试页面随隔离实例退出失效。

## 0.3.0 发布准备验证

- 版本化构建再次通过类型检查、构建和 106 项测试；根 package、锁文件、插件清单及 MCP server 均为 0.3.0。
- 用临时 Codex 配置从本地 marketplace 安装 0.3.0，安装清单版本正确；server、connect 及委派技能与仓库产物 SHA-256 一致。临时配置已清理，用户当前安装未改变。
- 独立最终审核未发现阻断项；companion 仍为 0.2.0，无协议或实现改动。

## 发布与能力边界

- GitHub 安装快照的更新与新 Codex 对话加载。本轮未发布，不能把本地 bundle 验证视为已安装版本生效。
- 该状态表示有授权请求等待结果，不证明浏览器一定已渲染可点击的审批框；普通用户问题、后台唤醒和断线后的活跃审批接管均不在首版范围内。

本地功能验收已通过；发布、安装更新验收独立于本次结果。计划见 [APPROVAL_WAIT_PLAN.md](APPROVAL_WAIT_PLAN.md)。
