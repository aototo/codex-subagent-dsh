window.__ModuleLoader__.load({
  id: '@aototo/codex-subagent-dsh-desktop-bridge',
  factory: require => {
    const React = require('react');
    return { apply(ctx) {
      if (location.protocol !== 'dsh-app:' || location.hostname !== 'app') return;
      function ConnectionPanel({ view }) {
        const [state, setState] = React.useState('idle');
        const [challenge, setChallenge] = React.useState(null);
        const active = React.useRef(false);
        React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
        const begin = async () => {
          setState('loading');
          try {
            const response = await fetch('/codex-desktop-bridge/v1/status', { cache: 'no-store' });
            if (!response.ok) throw new Error('status');
            const value = await response.json();
            if (active.current) { setChallenge(value); setState('confirm'); }
          } catch { if (active.current) setState('failed'); }
        };
        const decide = async allow => {
          if (state !== 'confirm' || !challenge) return;
          setState('loading');
          try {
            const response = await fetch(`/codex-desktop-bridge/v1/${allow ? 'approve' : 'deny'}`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csrf: challenge.csrf }),
            });
            if (!response.ok) throw new Error('decision');
            if (active.current) { setChallenge(null); setState(allow ? 'allowed' : 'denied'); }
          } catch { if (active.current) { setChallenge(null); setState('failed'); } }
        };
        if (view === 'summary') return '授权本机 Codex 插件连接桌面 DSH；社区组件，非官方插件。';
        return React.createElement('div', { style: { display: 'grid', gap: '12px' } },
          React.createElement('p', null, '连接 Codex 与桌面 DSH（社区组件）。授权与当前 DSH 登录权限一致，可读取会话并执行任务，不是按任务限权令牌。凭据仅保存在本机。桌面重启后需重新授权。'),
          state === 'confirm' ? React.createElement(React.Fragment, null,
            React.createElement('p', null, `允许本机 Codex 连接 ${challenge.origin}？拒绝本次请求不会撤销已有授权。`),
            React.createElement('button', { type: 'button', onClick: () => decide(true) }, '允许连接'),
            React.createElement('button', { type: 'button', onClick: () => decide(false) }, '拒绝')) :
            React.createElement('button', { type: 'button', disabled: state === 'loading', onClick: begin }, state === 'loading' ? '处理中…' : '连接 Codex'),
          React.createElement('p', { role: 'status' }, ({ allowed: '已允许连接，请返回 Codex 检查连接。', denied: '已拒绝本次连接请求。已有授权保持不变。', failed: '连接请求失败或过期，请重试。' })[state] || ''));
      }
      ctx.inject(['slots'], scope => {
        scope.effect(() => scope.slots.inject('plugins.item', () => scope.slots.register({
          name: 'plugins.item', id: 'codex-desktop-connection', order: 90,
          label: () => 'Codex 连接', inject: () => ({}),
        }, ConnectionPanel)));
      });
    } };
  },
});
