# 兼容性与来源记录

记录日期：2026-09-20。本文记录源码、本机安装和 CLI 调用结果；不代表已经完成 GitHub 来源的更新、卸载或桌面端完整验收。

## 运行与构建基线

| 项目 | 当前约定或实测 |
| --- | --- |
| Node.js | 要求 `>=22.13.0 <23 || >=24`；本机实测 `v22.22.2` |
| npm | 本机实测 `10.9.7` |
| TypeScript | 锁文件版本 `5.9.3` |
| esbuild | 锁文件版本 `0.28.2` |
| MCP SDK | 锁文件版本 `1.30.0` |
| ws | 锁文件版本 `8.21.3` |
| zod | 锁文件版本 `4.6.5` |
| DSH 地址 | 首版仅允许回环地址，默认 `http://127.0.0.1:3080` |

构建产物为 ESM。npm 运行依赖被打包进 `server.mjs` 和 `connect.mjs`，Node 内置模块保持 external；构建头通过 `createRequire(import.meta.url)` 兼容 `ws` 等依赖中的 CommonJS `require` 路径。产物不依赖作者机器的绝对路径。

## Codex 插件路径检查

本机 Codex CLI 为 `0.150.1`；桌面应用内置 CLI 为 `0.155.0-alpha.9`。此前 P0 临时配置实测只有桌面内置 CLI 完成了 Astra 的真实 MCP 工具调用，PATH 上的 `0.150.1` 被服务端要求升级。这些结果不足以推导精确最低版本。

本机已安装并启用的 bundled `computer-use` 插件在 `.mcp.json` 中使用：

```json
{
  "command": "./bin/computer-use-client-launcher",
  "args": ["mcp"],
  "cwd": "."
}
```

这表明当前 Codex 插件快照支持以 `cwd: "."` 配合插件根目录相对命令。未找到可证实的 Codex 插件根目录环境变量，因此本项目没有猜测或使用 `CLAUDE_PLUGIN_ROOT` 一类变量，而是采用 `command: "node"`、`args: ["./runtime/server.mjs"]`、`cwd: "."`。

本机已通过 repo-local marketplace 安装 0.1.0 快照，并由桌面内置 CLI 成功调用 `dsh_status`，验证社区插件中的同一相对路径解析。首次调用返回 AUTH_REQUIRED；用户完成连接后已复测 connected=true，且真实文本/读取任务通过；未临时注入 mcp_servers 配置。新桌面对话的直接调用已由用户提供的报告和本地任务记录交叉核对；其他用户环境仍未验证。

## DSH 协议边界

等待授权增量已在 DSH、`dsh-user-approval`、`dsh-api-session-controller`
`0.1.5-rc.2` 的隔离主机验证真实审计事件和 bundled MCP 链路。在线连续事件可报告
`waiting_permission`；不依赖新增 companion 接口，也不恢复断线后的活跃等待。
浏览器人工验收及发布状态见[授权验证记录](APPROVAL_WAIT_VERIFICATION.md)。

当前实现面向已实测的 DSH Web 协议：斜线路径 RPC（例如 `/api/session/create`）、`payload.args.request` 参数包装，以及 `/api/remote.mux` 上的 `session/follow`。首次连接需要 DSH 启动登录链接，并通过本地入口换取 Cookie；只配置地址不足以完成认证。

凭证失效时必须重新连接。插件不读取浏览器 Cookie或服务端签名密钥，不自动重启 DSH，也不会自动重发结果未知的任务。

可选的 Session 模型固定需要同仓库的 DSH companion。当前兼容性门禁覆盖顶层
`@deepseek-ai/dsh@0.1.5-rc.1`、实际解析到的 `dsh-agent`、
`dsh-api-session-controller`、`dsh-client-connection` 0.1.5-rc.2 和 Cordis
4.0.2。companion 在现有 `/api` carrier 下注册
`/api/codex-session-model/<operation>` 精确 Fetch 路由，因此继续复用 Host、Origin
和浏览器 Cookie 鉴权，不创建旁路凭证。固定配置通过带
`codexSessionModelRouting` 命名空间标记的官方 `model/selection` Session 事件持久化，
并在返回成功前等待 Session flush；普通 UI 模型选择不会被当成 bridge 所有的固定配置。
它只覆写目标 Agent 的 prompt assembly 和 request，不调用会保存共享默认值的
`session/selectModel`。

