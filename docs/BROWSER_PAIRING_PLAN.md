# 浏览器确认连接计划

## 目标与本轮范围

让用户在 Codex 中说“连接 DSH”，在已登录的本地 DSH 页面确认一次后完成连接，无需运行 node 命令或复制登录链接。继续共用用户现有 DSH 实例。

用户已选择此方向。本轮先完成源码调研、隔离协议可行性探针和实施计划；不更新正在使用的插件、不重启共享 DSH、不发布代码。后续实现必须通过下述门禁。

基线：2026-09-21 fetch 后的 origin/main，`f643509012535888b2f599ffd47b49b1ab5dd93a`。工作分支 `feat/browser-pairing`，首次修改前 HEAD 已确认等于基线。

## 用户流程

1. 用户安装 Codex 插件，启动本机 DSH。
2. 用户对 Codex 说“连接我的 DSH”。插件先检查是否已经连接。
3. 已连接直接返回 ready；DSH 未运行提示启动；companion 缺失或过旧时说明需要安装/升级及重启，不能伪装成认证错误。
4. 未连接时由显式连接工具创建一次配对，打开 DSH 同源确认页面；自动打开失败时提供不含凭证的确认页面链接。
5. 页面显示请求来源标签、本机 DSH 地址、匹配码、授权范围、有效期，以及“允许连接”“拒绝”。来源标签不是可信身份保证，用户应核对 Codex 显示的匹配码。
6. 用户在已登录 DSH 的浏览器确认。插件通过本次私有领取凭据取得连接凭证并保存，实际认证请求成功后才返回 ready。
7. 用户未确认、拒绝、过期或关掉页面时，分别保持待确认、返回拒绝、返回过期；关闭页面本身不能认定拒绝。

浏览器没有 DSH 登录态时，先明确提示登录 DSH；不能承诺新浏览器、清空 Cookie 后仍能无登录完成。新增能力消除的是“把 DSH 登录链接再次复制到 Codex 终端”这一步。

## 技术路径与认证边界

- 现有 companion 已通过 `connection.fetch.register` 注册受保护的 `/api` 路由。
- DSH `HostConnectionService.requestRejection` 提供原生 Host/Origin 与 Cookie 验证；`webServer.register` 支持 companion 页面和引导路由。
- 配对发起者尚未认证，不能把 begin/claim 放进必须先登录的原生 `/api` 栅栏；应提供最小化、严格限制的独立引导端点。它们只管理短期配对记录，不提供 DSH Session、文件或模型数据。
- 批准/拒绝使用已登录浏览器的同源 POST，并复用原生认证栅栏。仅 GET 确认页绝不授予访问。
- 首版候选方案：批准后在服务端提取已验证请求中的精确 DSH Cookie，将其放入该配对记录的内存；只有持有本次私有领取凭据的原始 MCP 客户端才能领取。
- 不读取 DSH signing secret、浏览器凭证库、启动日志或已有用户 token；不将凭证发送给模型、页面 JavaScript、URL、剪贴板或日志；不自动批准。
- 此方案复用已有 Cookie 的权限与过期时间，并非独立、按 Session 限权且可单独撤销的专用 token。确认页面必须明确：授权插件调用当前 DSH 的接口，执行能力仍由 DSH 自身权限策略限制。删除本地凭证不等于让已复制 Cookie 在服务端失效。
- 如产品要求独立撤销、按接口限权或单独期限，需要 DSH 上游凭证能力或另外设计受限代理，不应把这些能力算作首版已提供。

## 配对协议约束

