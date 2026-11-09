// client.body.js — React 半侧：把面板挂进 DSH Web 的 shell.overlay 插槽，
// 注册 Ctrl+Shift+D 快捷键与设置入口。姿势与 dsh-deepseek-tan-pet 相同。
// 面板本体（dashcam-engine/dashcam-panel）是纯 DOM，不依赖 React。

const React = require('react');

function DashcamMount() {
  React.useEffect(() => {
    const engine = mountDashcam();
    return () => engine.dispose();
  }, []);
  return React.createElement('div', { style: { display: 'none' } });
}

exports.name = 'dsh-dashcam-host';
exports.inject = ['slots', 'shortcuts'];
exports.apply = (ctx) => {
  ctx.effect(() => {
    const disposers = [];

    try {
      const slots = ctx.get('slots');
      disposers.push(
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'dsh-dashcam-panel', order: 13 }, DashcamMount),
        ),
      );
    } catch (error) {
      console.warn('[dsh-dashcam] shell.overlay 插槽注册失败：', error);
    }

    try {
      const shortcuts = ctx.get('shortcuts');
      disposers.push(
        shortcuts.register({
          id: 'dsh-dashcam:toggle-panel',
          regions: ['page'],
          combo: { primary: true, shift: true, code: 'KeyD' },
          title: 'Agent Dashcam 面板开关',
          run: () => {
            try {
              const engine = window.__DSH_DASHCAM_ENGINE__;
              if (engine && typeof engine.toggle === 'function') engine.toggle();
            } catch (error) {
              console.warn('[dsh-dashcam] 切换面板失败：', error);
            }
            return { handled: true };
          },
        }),
      );
    } catch (error) {
      console.warn('[dsh-dashcam] 快捷键注册失败：', error);
    }

    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch { /* 卸载失败不致命 */ }
      }
    };
  }, 'dsh-dashcam: client unmount');
};
