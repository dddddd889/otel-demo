'use strict';

const shutdownHooks = [];

// 注册需在 OTel SDK 关闭前完成的应用资源清理函数。
function registerShutdownHook(shutdownHook) {
  shutdownHooks.push(shutdownHook);
}

// 按注册逆序运行清理，先停止后加载的业务资源，再刷新遥测 SDK。
async function runShutdownHooks() {
  const hooks = shutdownHooks.splice(0).reverse();
  for (const shutdownHook of hooks) {
    await shutdownHook();
  }
}

module.exports = {
  registerShutdownHook,
  runShutdownHooks,
};
