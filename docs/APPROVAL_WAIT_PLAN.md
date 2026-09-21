# DSH 等待授权状态识别：计划与调研

日期：2026-09-21。状态：P1 真实服务传输门禁、P2 实现及 P3 自动化已通过；P4 人工浏览器允许/拒绝验收已通过；尚未发布。

## 目标与范围

让 Codex 查询或等待 DSH 任务时，能够知道任务正在等待授权结果，及时提示用户去对应 DSH 会话处理，避免只显示 `running`。

计划调研已完成，本轮获用户授权实施。第一版仅观察授权事件，不代替用户批准或拒绝，不改变会话或全局权限，不处理普通提问的 `waiting_input`，不增加后台通知服务。保持现有任务超时、取消、模型路由和重启恢复边界。

代码基线：`origin/main`，`63334fd78e13052216cd99d7a0bf3af75a0a7322`。已 fetch，并从该提交创建 `docs/approval-wait-plan` 独立 worktree；首次写入前 HEAD 与基线一致。

实施时重新 fetch，远端 main 未变化；从同一提交另建 `feature/approval-wait` 独立 worktree，首次修改前再次核对 HEAD。原 main 工作区保持干净。

## 已确认的证据

### 本机 DSH 契约

计划调研时检查对象为 `@deepseek-ai/dsh@0.1.5-rc.1`，授权模块 `@deepseek-ai/dsh-user-approval@0.1.5-rc.2`。以下是安装产物的源码结论，不等同实际运行验收。

| 位置（相对 DSH 安装目录） | 发现 | 对方案的影响 |
| --- | --- | --- |
| `node_modules/@deepseek-ai/dsh-user-approval/lib/index.js`，`ApprovalService.request/decide` | 在打开的 turn 中写入 `approval/asked`，等待决定后写入 `approval/decided`；用相同 `id` 关联 | 可建立每个任务独立的待决定请求集合 |
| 同上 | asked 含 `id/toolName`，可选 `callId/reason`；本身不含 sessionId 或 turn | 必须结合订阅的 Session 和已确认属于本任务的 turn，不能仅匹配事件名字 |
| 同上 | 结果包括 `allowed-once/rejected/cancelled/unavailable`；`never` 也先写 asked，再自动 rejected | asked 不等于已弹出人工审批；拒绝也不等于整个任务失败 |
| `node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`，`SessionHistoryController.follow/pageRecords` | 按 Session 转发持久事件；快照和后续事件均未过滤 approval 类型；流检查序号连续性 | 首选现有 `session/follow`，预计不需新增 companion 接口，仍须真实传输验证 |

官方参考：[Approval 子系统说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md)。上游 master 会变化，兼容性以安装版本和验证记录为准。

2026-09-21 隔离实测重新核对：顶层 DSH、授权模块和 Session Controller 均为 `0.1.5-rc.2`。兼容性结果按此次版本记录。

### 基线插件缺口

- [types.ts](../src/types.ts)：已定义 `waiting_permission`，尚没有待授权请求摘要。
- [dsh-client.ts](../src/dsh-client.ts)：`parseWireEvent` 接受通用事件；`follow` 已透传后续事件，无需再建一条授权订阅。
- [task-manager.ts](../src/task-manager.ts)：`onEvent` 未处理 approval；`task(waitMs)` 只在终态提前返回，直接增加状态仍会让调用等满时间。
- 当前恢复逻辑重视完整历史、任务归属和明确终态；不能用旧 asked 记录宣称现在仍待人工处理。

## 实施阶段与门槛

### P0：源码调研（已完成）

核对授权事件、服务端传输、客户端解析和现有状态机。独立审核取消、超时、恢复及终态竞态。结论是实时识别具备源码基础，但尚未证明实际 MCP 用户体验。

### P1：隔离的真实 DSH 传输验证（已通过）

复用现有 [companion probe](../scripts/probe-dsh-companion.mjs) 的隔离方式：临时 `DSH_HOME`、独立端口、测试配置和 fake adapter。不得使用或修改用户共享 DSH 的权限、会话或默认模型。

1. 在真实 DSH host 创建测试 Session，先订阅再触发受控授权请求。
2. 使用测试 answerer 保持未决定，核对 asked 的实际包结构、Session/turn 归属、序号及实时到达。
3. 分别释放允许、拒绝、取消、无处理器和 `never` 场景，确认 decided 配对与后续任务行为。
4. 对照快照/分页能否读取审计事件；验证断线和服务退出后的证据边界。
5. 记录版本、去敏后的事件、顺序和结果；测试完成关闭测试进程、清理测试目录。启动链接、cookie、token 不得写入报告。

通过标准：真实 carrier 可观察到等待期间尚未决定的请求，并收到配对结果。测试 answerer 只证明服务及传输，不证明浏览器已显示审批框。失败则停止状态机实现，先定位缺失契约；不得用长时间无输出猜测授权等待。

### P2：最小实现（P1 通过后）

优先只改插件侧；不增加 MCP 工具，沿用 `dsh_task` 返回状态与处理提示。

