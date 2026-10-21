# Web 与 Desktop 统一支持计划

日期：2026-10-21。0.5.0已合入main并安装验证。当前正在实施0.6.0：将DSH端连接桥接与模型配套组件合并为单一插件；以下前期记录保留为历史，当前范围及验收见文末。

## 目标与基线

同一 Codex 插件连接本地 DSH Web 或 Desktop，保留五工具和主 Agent 验收职责。远端 main 已 fetch，基线为 `425ebe2ca4f1ab75a1218349a0099998f7c23ac0`；继续独立 `fix/desktop-discovery` 工作树中已验证的本需求连接修复，HEAD 与基线一致。原仓库用户未提交改动不纳入。

## 用户流程

安装 Codex 插件 → 根据实际 DSH 类型安装匹配的随附连接组件 → 启动 DSH → 在 Codex 说“连接 Web DSH”或“连接桌面 DSH” → 用户在 DSH 完成首次授权 → 派发并验收任务。已有授权无需重复授权。仅明确的 ready 才可派发。

默认 auto：Web 可达优先；Web 未启动才检查桌面发现文件。鉴权失败、协议不支持或任务异常不切换后端。两端同时运行时支持通过工具参数明确选择。MCP 进程首次成功选定后固定实例，换端需新对话；不迁移旧任务。

## 实施顺序与责任

1. **连接与诊断**：统一 `auto/web/desktop` 选择，返回实际模式和地址；区分缺少桌面连接信息、信息失效、未启动、未授权、实例变化。保持 origin 绑定凭证和请求去重。独立代理负责连接源码及测试。
2. **桌面组件交付**：将已工作的本机桌面 bridge 整理为仓库内独立、可打包的 DSH bundle；用户明确允许后才写入私有发现文件及凭证。复核拒绝、同源与认证检查、文件权限、过期/重启和卸载边界；给出稳定目录安装流程，不依赖临时 Codex 缓存。独立代理负责该组件及测试。
3. **能力与兼容**：基本连接、浏览器配对、模型路由分别检测；不安装旧 companion 到未验证桌面版本，不修改共享默认模型。现有 Web companion 保留已验证版本范围；桌面模型路由未通过则明确不可用。
4. **文档与分发**：更新中英文 README、技能、兼容矩阵和本计划验收账本；核验 package files、补丁路径、自包含分发、第三方许可证。主代理负责集成。
5. **验证与审查**：类型检查、构建、自动化回归、隔离 profile/模拟服务测试、已授权真实桌面任务；独立代码审查后修复问题。新用户手动授权或共享服务重启如需用户配合，先完成其他可独立验证项目。

## 验收矩阵

| 场景 | 标准 | 证据状态 |
|---|---|---|
| Web 单独启动 | 原配对、连接和任务行为保持，显式 web 不回退 | 自动化回归通过；未重新启动共享 Web |
| Desktop 单独启动 | 无需手工端口/粘贴 token，发现当前已授权实例 | 本轮显式 desktop 真实任务通过 |
| 双端同时运行 | auto 优先 Web；显式选择确定；绑定后拒绝切换 | 自动化模拟双端/并发选择通过 |
| 均未启动/metadata 缺失或失效 | 给出具体下一步，不发送任务、不扫端口 | discovery/诊断/MCP 测试通过 |
| 首次允许/拒绝 | 仅用户允许可保存凭证；拒绝不产生新授权 | Web 回归、桌面组件单测及真实后端隔离 probe 通过；UI允许/拒绝已验收 |
| 模型能力缺失 | 基础派发仍可用；指定模型明确失败，不改共享默认 | 缺失能力诊断/模型路由失败回归通过；桌面普通任务通过 |
| 桌面重启、端口或实例变化 | 已绑定进程拒绝换实例；旧任务未知不重发 | 实例变化/原任务回归测试通过；隔离后端退出后 PID 已失效 |
| 执行中断线 | 保留 unknown/原任务，查询不会重复派发 | 已有断线/unknown/去重回归通过 |
| 新用户安装 | 组件包可打包、自包含、稳定路径，命令与本机CLI一致 | 打包/离线导入通过；桌面UI绝对路径安装由源码核实，实际UI允许/拒绝已验收 |

