'use strict';

/**
 * 多进程切片的示例插件（跑在子进程里）。
 * 它**不 require 任何原生能力模块**，唯一能做的 IO 就是通过 client 向宿主请求。
 * 这正是「子进程碰不到宿主文件系统」这一承诺的体现。
 */
const { startChildBridge } = require('../src/runtime/ipc/child');

startChildBridge({
  async onInvoke(payload, client) {
    if (!payload || typeof payload.path !== 'string') {
      throw new Error('missing payload.path');
    }
    const text = await client.fs.readFile(payload.path);
    return { ok: true, text };
  },
});

// 握手：告诉宿主监听器已就绪，可以开始发 invoke。
process.send({ kind: 'ready' });
