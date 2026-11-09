'use strict';

const { isQuarantined } = require('../contract/manifest');

const PLUGIN_ID = 'dsh-dashcam';

/**
 * 插件交付面（façade）的唯一定义。
 *
 * activate() 与 LocalHost 是两条装配路，此前各写各的交付面：activate() 交付
 * 封闭面，LocalHost 把裸 guard/ledger/seal 直接交给插件——插件在自己的
 * activate(ctx) 里 ctx.guard.setGrants([...]) 就能自我授权，uninstallNativeHooks
 * 能拆掉进程级 Hook，ctx.ledger.append / ctx.ledger.macKey 直接泄露审计密钥材料。
 * 两份装配代码改一份漏一份，这类洞只会再出现——所以交付面必须只有这一份定义。
 *
 * 交付的最小面：宿主集成真正需要的是只读判定句柄、能力句柄、隔离档位与
 * registerPreExecute（由各装配路自行附加）；guard 的管理面（setGrants /
 * uninstallNativeHooks /…）、账本实例与 OneSeal 一律不外借（内部仍走各自闭包）。
 */
function buildPluginFacade({ manifest = null, guard, handles, release = null }) {
  const facade = {
    id: PLUGIN_ID,
    quarantine: isQuarantined(manifest),
    guard: Object.freeze({
      // 参数原样透传：check/enforce 的签名演进不在这里截断。
      check: (...args) => guard.check(...args),
      enforce: (...args) => guard.enforce(...args),
      coverage: () => guard.coverage(),
    }),
    handles,
  };
  if (release) {
    // deactivate 与 dispose 统一到同一释放路径（H5）；release 自身必须幂等。
    facade.deactivate = release;
    facade.dispose = release;
  }
  return facade;
}

module.exports = { buildPluginFacade, PLUGIN_ID };
