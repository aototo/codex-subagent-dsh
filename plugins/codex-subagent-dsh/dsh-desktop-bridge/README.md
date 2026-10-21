# Codex ↔ DSH Desktop 连接组件

这是本项目的社区组件，**不是 DeepSeek 官方组件**。它在桌面 DSH 已登录页面中提供显式授权入口，将当前实例地址和授权凭据保存到本机，供 Codex 插件发现。它不会启动其他服务、切换模型、替用户允许任务权限或读取浏览器 Cookie 数据库。

## 版本与边界

本实现依据 macOS DeepSeek Harness Desktop **0.2.1-rc.2** 的 `webServer`、`connection.requestRejection`、Host Cookie 和前端 slots 契约。本包 0.1.1 已完成实际客户端安装、启用、用户授权和双组件共存验收；拒绝路径经过手动 UI 验证，接口隔离、过期和实例退出经过隔离主机验证。客户端重启后重新授权的完整 UI 流程仍未验收，不能据此宣称支持全部桌面版本、Windows/Linux 或 Web。Web 用户继续使用原 browser pairing。

本包仅提供桌面连接。按任务指定模型和推理档位需另行通过客户端安装同包的 `dsh-companion` 0.4.1；该组合已在上述桌面版本完成两供应商真实任务验收。不要用旧 companion 0.4.0 替代；它的依赖范围不包含该桌面版本。

## 安装

先等待运行中的任务结束，备份 desktop profile 配置和依赖锁文件到私有目录。打开 **DSH 客户端 → 插件 → 添加插件**，使用本包的实际绝对目录或打包制品地址；由客户端负责安装、启用，按客户端提示决定是否重启。不要把代码仓库根目录当成本包路径。

本包目录是 `plugins/codex-subagent-dsh/dsh-desktop-bridge`，可用 `npm pack` 生成自包含 `.tgz`。当前没有声明 npm 注册表已发布；仅在确认发布成功后才使用包名 `@aototo/codex-subagent-dsh-desktop-bridge` 安装。本地目录安装后不要移动目录。

**不要使用 `dsh plugin --profile desktop add/remove`。** 已检查本机 CLI help 和源码：虽然支持 `--profile` 参数，但 `desktop` 明确由 Electron 应用独占管理，CLI 会拒绝。

在插件详情 **Codex 连接** 中点击“连接 Codex”，核对地址及权限说明，再亲自点击“允许连接”或“拒绝”。代理不得代替本人同意。回到 Codex 执行连接检查，显示 `ready` 后再派发任务。凹凸助手的旧本地组件可以保持启用，不需要卸载。升级 Codex bridge 时只替换本包，按客户端要求卸载旧版本再安装新版本；保留旧版本目录可回滚，不删除已有数据目录。

## 授权与生命周期

- 接口验证 DSH Host 登录、回环来源和 Origin，一次性 CSRF 绑定登录 Cookie，5 分钟过期。前端不读取 Cookie，接口不返回 Cookie/token。
- 仅本人允许后写入 `~/.codex-subagent-dsh/codex-desktop/desktop-connection.json` 和同一 `codex-desktop` 目录下的 `credentials/<origin的SHA256>.json`。目录 0700、文件 0600，发现文件不含凭据。
- 自定义 `DSH_SUBAGENT_HOME` 和 `DSH_HOME` 必须在桌面服务与 Codex 进程一致；GUI 未必继承终端环境。
- 拒绝或请求过期不写凭据、不清除已有授权。授权使用当前 DSH 登录权限，**不是独立可吊销 token**。
- 正常退出/卸载停止新授权并清空待确认请求，但保留共享发现文件与凭据，避免旧实例清理时误删新实例发布的信息。Codex 通过 PID/实例、目录和认证检查识别失效连接；同进程卸载后已有授权可能仍有效，卸载不等于撤销登录权限。
- 旧 origin 凭据保留，其有效性取决于 DSH 登录生命周期。重新启动桌面后再次授权，打开新的 Codex 对话。旧任务未知时先核对原会话，禁止自动重发。
- 发现信息发布失败时连接不会被标记成功；已经授权写入的 origin 凭据可能保留，以免清理时覆盖/删除其他连接的授权。

## 卸载

任务结束后在客户端插件管理中卸载此包，按提示重启。卸载不等于吊销 DSH 登录，不要删除整个 `.dsh` 或 `.codex-subagent-dsh`。如需撤销已导出的登录权限，需使用 DSH 支持的登录失效方式，并在确认无其他客户端使用后处理特定 origin 凭据。

## 与凹凸助手同时使用（0.1.1）

两个组件可以同时启用：凹凸助手使用原根目录，本包始终使用其下 `codex-desktop` 命名空间。自定义 `DSH_SUBAGENT_HOME` 也会追加该目录，无需改凹凸助手配置。发现文件含 `consumer: codex-subagent-dsh` 标记，Codex 桌面模式仅识别本组件授权。

升级后在本面板重新允许一次，不会自动导入旧授权。拒绝、过期或停用 Codex 组件不会改写/删除凹凸助手的文件，也不停止其服务；本包没有启动飞书服务的功能。Web 仍使用原连接目录。该隔离不改变 DSH 共享 Host Cookie 的权限与失效范围，关闭整个 DSH 进程仍会影响所有客户端。
