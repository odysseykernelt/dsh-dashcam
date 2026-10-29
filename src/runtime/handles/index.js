'use strict';

const { createFsHandle } = require('./fs');
const { createNetHandle } = require('./net');
const { createProcHandle } = require('./proc');

/**
 * 给插件一套能力句柄，替代「直接摸全局」。
 * 每个面都是封闭集合：未列出的方法不存在，也不接受 fd 之类的底层句柄。
 */
function createCapabilityHandles({ guard, limits = null } = {}) {
  if (!guard || typeof guard.enforce !== 'function') {
    throw new Error('createCapabilityHandles 需要 guard');
  }
  return Object.freeze({
    fs: createFsHandle({ guard }),
    // limits 必须一路传到 net：fetchTimeoutMs 是在句柄**创建时**读取的，
    // 中间这一跳吞掉参数，宿主设的超时就会静默失效（上一轮 H1 的同类型病灶）。
    net: createNetHandle({ guard, limits }),
    proc: createProcHandle({ guard }),
  });
}

module.exports = {
  createCapabilityHandles,
  createFsHandle,
  createNetHandle,
  createProcHandle,
  ...require('./inject'),
};