## 范围与发布门槛

- 本轮不引入远程 DSH、不自动启动专用实例、不自动审批执行权限、不将桌面模型路由支持等同连接支持。
- 桌面发现文件是本插件随附组件提供的契约，不是 DSH 官方接口。记录实测 DSH/组件组合，不宣称“某版本以上全部兼容”。
- 不修改用户现有授权、不自动替换已安装 bridge、不重启共享服务；真实任务使用隔离状态目录，凭证副本验证后清理。
- 初期锁定依赖曾有MCP SDK高危及hono中危告警。0.5.0提交准备已升级SDK1.32.1及修复版Hono，npm audit当前0项漏洞；发布产物由新依赖重新构建并回归。
- 未获明确指示不 commit/push/merge/发布。发布前必须检查相对目标主分支的全部提交、文件与 diff。

## 本轮验收证据

- `npm run check`：类型检查、分发构建、155 tests 全部通过，0失败。许可证清单与基线一致，运行产物未嵌入作者机器路径。
- 显式 desktop 真实任务：`d147a83e-66ad-4128-924d-7145325859f7`，completed、attempt=1，结果 `DSH_DUAL_HOST_OK`；凭证副本已删除。
- `DSH_DESKTOP_APP='/Applications/DeepSeek Harness.app' node scripts/probe-desktop-bridge.mjs`：使用应用包内真实 Desktop host 0.2.1-rc.2 / Node24.21.0，在临时 runtime/profile/DSH_HOME/state 中加载新 bridge0.1.0。匿名/跨源/Host/CSRF拒绝、用户拒绝不写、允许后0600凭证被原生session/list接受均通过。仅隔离测试实例由脚本模拟用户授权；未自动批准用户真实实例。
- Desktop proxy 去掉 Origin，由 Host Cookie和有效CSRF共同保护；不能错误要求所有请求必须携带浏览器 Origin。跨源 Origin 存在时仍拒绝。
- 关闭后保留发现文件、确认其原 PID 已退出，后续连接判陈旧。没有将“退出”或“卸载”宣称为撤销已导出的 DSH 登录权限。
- 独立审查发现旧 close 可能在读取 instanceId 后误删新实例发现文件，已取消共享文件删除；测试、文档和真实 probe 重跑通过，复核无剩余阻断。
- 新包 npm pack 包含完整7文件，离线安装可导入；桌面安装解析器源码支持绝对目录和绝对tgz，不需file:。未发布npm。

## 历史人工验收计划（已被下方共存隔离与模型验收结果取代）

1. 在无运行任务、已备份 profile 的前提下，通过客户端安装新 bridge；早期0.1.0曾与旧bridge争用文件；0.1.1已通过命名空间隔离解决，当前应保持凹凸助手启用。该历史步骤已执行并由后续共存验收取代。
2. 人工检查插件UI可见，先拒绝、再允许；回 Codex 新对话确认 desktop/ready，再派发一个只读任务。重启后核对重新授权及旧任务不重发。
3. 发布前完成既有依赖告警评估、版本/cache 更新和完整主分支差异审查；当前全部为未提交工作树修改。

## 客户端 UI 验收进展

2026-10-21：用户确认后，通过桌面插件管理成功安装新 bridge，并临时停用旧 @aotu/dsh-desktop-bridge。新 Codex 连接面板及允许/拒绝按钮可见。第一轮用户先允许后拒绝，已核实该过程不能用于证明拒绝前后无写入。重新记录文件指纹后，用户仅点击拒绝：界面显示拒绝，发现文件和所有凭证文件内容及列表完全不变，拒绝验收通过。当前已发起允许连接请求，等待用户亲自确认；旧桥接仍处于临时停用状态。