- 高熵 pairingId 和独立高熵 claimSecret。claimSecret 由客户端生成并留在运行时内部，不放进 MCP 工具结果、页面或 URL；服务端只持有其摘要并恒定时间比较。
- 浏览器短匹配码仅供用户对照，不是领取凭证，不用于代替用户确认。
- 精确绑定本次 DSH origin、实例、配对 ID 和客户端领取摘要；拒绝任意 callback URL、跨来源重定向和本机其他端口混用。
- 状态：pending → approved → claimed；pending → rejected/expired/cancelled；approved 未领取也可过期或取消。取消必须证明持有本次 claimSecret，清除临时 Cookie。终态不可重新批准或领取。
- 建议 TTL 5 分钟、同时待处理上限 16 条；创建/错误领取限速、请求体限长、清理定时器，避免未登录请求消耗无界资源。具体常量由测试确定。
- begin/claim 仅允许 loopback 连接、精确 Host，拒绝外部 Origin/CORS 和重绑定；浏览器批准要求完整 origin（含协议和端口）严格匹配，不能只依赖上游较宽松的 host 比较。
- 批准 POST 必须验证服务端生成、与本次配对绑定的 CSRF nonce；拒绝重复/冲突字段和非法 Content-Type。
- 页面设置 no-store、Referrer-Policy: same-origin、CSP 与 frame-ancestors none；不加载第三方内容，不显示未经转义的调用方字符串。
- 一次成功领取后立刻清除服务端 Cookie 与临时 secret。并发领取只能一个成功；客户端收到但落盘失败时提供明确重配指引，不无限重试。
- MCP 客户端凭证沿用现有私有目录和原子落盘方式。响应、错误和测试报告必须脱敏。
- companion 重启丢弃内存配对；MCP 正常退出时尽力取消，异常断开无法保证服务端立即知晓，依靠短 TTL 清理；不自动恢复批准，不重复打开浏览器或重新生成配对。未确认不创建 DSH Agent Session、不调用付费模型。

## 实施步骤

### P0：技术门禁（当前）

- 阅读实际安装的 DSH WebServer、Connection 和前端扩展接口，标注版本和源码位置。
- 临时 DSH_HOME、独立 profile、随机 loopback 端口运行探针，验证自定义路由、原生认证保护、显式批准、凭证一次领取和真实认证接口访问。
- 验证未登录批准、跨来源批准、错误领取凭据、拒绝、过期、重放失败；秘密不进入输出，退出清理进程和临时目录。
- 探针中的程序化批准仅用于隔离测试；不能当作用户真实浏览器点击验收。

### P1：协议和 companion

- 实现独立可单测的配对状态机与引导路由，先满足严格鉴权和资源限制。
- 增加无需前端私有框架的同源确认页，复用 DSH 已有登录态；若发现只能通过上游修改实现，应停下更新方案。
- 定义无凭证也能读取的最小 companion pairing capability/version，仅返回协议能力，不暴露 Session、模型目录或配置；由此区分未安装/过旧/待认证，保留现有模型路由协议兼容。

### P2：Codex 连接工具

- 增加 `dsh_connect`（最终 schema 在 P1 后确定），负责创建/查询/取消配对及打开浏览器；凭证只在插件运行时保存。
- `dsh_status` 保持只读，不自动打开页面、安装依赖或启动配对；返回可操作的 nextAction。
- 等待有界、可续查；多窗口不能串领凭证或覆盖另一 origin 的授权；已有 ready 状态默认不触发重配。
- 原 connect.mjs 作为兼容回退保留，但不再是正常用户推荐入口。

### P3：安装与引导

- 将 companion 从“仅模型固定需要”调整为“浏览器配对需要”，文档明确其与 Codex 插件是两端组件。
- AI 可协助定位安装目录、核对 DSH profile、安装 companion；共享 DSH 的重启必须先检查是否有运行任务并确认用户授权范围，不能为了连接打断其他会话；升级应可回滚，若需要新的用户确认，应在准备好具体操作后提出。
- 插件缓存升级/移除后 companion 路径必须仍有效；评估稳定数据目录安装，避免每次更新后失效。本轮不直接迁移用户安装。
- 清晰处理 DSH 未启动、浏览器未登录、companion 缺失/版本不符、用户拒绝、配对超时和打开浏览器失败。

### P4：验收与发布准备

- 单元：所有状态转换、并发、过期、重放、限速、CSRF、Host/Origin、路径与凭证脱敏。
- 集成：真实隔离 DSH 上从无 Codex 凭证到 ready，原模型固定/任务提交/权限等待行为不退化。
- 人工：真实浏览器点允许、点拒绝、不操作至超时、浏览器未登录、两个窗口同时连接；整个正常路径没有终端 node 命令或手动复制链接。
- 冷安装：干净 Codex 安装和未安装 companion 的已有 DSH，完整记录步骤；不得用作者已配置环境冒充普通用户体验。
- 主 Agent 审查全量 diff、回归测试、记录已验证/未验证边界。完成后再准备版本与 PR，不提前更新用户安装，不擅自合并。

## 完成标准

用户在支持的本地 DSH 已登录环境中，只需在 Codex 发起连接并在浏览器确认一次，就能获得经真实 API 验证的 ready 状态；拒绝、未登录、过期、错误 secret 和重复领取都不能获得凭证。现有共享 DSH 的模型、权限和会话保持原样。

## 源码调研证据

本机 DSH 源码根目录：`/Users/a1021500059/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`。此路径只用于开发者复查，不作为用户安装依赖。

