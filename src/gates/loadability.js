'use strict';

const { gateError } = require('../errors');
const { createStage, finishStage } = require('./report');

const PHASES = ['install', 'register', 'invoke', 'uninstall'];

/**
 * 可装载性门禁：真实宿主装 → 注册 → 调用 → 卸载。
 * 必须在签名、结构、安全门禁之后再运行，因为它会执行插件代码。
 */
async function checkLoadability({
  pluginDir,
  host,
  pluginId,
  action = 'ping',
  expected,
  policy = {},
} = {}) {
  const stage = createStage('loadability');
  if (!host) {
    stage.status = 'skip';
    return { stage, phases: PHASES.map((phase) => ({ phase, status: 'skip' })), error: null };
  }

  const phases = [];
  let installed = false;
  let registered = false;
  let failure = null;

  const run = async (phase, fn) => {
    const started = Date.now();
    try {
      const result = await fn();
      phases.push({ phase, status: 'pass', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const entry = gateError('loadability', 'phase_failed', error.message, {
        phase,
        field: phase,
      });
      stage.errors.push(entry);
      phases.push({ phase, status: 'fail', durationMs: Date.now() - started, error: error.message });
      failure = { phase, error };
      throw error;
    }
  };

  try {
    await run('install', () => host.install(pluginDir));
    installed = true;
    await run('register', () => host.register(pluginId));
    registered = true;
    const result = await run('invoke', async () => {
      const value = await host.invoke(pluginId, action);
      if (expected !== undefined && JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error(`调用结果不符合预期：${JSON.stringify(value)}`);
      }
      return value;
    });
  } catch (error) {
    if (!stage.errors.length) {
      stage.errors.push(gateError('loadability', 'phase_failed', error.message, {
        phase: failure ? failure.phase : 'unknown',
        field: failure ? failure.phase : 'unknown',
      }));
    }
  } finally {
    if (installed) {
      try {
        await run('uninstall', () => host.uninstall(pluginId));
      } catch {
        // 已在 run 内记录。
      }
    } else if (registered) {
      try {
        await host.uninstall(pluginId);
      } catch {
        // 清理失败不覆盖首个失败点。
      }
    }
  }

  return { stage: finishStage(stage), phases, error: failure };
}

module.exports = { checkLoadability, PHASES };