### UI 本轮结果

用户仅拒绝的复测通过后，亲自点击允许；界面显示“已允许连接”。修复构建读取新组件授权，status/connect 均 ready、connectionMode=desktop。真实最小任务 `996bdf62-8a75-4da1-8820-09d044bba019`（session `session-6445c24c-daef-45c4-9f43-94479842213a`）completed、attempt=1，结果精确为 `DSH_DESKTOP_UI_OK`。隔离测试凭证副本已清理，用户本机授权保留。

本轮临时切换已结束：客户端界面核验旧 `@aotu/dsh-desktop-bridge` 恢复启用、凹凸助手连接入口恢复；新 `@aototo/codex-subagent-dsh-desktop-bridge` 保留安装但停用。恢复入口不等同已验证飞书后台服务运行；本轮没有自动启动飞书服务或发送消息。Codex 正式插件未更新，未提交/推送/发布。新组件重启后重新授权的手动场景仍待后续，发布前依赖告警评估也尚未完成。

## 共存隔离修复（2026-10-21，已完成）

用户要求 Codex 插件与凹凸助手同时启用且连接信息互不覆盖。已重新 fetch origin/main，基线仍为 425ebe2ca4f1ab75a1218349a0099998f7c23ac0，在同一独立工作树继续本需求；不修改原仓库已有改动。

- Codex Desktop 发现文件及 origin 凭据统一迁至 `${DSH_SUBAGENT_HOME}/codex-desktop`，默认 `~/.codex-subagent-dsh/codex-desktop`。增加 consumer 标记校验；不回退到凹凸助手旧根目录，不自动复制旧授权。
- 凹凸助手继续使用原根目录的 desktop-connection.json 与 credentials；Web 凭据与 Codex task store 也保持原路径，避免打断已有 Web 连接和任务历史。
- 两个桌面插件各用独立路由、UI标识和发现文件。启停新 Codex bridge 不触发凹凸助手 ServiceController，也不删除其 metadata/凭据。
- 实施源码与独立审查并行；新增相同origin下交错授权、拒绝、退出与重写metadata的隔离回归。真实 Desktop 隔离host探针验证存储新路径及consumer，再通过客户端同时启用两组件，用户重新授权Codex，验证凹凸助手文件不变和Codex任务完成。
- 一次真实 DSH 实例仍共享服务进程与 Host Cookie 失效范围；本修复是本地连接文件和组件生命周期隔离，不提供独立token撤销或宿主进程故障隔离。
- 无需卸载/停用凹凸助手。只升级当前已安装但停用的Codex测试组件，旧授权与配置保留可回滚。正式Codex marketplace安装与发布另外验收，不混同开发构建测试。

### 共存隔离实施与当前状态

157项全量测试、类型检查/构建、独立审查通过。真实Desktop0.2.1-rc.2隔离后端探针通过：bridge0.1.1的允许/拒绝/退出均不改变同origin旧根授权，consumer和私有目录得到验证。

客户端已将停用的Codex bridge0.1.0升级为0.1.1并启用；凹凸助手旧组件全程保持启用，两个入口同时可见。升级后凹凸助手根目录4个连接文件的指纹不变。Codex专用目录需用户首次允许，目前已打开确认页面，等待用户操作后进行双向实际文件隔离与任务验收。Codex正式MCP安装尚未替换，后续任务使用已构建开发运行时。

### 共存隔离最终验收：通过

2026-10-21，macOS Desktop0.2.1-rc.2、Codex desktop bridge0.1.1，两组件保持同时启用。

