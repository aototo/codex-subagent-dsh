# codex-subagent-dsh — DSH 配套插件 / DSH integration

这是社区插件，不是 DeepSeek 官方组件。Codex 端安装 `codex-subagent-dsh`，DSH 端安装本包 `@aototo/codex-subagent-dsh`，每端各一个即可。0.6.0 开发版统一包含桌面连接授权、Web 浏览器配对及会话模型/推理档位路由。

This community package is the single DSH-side integration bundled with Codex plugin 0.6.0. It combines Desktop authorization, Web browser pairing, and per-session model/reasoning routing. It is not an official DeepSeek component.

## 首次安装 / New installation

1. 将本目录完整复制到 Codex 缓存之外的稳定版本目录，保留目录不移动。未发布 npm 前使用本地绝对目录安装，不要假定包名已可从 registry 下载。
2. **Desktop**：在 DSH 客户端的插件管理中添加该绝对目录并启用。不要运行 `dsh plugin --profile desktop`。
3. **Web**：在实际运行的 Web profile 中安装稳定目录：`dsh plugin --profile web add -w "/absolute/stable/path/dsh-plugin"`。需重启时先等待运行任务结束。
4. 桌面用户打开「Codex 连接」亲自允许连接；Web 用户在 Codex 发起连接，核对匹配码后亲自允许。代理不能替用户授权。
5. Codex 中检查 `dsh_status`，指定 `connectionMode: desktop` 或 `web`；`includeModels: true` 返回目录后，才按精确 provider/model/reasoningEffort 派发。

Copy the complete directory to a stable versioned location. Install it through Desktop's plugin manager, or the CLI for the intended Web profile. Desktop uses its own explicit authorization panel; Web uses browser pairing. Check readiness and model capabilities in Codex before delegating. No separate bridge or companion package is needed.

## 从 0.5.0 迁移 / Upgrade from the split packages

先等待当前任务完成，备份目标 profile 配置，保留旧组件目录和连接文件。只停用下列旧 Codex 组件，再启用统一插件：

- `@aototo/codex-subagent-dsh-desktop-bridge`
- `@aototo/codex-subagent-dsh-companion`

**不要停用、卸载或替换 `@aotu/dsh-desktop-bridge`，它属于凹凸助手。** 不启动或停止飞书服务，不删除 `.dsh` 或 `.codex-subagent-dsh`。Web 迁移也需移除目标 profile 中旧 companion 的启用注册，避免重启时混装；使用该 Web CLI 支持的插件管理命令。

新旧组件同时启用会触发冲突保护，不能靠改名字或删除文件绕过。修正冲突后显式重新启用统一插件。旧包可暂时保持已安装但停用，便于回滚。

授权文件路径、consumer 标记、API 和会话 pin 标记保持不变。同一 DSH 进程迁移后先检查原授权能否继续使用，不主动覆盖凭据。若 DSH 重启、授权失效或连接检查要求授权，由本人重新允许；未知任务保持原 taskId，不自动重派。

Before migration, finish active tasks, back up the target profile, and retain the old stable directories and grants. Disable only the two old **aototo** Codex packages above. Keep the **aotu** assistant package enabled. Mixed enabled installations are rejected; after resolving the conflict, explicitly re-enable the unified plugin. Reuse valid grants after checking readiness; a restarted host may require user authorization again.

## 回滚 / Rollback

无运行任务时停用统一插件，重新启用原来所用的两个旧组件（Web 只需原 companion），或按原备份恢复对应配置。不要同时启用新旧组件。检查连接与模型能力；不自动改写/删除授权文件。凹凸助手的配置和入口保持不变。

To roll back after tasks finish, disable the unified plugin and re-enable the previous Codex packages. Never enable both generations together. Check connectivity and model capability; preserve the Aotu assistant and all existing grants.

## 安全与能力边界 / Boundaries

- Desktop 的发现文件及凭据仍位于 `~/.codex-subagent-dsh/codex-desktop`，使用自定义 DSH_SUBAGENT_HOME 时追加同名子目录。Web 和凹凸助手原路径保持不变。
- Desktop 模式按宿主提供的 profileContext.name 判断；不通过 webServer 存在或进程名称猜测。Web 不注册桌面授权入口，Desktop 不注册 Web 配对入口。
- 只有用户允许才写授权；拒绝和停用不删除已有授权。Cookie 权限与失效范围继承 DSH 登录，不是独立可撤销、按任务限权的令牌。停用插件不等于撤销 Cookie。
- 按真实模型目录验证 route，首个 prompt 前持久化，仅对目标会话生效；不调用全局 selectModel，不替换共享默认模型。完成验收须核对 requested/configured/actualRequest。
- 重启后失效发现信息由 PID/实例及认证检查拒绝，不自动重派未知任务。
- 支持范围以仓库兼容性记录和实测版本组合为准，不能从 peer 范围推导所有平台或混合版本都兼容。

Authorization remains explicit and local. Desktop credentials stay in the Codex-specific namespace; the assistant's files are not touched. Per-session routing never changes the shared default. Disabling/uninstalling does not revoke exported host cookies. Consult the compatibility record for tested combinations.
