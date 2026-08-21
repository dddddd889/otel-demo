'use strict';

const { spawn } = require('child_process');

// 两个服务的进程配置；每个进程独立初始化 OpenTelemetry SDK。
const serviceDefinitions = [
  {
    name: 'checkout-service',
    script: 'app.js',
    env: { PORT: '3000', OTEL_SERVICE_NAME: 'checkout-service' },
  },
  {
    name: 'inventory-service',
    script: 'inventory-service.js',
    env: { PORT: '3002', OTEL_SERVICE_NAME: 'inventory-service' },
  },
];

// 关闭标记：防止多个子进程退出事件重复触发清理。
let shuttingDown = false;

// 子进程集合：用于任一服务退出时统一清理。
const children = serviceDefinitions.map((service) => {
  const child = spawn(process.execPath, ['--require', './instrumentation.js', service.script], {
    env: { ...process.env, ...service.env },
    stdio: 'inherit',
  });

  child.once('exit', (code, signal) => {
    // Ctrl+C 会同时送达父子进程；延后一轮判断，让父进程先进入统一关闭状态。
    setImmediate(() => {
      if (shuttingDown) {
        return;
      }

      console.error(`${service.name} 意外退出，退出码：${code}，信号：${signal || '无'}`);
      shutdown('SIGTERM', code || 1);
    });
  });
  child.once('error', (error) => {
    console.error(`${service.name} 启动失败：${error.message}`);
    shutdown('SIGTERM', 1);
  });

  return child;
});

// 将终止信号转发给两个服务，确保 SDK 有机会刷新遥测数据。
function shutdown(signal, exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  if (exitCode !== undefined) {
    process.exitCode = exitCode;
  }

  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