- 用户在Codex面板允许后，仅codex-desktop目录产生带consumer标记的0600发现文件/凭据；凹凸助手根目录4个连接文件的完整内容及列表不变。
- 凹凸助手连接检查通过。Codex开发构建status/connect为ready；任务 `57806a15-66b8-4de2-8640-5f2be8ce9cd1`，session `session-d3e8df6f-d910-4d5f-acbc-905c30c87ec8`，completed、attempt=1、结果 `DSH_COEXIST_OK`。
- 反向验收：用户在凹凸助手连接框确认OK，原根授权确实更新；Codex私有发现文件与所有凭据文件指纹、列表完全不变。再次检查两边均连接成功，Codex ready；没有重复派发任务。
- 实际组件安装目录为0.1.1稳定开发目录，旧助手仍启用；不再需要临时停用凹凸助手。未启动飞书后台服务或发送飞书消息，连接正常不等于飞书业务全链路已测。
- 两轮测试凭证副本已清理，用户亲自授予的正式本机授权保留。Codex正式marketplace运行时仍未升级，本轮使用已构建开发运行时；无提交、推送或发布。
- 当前共用连接文件问题已解决；双方仍共享DSH服务进程和原生登录生命周期，不宣称服务器端权限隔离。

## Desktop 按任务指定模型与推理档位（2026-10-21，实施中）

继续同一桌面兼容需求，重新 fetch 后 HEAD 与 origin/main 均为 `425ebe2ca4f1ab75a1218349a0099998f7c23ac0`；复用已验收的独立桌面工作树，不带入原仓库未提交改动。

1. 对照应用包内 Desktop0.2.1-rc.2 的 agent/request、system-prompt/assemble、sessionController 与 catalog 接口，优先复用 Web 的会话 pin 实现。
2. 保留现有任务工具契约：按 catalog 校验 provider/model/reasoningEffort，在首条 prompt 前持久化；拒绝未知组合和会话冲突，不调用共享 selectModel。
3. 在临时 DSH_HOME/profile/端口启动应用自带真实 Desktop host：并发不同模型/档位、未指定会话、无效组合、实际请求头、鉴权及持久化恢复均需验证。模拟模型用于隔离验证，不能宣称真实供应商推理通过。
4. 更新可安装 companion 包、诊断、中文/英文说明与兼容矩阵；独立审查、全量回归之后再安装用户桌面组件并执行最小真实模型任务。
5. 用户实例保持当前连接隔离，不改共享默认模型、不自动重启服务、不影响凹凸助手入口。若真实任务不可完成，明确区分实现/隔离验收/供应商验收状态。

完成标准：requested/configured/actualRequest 三者匹配；至少两个不同模型或档位的会话独立，未指定会话及全局默认不变；Web既有回归保持通过；所有凭据与临时任务状态按既有规则保护。

### 桌面模型适配：代码与隔离验收通过

根因由真实Desktop loader日志确认：旧companion的已安装peer版本与requirements不匹配，被跳过加载，模型路由返回404。0.4.1仅扩展两个明确依赖版本组合；核心session hook保持不变。160项测试、类型检查、构建、打包清单、diff检查通过。

`DSH_DESKTOP_APP='/Applications/DeepSeek Harness.app' node scripts/probe-desktop-model-routing.mjs` 使用应用包内Desktop0.2.1-rc.2真实host、临时profile和模拟adapter通过：匿名401、非法effort拒绝且不写pin、A/B不同模型与档位并发、未固定C保持默认、冷重启恢复、全局默认不变。A/B/C均通过原生remote.mux确认turn/end=completed及精确fixture文本；打包MCP的desktop/status模型能力可用，指定模型任务completed，requested/configured/actualRequest完全一致。临时host和凭据清理完成。

独立审查未发现核心阻断，指出不能只等待request/header判断执行完成；该缺口已通过上述终态/文本断言补齐。用户当前运行Desktop尚未安装此companion；稳定0.4.1副本和profile备份已准备，待客户端安装确认后进行真实provider验收，不将隔离模型结果外推为付费模型可用。未提交、推送、发布。

