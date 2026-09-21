# DSH companion / DSH 配套插件

Install this companion into the DSH profile that serves the Codex bridge. It
registers authenticated exact Fetch routes under
`/api/codex-session-model/<operation>` and installs Session-scoped model hooks.
Pins are persisted through DSH's official `model/selection` Session event with
a namespaced ownership marker. The companion never writes the shared default
model.

请把此配套插件安装到 Codex bridge 实际连接的 DSH profile。它在现有鉴权保护下注册
`/api/codex-session-model/<operation>` 精确 Fetch 路由，并安装 Session 级模型
hook。固定配置通过 DSH 官方 `model/selection` Session 事件和命名空间标记持久化，
不会写入共享默认模型。

The companion ships inside the installed Codex plugin, so most users can point
`add -w` at the `dsh-companion` directory under the actual installed plugin
root — no repository clone or npm build is needed. Replace the example path
below with the actual plugin root, which Codex can locate from its loaded Skill
path. When authentication is required, `dsh_status` also returns a connect command
whose path ends in `/runtime/connect.mjs`:

```bash
dsh plugin --profile web add -w "/absolute/path/to/installed-plugin/dsh-companion"
```

本配套插件已随 Codex 插件一起安装，多数用户直接把 `add -w` 指向实际安装插件根目录
下的 `dsh-companion` 目录即可，无需克隆仓库或运行 npm 构建。把示例路径替换为
实际路径；可让 Codex 从已加载的 Skill 路径定位插件根目录。待认证时，也可从
`dsh_status` 返回的连接命令中去掉末尾 `/runtime/connect.mjs` 得到该目录：

```bash
dsh plugin --profile web add -w "/absolute/path/to/installed-plugin/dsh-companion"
```

Repository developers may install from the checkout instead / 仓库开发者也可以
在仓库根目录执行：

```bash
dsh plugin --profile web add -w ./plugins/codex-subagent-dsh/dsh-companion
```

Restart that DSH profile after installation. Install it in the same profile
addressed by `DSH_SUBAGENT_URL`. The compatibility gate covers
`@deepseek-ai/dsh` 0.1.5-rc.1, resolved `dsh-agent`, Session Controller, and
Connection packages at 0.1.5-rc.2, and Cordis 4.0.2. Run the isolated-host probe
before using another package combination.

安装后重启该 DSH profile，并确保它与 `DSH_SUBAGENT_URL` 指向的 profile 一致。
当前兼容性门禁覆盖顶层 DSH 0.1.5-rc.1、实际加载的 agent/Session
Controller/Connection 0.1.5-rc.2 和 Cordis 4.0.2；其他版本组合需先重新运行隔离
主机探针。

## Browser pairing / 浏览器确认连接

Companion 0.4.0 also provides `/codex-pairing/v1` for browser pairing. Public endpoints expose only protocol capability and bounded temporary pairing state. The confirmation page and decision require the native DSH browser login, with additional same-origin and CSRF checks. A user-confirmed, origin-bound cookie can be claimed once by the initiating runtime. No launch token or signing secret is read.

0.4.0 增加浏览器配对。用户在已登录 DSH 的确认页核对匹配码并允许后，Codex 才能领取一次连接凭证；默认 5 分钟过期。复用已有 Cookie 的权限与有效期，不是独立可撤销的专用 token，也不放宽任务执行权限。

Prefer a stable versioned installation directory outside Codex's disposable plugin cache. Retain the previous companion directory for rollback; install the new path only in the intended DSH profile and restart when no active work would be interrupted. Do not remove a directory while DSH still depends on it.

建议完整复制到 Codex 缓存之外的稳定版本目录再安装，保留旧目录以便回滚；先确认实际 profile 与运行任务，再安全重启。不要删除 DSH 仍引用的目录。