| 源码 | 发现 |
| --- | --- |
| `dsh-client-connection/lib/index.js:253,280,292` | Cookie 与 Host/端口绑定，HttpOnly、SameSite=Strict；须只提取当前 DSH 的精确 Cookie 项，不能复制整个请求 Cookie header。 |
| 同文件 `:386,432` | 启动链接换 Cookie；服务端验证签名和生命周期。 |
| 同文件 `:553,562` | `requestRejection` 可复用；`authenticatedUrl` 不应用于绕过浏览器登录或输出启动 token。 |
| 同文件 `:198-215` | 原生检查接受无 Origin，且只比较 Origin.host；批准端点必须额外严格同源；Fetch bridge 的 Request.url 可能是内部 `http://dsh.internal`，不能直接用它作为公网/本机 origin，应依据明确部署协议与已校验的精确 Host 构造期望 origin，不能信任任意 Forwarded/X-Forwarded-*。 |
| `dsh-host-webserver/lib/index.js:176,234,245` | 自定义精确路由可用，但不自动继承 API 认证。 |
| `src/dsh-companion.ts:312` | 现有 companion 已使用受原生认证保护的 Fetch 路由。 |

主 Agent 和独立只读审核均认为现有扩展接口支持最小方案。隔离探针结果另行记录；尚未完成真实浏览器验收前，不宣称用户流程完成。

## P0 隔离验证结果（2026-09-21）

- 状态：通过。执行代理完成后，主 Agent 独立复跑 `scripts/probe-dsh-pairing.mjs`，退出码 0，`ok=true`。
- 环境：真实安装 DSH `0.1.5-rc.2`；临时 DSH_HOME 和独立 profile；随机 loopback 端口；未访问用户 3080 服务、用户凭证或付费模型。
- 验证：自定义页面与未认证配对引导可用；pending 不返回凭证；显式批准后一次领取；领取的 Cookie 可访问真实受保护首页和 `/api/session/list`（`result.ok=true`）。
- 反向用例：错误领取 secret、未登录批准、跨 Origin、缺 Origin、恶意 Host、重复批准、重复领取、拒绝、过期、浏览器 Origin 发起 bootstrap 均被拒绝。
- 测试清理：finally 终止隔离子进程并删除临时目录；没有在当前用户 profile 安装测试插件。
- 兼容发现：Fetch bridge 使用内部 Request.url，必须基于已校验的 Host 和明确部署协议校验完整 Origin；恶意 Host 测试使用 node:http，避免 fetch 忽略自定义 Host 导致假验证。
- 尚未验证：真实浏览器点击、CSRF nonce 页面绑定、生产级资源限流/多客户端并发、取消/异常恢复、MCP dsh_connect、凭证落盘和冷安装全流程。探针使用短 TTL、简化状态机及程序化批准，只是后端可行性门禁，不能作为可发布功能。
- P0 结论：现有 companion 扩展接口足够支持最小方案，无需修改 DSH 上游。进入 P1 实施前按本计划补全正式协议和边界。

复跑命令（DSH_INSTALL_ROOT 替换为本机实际安装包目录）：

```bash
DSH_INSTALL_ROOT=/absolute/path/to/@deepseek-ai/dsh node scripts/probe-dsh-pairing.mjs
```

## 实施进度（2026-09-21）

P1/P2 已实现：同源确认页、配对状态机、dsh_connect 与固定小响应认证检查。P3 已更新中英文安装文档和 Skill，提供稳定目录建议；未自动操作用户的 DSH 安装。P4 自动化门禁通过（145 项测试、真实生产组件隔离集成及本地 marketplace 安装），真实浏览器允许、拒绝和完整 5 分钟不操作过期验收均已通过；过期后旧表单不能授权，未保存凭证或自动重新配对。详见 [验收记录](BROWSER_PAIRING_VERIFICATION.md)。人工验收结束时未提交/推送/更新用户安装；后续发布状态以 GitHub PR 为准。

人工浏览器首次尝试发现 no-referrer 与 HTML 表单 POST 的 Origin 校验冲突：浏览器会把 Origin 设为 null，导致严格校验拒绝，脚本模拟 POST 未暴露此差异。按 Fetch 标准改为 same-origin，在保留同源 Origin 的同时不向跨域发送 Referrer；不接受 null Origin、不放宽 CSRF。需重新人工验收。

修正 Referrer-Policy 后，真实浏览器允许连接及凭证保存/API 校验已通过，详见验收记录。
