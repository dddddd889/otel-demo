'use strict';

const { createManualHttpPatch } = require('./manual-http-patch');
const { setupManualTelemetry } = require('./manual-telemetry');

const mode = process.argv[2] || 'baseline';
const supportedModes = new Set(['baseline', 'manual', 'official']);

// 启动一个随机端口的下游服务，回显它实际收到的 traceparent。
function startDownstreamServer(httpModule) {
  const server = httpModule.createServer((request, response) => {
    const traceparent = request.headers.traceparent || '无';
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ traceparent }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 使用 options-object 形式调用 http.get，与手写 patch 的教学边界一致。
function requestDownstream(httpModule, port) {
  return new Promise((resolve, reject) => {
    const request = httpModule.get({
      hostname: '127.0.0.1',
      port,
      path: '/downstream',
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve(JSON.parse(body)));
    });
    request.once('error', reject);
  });
}

// 关闭 HTTP Server，并等待所有现有连接结束。
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// 顺序执行三种模式中的一种，并打印可直接比较的结果。
async function main() {
  if (!supportedModes.has(mode)) {
    throw new Error(`未知模式：${mode}`);
  }

  let manualTelemetry;
  let manualPatch;
  if (mode === 'manual') {
    manualTelemetry = setupManualTelemetry();
  }

  // require 发生在 telemetry 初始化之后，避免提前缓存 http 导致官方 patch 失效。
  const http = require('http');
  if (mode === 'manual') {
    manualPatch = createManualHttpPatch(http);
    manualPatch.enable();
  }

  const server = await startDownstreamServer(http);
  try {
    const address = server.address();
    const result = await requestDownstream(http, address.port);
    console.log(`[RESULT] mode=${mode} downstream_traceparent=${result.traceparent}`);
  } finally {
    await closeServer(server);
    manualPatch?.disable();
    await manualTelemetry?.shutdown();
    await globalThis.__autoInstrumentationLabSdk?.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
