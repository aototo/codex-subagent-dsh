# DSH Desktop 连接修复验收

日期：2026-10-21。修复基线：origin/main `425ebe2ca4f1ab75a1218349a0099998f7c23ac0`。

## 问题与修复边界

已安装 Codex 插件 0.4.0 默认连接 Web 的 3080；本机 DSH Desktop 0.2.1-rc.2 使用动态端口。桌面 profile 已安装并授权独立的 `@aotu/dsh-desktop-bridge` 0.1.0，产生私有发现文件及 origin 绑定凭证，但插件尚未读取发现文件。

修复复用该组件的用户授权，不启动或重启 DSH、不安装 companion、不改变共享默认模型。选定实例后绑定整个 MCP 进程；不自动切换执行中的任务。认证与协议失败不触发回退。新用户没有桌面桥接组件时，返回缺少授权/连接组件的提示，不宣称开箱支持。

## 修复前现场证据

- 默认地址的 `dsh_status` 返回 dsh_not_running。
- 桌面端口的未认证首页返回 401，浏览器配对 capabilities 返回 404；desktop profile 无 model-routing companion。
- 显式指定桌面地址并复用已有授权，隔离运行的原 0.4.0 插件返回 ready；模型目录返回 MODEL_ROUTING_COMPANION_MISSING。
- 原插件最小真实任务完成：taskId `f2c1e0cb-74dc-4e35-922b-94e4f5b42990`，sessionId `session-c84d5c0b-fbff-4e6b-b53f-ec02666b1ca1`；completed、attempt=1，结果 `DSH_DESKTOP_OK`。未显式指定模型，不作为模型路由验收。

## 修复后验证

- `npm run check`：类型检查、可分发构建与 150 项测试通过（0 失败）。新增配置优先级、发现文件安全检查、实例绑定、桌面 MCP 鉴权和缺失 metadata 诊断。
- 修复产物在未指定 URL/模式的隔离状态目录中自动发现当前 Desktop；`dsh_status` 返回 ready、connectionMode=desktop，`dsh_connect check` 返回 ready。
- 修复产物真实任务 taskId `a2694fac-f3d4-4aef-b890-8654af14f533`，sessionId `session-86b7e8fc-da9c-4088-aafd-a0537208a54d`：completed、attempt=1，返回 `DSH_DESKTOP_DISCOVERY_OK`。测试凭证副本已删除，原授权未修改。
- 重新使用锁文件安装真实依赖后构建，第三方许可证清单完整且与基线一致，产物未嵌入作者机器路径。独立审查发现的构建路径问题已修正。
- 本轮未更新用户正式安装、提交或推送。当前对话的已加载工具仍是原版。
- `npm ci`/`npm audit` 报告既有锁定依赖告警：MCP SDK 高危、传递依赖 hono 中危；本次未修改依赖或锁文件，升级及影响评估需另行处理。

## 限制

- 桌面重启换端口后，旧任务不能通过新 origin 自动恢复；必须先人工核对，不能因重新连接成功就重发未知任务。
- 桌面 bridge 是本机独立组件，未包含在本插件中，也不是 DSH 官方能力。
- 桌面版旧 companion 兼容性、显式模型选择、复杂工具任务与完整生命周期未在本轮验证。
- Web 连接依靠原回归测试覆盖；本轮不重启共享服务或更新用户安装。

## 双端实施增量（2026-10-21）

- 显式 `connectionMode: desktop` 的新构建，`dsh_status`/`dsh_connect check` 均 ready；capabilities.taskConnection=true、modelSelection=false（companion 缺失）。
- 真实 taskId `d147a83e-66ad-4128-924d-7145325859f7`，sessionId `session-4c2a7d11-76ac-4b63-9b59-e0171dabaa98`：completed、attempt=1、结果精确为 `DSH_DUAL_HOST_OK`。独立状态目录中的凭证副本已清理。
- 本次新增随附 `@aototo/codex-subagent-dsh-desktop-bridge`，不再只依赖旧本机组件。前文“未随插件提供”的描述只对应第一轮修复；新组件安装/UI验收和最终测试结果以 [双端计划](WEB_DESKTOP_PLAN.md) 为准。
