'use strict';

const childProcess = require('node:child_process');
const { firstCommand } = require('../bridge');

/**
 * 进程能力句柄：新建进程与发信号，是两件必须分开授权的事。
 *
 * 封闭性同 fs / net 句柄：
 *  1. 方法集合闭集，未列出的入口不存在（不提供 child_process 模块本身）；
 *  2. 判定发生在**调用时**，command / target 每次现算；
 *  3. 命令名的口径与 Bridge 完全一致：直接复用 bridge.firstCommand，
 *     不另写一份解析逻辑，否则「句柄放行、Bridge 拒绝」这种错位迟早出现；
 *  4. 对象冻结，插件不能替换方法绕过守卫。
 */
const SPAWN_METHODS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

function createProcHandle({ guard } = {}) {
  if (!guard || typeof guard.enforce !== 'function') {
    throw new Error('createProcHandle 需要 guard');
  }

  // 创建时钉住原生入口，避免插件替换 child_process.* 影响句柄的实际行为。
  const nativeKill = process.kill;

  function guardSpawn(args) {
    guard.enforce('proc.spawn', { command: firstCommand(args) });
  }

  function makeSpawnLike(name) {
    const original = childProcess[name];
    if (typeof original !== 'function') return undefined;
    return function capabilitySpawn(...args) {
      guardSpawn(args);
      return original.apply(childProcess, args);
    };
  }

  /**
   * 信号目标的三种口径：
   *  - 自己：pid === process.pid；
   *  - 整个进程组：pid === 0（POSIX 语义，也是唯一能表达「子进程组」的写法）；
   *  - 其它：一律 pid:<数字>，交给 scope 里的 targets 精确匹配。
   * 与 bridge.installProc 的映射逐字一致，避免两套语义。
   */
  function signalTarget(pid) {
    if (pid === process.pid) return 'self';
    if (pid === 0) return 'children';
    return `pid:${pid}`;
  }

  function kill(pid, signal) {
    guard.enforce('proc.signal', { target: signalTarget(pid) });
    return nativeKill.call(process, pid, signal);
  }

  const handle = { kill };
  for (const name of SPAWN_METHODS) {
    const bound = makeSpawnLike(name);
    if (bound) handle[name] = bound;
  }

  Object.defineProperty(handle, 'coverage', {
    value: () => ({
      kind: 'proc-handle',
      closed: true,
      methods: Object.keys(handle).sort(),
      note: '句柄只给进程创建与信号：每次调用现场判定，child_process / process.kill 本身不暴露。',
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(handle);
}

module.exports = { createProcHandle };