- 为当前任务的连续、可信事件流维护 `pendingById`，记录有限的请求 id、工具名、事件序号与本地观察时间。
- 校验 approval 数据结构；仅接纳已确认的任务 Session/turn。重复事件幂等；缺失序号、矛盾配对或无法确认归属时，按现有不确定状态策略处理。
- 使用短暂合并窗口抑制即刻自动决定的瞬态，初始候选 300–500ms，以 P1 实测定值。它只是减少闪烁，不能证明一定需要人类操作。
- 对外语义明确为“等待授权结果”；指导语为“请打开对应 DSH 会话检查授权请求”，不保证浏览器一定存在可点按钮。
- `dsh_task(waitMs)` 看到确认的等待状态后提前返回；首版沿用 taskId、sessionId、state 和固定 guidance，后续再次查询可继续观察执行结果。技能应提示主 agent 向用户说明处理入口，避免自动反复轮询，更不能自动批准。
- 默认不暴露原始 reason、工具参数、命令、启动登录链接或凭证。pending 集合仅保留在 owner 内存；首版不承诺跨 MCP 实例可读取工具摘要或数量。如后续确需此能力，另设计有界、去敏、带新鲜度标记的持久化摘要。

建议状态转换：

| 当前情况 | 行为 |
| --- | --- |
| running，出现当前任务的 asked，合并窗口后仍未决定 | waiting_permission |
| waiting_permission，部分请求已决定 | 仍等待剩余请求 |
| waiting_permission，全部请求已决定 | 恢复 running，继续等待真实 turn/end |
| 任一 decided 为 rejected/cancelled/unavailable | 清除该请求；不单凭授权结果判整个任务失败或取消 |
| 已 cancel_requested | 不允许 asked/decided 恢复成 running；保留取消优先级 |
| 订阅断开、任务归属不确定或证据不完整 | 保持现有 unknown/恢复规则，不宣称当前仍在等待 |
| 收到 turn/end | 按现有终态核验；若尚有未配对请求，视作待解释的不一致，不直接完成 |
| 已在终态核验阶段或已终态 | 清理计时器；迟到事件不能把任务重新变成等待或运行 |

实现前确认状态更新与取消竞争的原子条件，避免异步合并计时器覆盖新状态。`deadlineAt` 仍是现有墙钟截止时间，不因授权等待自动延长。重复查询不得派发新任务或重复执行。

### P3：自动化与兼容性验证

预计涉及 `src/task-manager.ts`、状态输出及对应测试；可抽出小型 approval reducer 便于测试。`src/types.ts` 已有状态定义，数据库状态列为 text，首版无需数据库迁移。若后续扩展 task-store 格式，必须明确旧记录缺字段的兼容行为；持久化摘要不能作为重启后“仍在等待”的权威证据。

第一版不扩大恢复能力：进程重启或断线后的活跃任务仍按既有 unknown 策略处理；历史分页只服务现有可靠终态核验。日后若需要恢复活跃审批状态，应另验证可靠的 live pending 查询契约。

| 验证项 | 预期 |
| --- | --- |
| 持续 pending、允许后继续 | 返回等待并早返；允许后继续；任务完成仍通过原验收规则 |
| 拒绝后模型改用其他方式完成 | 不把授权拒绝等同任务失败 |
| never / 无 answerer / 即刻决定 | 不产生持续的误导性待人工提示 |
| 多请求交错、重复、乱序、未知 id | 集合正确，异常不被静默当作成功 |
| 两个 Session 并发 | 状态与摘要不串到另一任务 |
| 等待中取消、超时、决定与取消同时发生 | 保留取消/截止时间语义，无状态回退 |
| turn/end 与延迟回调竞争 | 终态不可被覆盖，无遗留计时器 |
| 断线、桥接重启、DSH 重启、截断历史 | 不用历史未配对 asked 宣称当前 live pending |
| 模型路由和原任务结果核验 | requested/configured/actual 检查与原行为保持一致 |
| 敏感 reason/参数、过长工具名、很多请求 | 对外仅固定提示，不泄漏原始内容；内部跟踪限制资源占用，超限不伪装正常 |

### P4：用户侧验收与文档

在专用测试 Session 中验收真实 DSH 浏览器审批：保持未处理时 Codex 返回等待；允许后任务继续；拒绝后正确观察后续行为。人工点击仅在确有浏览器请求时提示用户；自动测试不能替代这一步。

同步中英文 README、委派技能、兼容性说明和验证记录：说明查询时可识别的状态、去何处处理、超时仍继续计时，以及离线或 Codex 已关闭时不保证主动提醒。初始实施轮未提交、推送或发布。用户在人工验收通过后要求继续，进入发布准备：整理 0.3.0、核对完整分支 diff、测试与隔离安装，再创建 PR；合并和安装更新另行确认。

## 完成标准

功能只有在 P1 真实传输、P3 自动化和 P4 浏览器审批链路均通过后才能称为验收通过。实施证据及尚未完成的门槛持续记录于 [APPROVAL_WAIT_VERIFICATION.md](APPROVAL_WAIT_VERIFICATION.md)。
