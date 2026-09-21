# 浏览器配对验收记录

日期：2026-09-21。基线：origin/main `f643509012535888b2f599ffd47b49b1ab5dd93a`。
实现分支：`feat/browser-pairing`。Codex 插件与 companion 开发版本均为 0.4.0。

## 已验证

- `npm run check`：类型检查、打包、145 项测试全部通过，0 失败。
- 客户端/服务端覆盖严格 Host/Origin、CSRF、重复字段、请求大小、秘密脱敏、配对 TTL、取消、一次领取、并行请求、限量限速、旧 companion 诊断、原子凭证保存及重复检查。
- 独立审查发现的历史会话过多问题已修复：使用受原生 Cookie 认证的固定小响应 `/codex-pairing/v1/verify`，不再依靠无分页的 session/list 做连接认证。
- `scripts/probe-dsh-browser-pairing.mjs` 在真实 DSH 0.1.5-rc.2、临时 DSH_HOME、随机 loopback 端口、生产 companion 和 bundled MCP 上通过，exit 0。主代理复跑通过。
- 实际集成覆盖：空凭证发现配对能力；无秘密确认 URL 与匹配码；未登录与错误 CSRF 拒绝；只打开页面不授权；两个客户端配对不串；拒绝和取消不授予权限；显式批准后 ready；落盘凭证独立调用原生 session/list 成功。
- 隔离 CODEX_HOME 从本工作树 marketplace 安装得到 0.4.0；server、connect、companion、Skill 的 SHA256 与源码分发目录一致。未更改用户 Codex 安装。
- 主代理审查变更及 `git diff --check` 通过；独立审核复核修正后无新阻断。

## 人工验收

真实浏览器允许连接已通过。用户核对匹配码 E0E37886 并点击允许，截图显示“已允许连接”；主 Agent 随后执行一次 check，MCP 返回 ready，落盘凭证独立调用原生 session/list 成功。人工探针 manual=true、ok=true、退出码 0；临时服务和目录已清理。没有让用户执行 node 命令或复制登录链接。

真实浏览器拒绝已通过：匹配码 BC0E17E0，用户点击拒绝，MCP 返回 rejected；再次 check 为 no_pending_pairing，dsh_status.connected=false，凭证文件不存在，没有自动重新发起配对。探针 manualReject=true、ok=true、退出码 0，临时环境已清理。

完整 5 分钟不操作过期已通过：匹配码 B8611BC4，实际等待 300708 ms，无用户授权决定；MCP 返回 expired。主 Agent 在真实 Chrome 核对页面显示“此请求已处理或过期（expired）。请返回 Codex 查看结果。”，无授权表单；旧授权表单提交被拒绝。随后确认 dsh_status.connected=false、再次 check 为 no_pending_pairing、凭证文件不存在，没有自动重新发起配对。探针 manualTimeout=true、ok=true、退出码 0，临时环境已清理。

浏览器多窗口、不同 OS 的自动打开仍未人工覆盖；相关配对并行状态机/HTTP 场景已有自动化覆盖。原生 DSH 自身首次登录不能被此流程绕过。

## 发布与环境边界

人工验收结束时尚未提交、推送、合并或更新用户安装；发布 PR 后的状态以 GitHub 为准。共享 3080 实例、原有 DSH profile、模型默认值和凭证未变动。临时测试不调用付费模型。

Companion 冷安装通过隔离 profile 测试；真实用户 profile 的自动安装/升级/重启不是工具隐式行为，需要按文档选择稳定目录并检查共享实例任务。

配对复用现有 DSH Cookie 的权限和期限，不提供独立服务端撤销或按任务 scope。移除本地凭证不能让复制件自动失效。

### 人工首轮发现及修正

用户点击允许后，真实页面返回错误且 MCP 保持 pending，未授予连接。确认页采用 no-referrer 导致 HTML 表单导航 POST 的 Origin 为 null，与严格同源校验冲突。依据 [Fetch Origin 算法](https://fetch.spec.whatwg.org/#append-a-request-origin-header)，修改页面 Referrer-Policy 为 same-origin，仍拒绝 null Origin 且保留 CSRF；新增 null Origin 拒绝回归和策略头断言。首轮失败记录保留，修复后须重新人工验证。

修复后复跑：145 项自动化测试全部通过，生产组件隔离集成 exit 0，真实浏览器人工允许闭环 exit 0。首轮失败已修复，保留上面的失败与原因记录。
