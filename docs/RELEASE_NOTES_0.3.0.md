# 0.3.0 — Permission-wait detection / 等待授权识别

Release candidate. GitHub `main` supplies this version after the PR is merged;
no tag or GitHub Release is created by this change.

## 中文

此前 DSH 等待授权时，Codex 可能一直看到 `running`。现在插件通过当前任务的连续授权事件识别 `waiting_permission`，`dsh_task` 会提前返回会话 ID 和处理提示。请在 DSH 中处理请求，再查询原任务；如果侧边栏没有看到会话，展开“未分组”，查找“等待审批”。

- 允许、拒绝、取消或不可用的授权结果只结束对应等待；授权拒绝不直接等于整个任务失败。
- 不自动批准、不改权限、不重派任务；授权等待期间原截止时间继续计时。
- 400ms 合并窗口抑制即时决定；状态不保证浏览器已经渲染审批框。普通用户提问仍不识别，断线和重启不恢复活跃等待。
- 取消、终态和 unknown 不会被迟到的授权事件覆盖；不完整或冲突的授权历史不能恢复成完成。

无需数据库迁移或重新连接 DSH。companion 协议及代码保持 0.2.0，本次升级不要求重装或重启 companion。合并后更新 Codex 插件并开启新对话，确认加载 0.3.0；旧对话可能继续运行旧快照。

## English

Tasks blocked on DSH authorization previously continued to report `running`.
Correlated live approval events now establish `waiting_permission`, causing
`dsh_task` to return early with the existing session ID and a fixed action hint.
Handle the request in DSH and query the same task again. Expand “Ungrouped” in
the sidebar if the pending session is hidden.

Approval decisions resolve the corresponding wait without deciding the whole
task's outcome. Cancellation keeps priority, deadlines continue, and conflicting
or incomplete audit history cannot establish completion. No automatic approval,
permission change, task resubmission, schema migration, or credential change is
introduced. Ordinary input waits and live approval recovery after disconnect
remain unsupported. The 400ms settling window does not prove a browser dialog
is visible.

The bundled companion remains at 0.2.0 with the same protocol and implementation;
this update does not require reinstalling or restarting it. After merge, update
the Codex plugin and open a new conversation to load 0.3.0. Existing conversations
may retain the previous runtime.

## Validation

- 106 automated tests, type checking, and the versioned distributable build passed.
- Isolated local-marketplace installation reports 0.3.0, with runtime and skill
  hashes matching the repository artifacts; the user installation is unchanged.
- Real isolated DSH 0.1.5-rc.2: five approval outcomes/scenarios, live and snapshot
  pairing, two concurrent MCP tasks returning early, model evidence, cancellation,
  and host termination preserving unknown with attempt=1.
- Real browser: user allowed once and rejected; both decisions were verified
  from approval audit events and MCP terminal states. The fixture runs no shell
  commands or workspace writes.

Detailed evidence and installation status: [verification record](APPROVAL_WAIT_VERIFICATION.md).