### 桌面指定模型与推理档位真实验收：通过

用户确认安装后，客户端显示companion0.4.1已安装，随后启用成功；无重启，原Codex bridge0.1.1与凹凸助手均保持启用。稳定安装目录为 `~/.local/share/codex-subagent-dsh/companion/0.4.1-dev-20261021-143802`，原profile备份在同根backups/desktop-model-20261021-143802。

开发MCP连接现有用户Desktop0.2.1-rc.2，status返回modelRouting.available=true和modelSelection=true。依据实际返回目录选择以下两组配置，并发执行只回复标记、不调用工具或读写项目文件的最小任务：

| provider / model / effort | taskId | 验收 |
|---|---|---|
| deepseek-official / deepseek-flash / low | dd7292eb-5d2b-45dc-8a0d-4df5f4fa86c5 | completed、attempt=1、DSH_MODEL_OK；requested/configured/actualRequest完全相同 |
| devin-proxy / devin/swe-2 / high | ec66b848-359f-4015-8047-98338ba72305 | completed、attempt=1、DSH_MODEL_OK；requested/configured/actualRequest完全相同 |

两轮查询共享默认均保持 `cliproxy-claude / claude-opus-5-5 / high`；安装前后Codex和凹凸助手共6个发现/凭据文件的指纹不变，凹凸助手只读连接复查通过。测试MCP进程已退出，临时凭据副本已删除，原用户授权保留。无飞书发送、无服务重启、无权限策略修改。

本轮代码、160测试、真实Desktop隔离probe及两供应商最小任务验收完成；不外推所有模型/档位或其他DSH版本均可用。仍未提交、推送、发布，正式Codex安装仍旧版；本轮验收用构建后的开发MCP。下一发布阶段需完成既有版本/cache、依赖审计与完整基线diff门禁。

## 0.5.0 正式插件升级与提交准备（2026-10-21）

用户已授权升级本机正式Codex插件、验证后提交推送并创建PR；不授权直接合并main。重新fetch后基线仍为425ebe2ca4f1ab75a1218349a0099998f7c23ac0，完整差异独立审查确认均属于本次双端兼容需求，无额外提交。

主package、插件manifest、MCP server版本统一0.5.0；companion0.4.1和desktop bridge0.1.1保持各自版本。SDK升级到1.32.1，Hono更新到修复版本，npm audit为0项漏洞；新依赖重建runtime和第三方许可证清单。最终npm run check的160项测试全部通过，真实Desktop隔离模型probe重跑通过。

通过Codex官方CLI升级同一pluginId的正式缓存到0.5.0；直接启动该正式缓存runtime的真实swe-2/high任务 `4fa50240-284a-41bc-9d3d-3c762816ad77` completed、attempt=1、DSH_MODEL_OK，requested/configured/actualRequest一致，全局默认未变。测试凭据副本清理。此证明正式缓存产物可用，当前既有聊天不会自动热替换MCP，应开新对话加载新安装。

提交前核对完整tracked/untracked范围和差异，不含原仓库已有改动、连接凭据或临时测试目录。PR合并前main仍0.4.0；本机安装来源在推送后绑定GitHub需求分支，合并后可切回main。未发布npm或GitHub Release。

## 0.6.0 单一 DSH 插件计划（实施中）

用户已确认统一名称并授权实施，主代理负责验收，要求不影响凹凸助手。已fetch最新main并从 `b5cab81ecd1e88af1f43b92730935c46bf4a8de7` 建立独立 `feat/unified-dsh-plugin` 工作树，首次修改前HEAD与基线完全一致。保留其它工作树与原仓库改动。

目标：Codex端与DSH端各安装一个codex-subagent-dsh；DSH包名 `@aototo/codex-subagent-dsh`，随Codex插件分发自包含dsh-plugin目录，内含连接授权、Web配对、会话模型路由三个模块。保持现有API、codex-desktop授权路径/consumer及session pin契约。