## 官方参考

只读检查的上游为 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)：

- `master` / `HEAD`：`ddefc45fbc7f8e46dd73185e68295696d1297887`
- 参考包：`packages/subagent/subagent-codex`
- 参考包版本：`0.1.6-alpha.2`
- 仓库和该包声明许可证：MIT，Copyright (c) 2026 DeepSeek

上游包实现 DSH 调用 Codex，本项目实现 Codex 调用 DSH。这里只借鉴 provider 分层、一次性子上下文、任务生命周期和显式失败状态等设计模式，没有复制上游实现或复用其 app-server 协议。

## 尚未验证

- 0.2.0 尚未发布到 GitHub marketplace；此前 Git 来源验证属于 0.1.1。0.2.0 的桌面新对话工具发现与显式模型委派为用户报告，维护者尚未独立复现；GitHub 全新安装、更新、卸载和其他用户环境仍待验证
- GitHub marketplace 已在隔离 Codex 配置中完成首次安装；Git 来源的更新、卸载和其他用户环境仍待验证
- 新桌面对话中的取消、权限/输入等待等交互（直接调用插件的只读任务已通过；真实文本、读取与 CLI 派发的写任务也已通过）
- 崩溃时的运行中任务行为；正常关闭窗口及整个应用退出并重开的边界已验证：MCP 退出、插件任务 unknown、DSH 继续执行。跨进程取消与按需恢复的公开结果见[验证记录](VERIFICATION.md)
- 权限等待、输入等待和取消的完整产品路径
- 干净用户配置及其他操作系统上的安装运行

## 按需恢复增量

在退出测试暴露状态不回写后，增加 dsh_task 对原任务的有界只读核对。已独立通过分发产物恢复真实历史 completed/result 和 cancelled，两者 Session 与 attempt 均保持不变。另一次真实测试确认：关闭拥有任务的 MCP 后，运行中任务保持 unknown；新 MCP 请求取消后，再查询可恢复 cancelled，DSH 空闲、队列为空、测试目录无修改。

按需恢复不等于后台接管。原任务仍运行、快照被截断、事件不连续、请求或回合不匹配、队列非空、投影落后时仍保留 unknown。当前只恢复 completed（有有效结果）与有取消意图的 aborted→cancelled；其他结束原因保守保留 unknown。

恢复增量的本地验证快照版本为 `0.1.0+codex.20260919062647`；该阶段公开清单版本为 `0.1.1`。当前仓库清单和 companion 包版本已统一为 `0.2.0`，加入可选 Session 模型固定和模型目录发现。类型检查、构建与 74 项自动化测试通过；插件清单和技能校验结果见[验证记录](VERIFICATION.md)。`dsh_status` 保留未启动、待认证和就绪三态诊断，待认证时返回实际安装路径对应的连接命令；`includeModels: true` 只在就绪后请求净化后的 companion 目录。已有对话的 MCP 可能仍运行旧快照，使用新对话加载更新版本。

## Session 模型固定的隔离主机门禁

仓库中的 `probe-session-model-hooks.mjs` 使用 DSH 导出的
`installModelSelection` 和真实 Cordis hook 验证 prompt assembly/request 优先级。
`probe-dsh-companion.mjs` 使用临时 `DSH_HOME`、随机端口、隔离 profile 和合成 adapter，
验证未认证请求返回 401、A/B 两个 Session 并发固定不同模型与 effort、冷重启恢复、
未固定 Session C 继续使用隔离 profile 的第三个默认模型、所有实际请求 header 精确匹配，
且共享默认值在请求前后不变。相同探针还通过打包后的 MCP runtime 完成一次
`dsh_submit(modelSelection)`，并核对 requested/configured/actualRequest 三份证据。

探针中的模型和 adapter 都是测试夹具。它证明 host API、鉴权、持久化、hook、事件顺序
和 bridge envelope 的组合行为，不证明任何外部 provider 或生产模型当前可用。