实施与验收：
1. 核对真实宿主标识与插件加载机制；不能以webServer存在判定Desktop。依赖范围只列已验收组合，单包分别加载相应连接模块及公共模型路由。
2. 新旧重复安装时明确失败并提示迁移，不重复注册路由或安装会话hook。保留旧源码作为模块或测试夹具可以，但正式安装包只提供一个入口。
3. 全新安装、Web/桌面授权允许拒绝、模型/档位隔离、重启持久恢复、旧版迁移与回滚先使用临时profile/凭据和模拟模型验证；任何未知任务不重派。
4. 实际迁移前备份profile，检查运行任务。仅停用两个旧Codex配套组件，启用合并插件；保留授权文件和旧稳定目录。先检查原授权能否复用，失败时由用户亲自重新授权。
5. 凹凸助手组件不卸载/停用、不调用其服务控制入口；前后比较其插件配置和根授权指纹，并只读验证连接。不能将共享DSH进程故障隔离作为承诺。
6. 更新双语README、技能、构建/包清单、兼容矩阵，完成自动化及真实隔离probe、独立审查、实际最小模型任务验收后汇报。后续已获用户授权：升级正式Codex插件并验收后提交推送、创建PR；不自动合并或发布npm包。

实施前已捕获Codex与凹凸助手6个发现/凭据文件指纹，凹凸助手desktop只读连接检查通过；本机服务未启停。真实UI安装本地开发包的操作按电脑操作规则在准备完成后确认。


### 本轮结果（2026-10-21）

- 已完成：单包0.6.0、Desktop/Web按profile识别、旧包移出分发、双语README与技能安装规则、迁移/回滚说明。
- 已完成：167 tests、类型检查、构建、运行依赖审计0漏洞；独立Cordis生命周期/助手隔离审查无阻断项。
- 已完成：真实隔离Web/Desktop0.2.1-rc.2授权、模型隔离、MCP completed；旧两包→统一包→旧两包迁移回滚；静态与动态混装保护。模型使用合成adapter，未将此视为真实供应商验收。
- 已完成：用户当前6份连接/凭据文件指纹均不变；凹凸助手只读连接检查通过，未提交任务；已备份桌面profile（含patch与.plugin-manager）并准备稳定安装目录。
- 已完成：用户确认后经客户端安装并启用统一包0.6.0；旧两组件已不在启用bundle列表，凹凸助手仍启用，未重启DSH。原授权直接复用，六份连接文件指纹不变。swe-2/high与DeepSeek Flash/low真实任务均completed、attempt=1、三层模型证据一致，共享默认未变。现有正式Codex0.5.0连接/模型能力检查通过。
- 后续用户已授权升级正式Codex插件，验收后提交推送并创建PR；不自动合并main。


### 本机迁移验收（2026-10-21）

- 用户确认安装后通过DSH客户端操作，统一包显示启用，Codex连接入口出现；凹凸助手保持启用、原依赖路径不变，连接只读检查通过。未操作其服务开关或发送飞书消息。
- 本机安装为DSH端开发包0.6.0；正式Codex安装已升级0.6.0，GitHub/main未改变。客户端重启完整UI流程不在本轮验收范围。验收后按用户授权提交推送需求分支，创建PR。


### 0.6.0 正式Codex升级与PR准备

用户已明确授权正式插件升级、验收后提交推送和创建PR。正式缓存0.6.0的MCP已独立启动并完成swe-2/high最小任务，attempt=1、三层模型信息一致、共享默认未变。原授权保持，凹凸助手未操作。独立发布审查无阻断项；修正probe单独使用`--duplicates`时未准备旧版fixture的问题，真实隔离宿主复测通过。正式插件来源在推送后指向同一GitHub需求分支，合并后可切回main；已有对话不保证自动替换MCP，使用新会话加载新版。
