'use strict';

const express = require('express');
const mysql = require('mysql2/promise');
const { createClient } = require('redis');
const { propagation, context, trace, SpanStatusCode } = require('@opentelemetry/api');
const { createTelemetryLogger } = require('./telemetry-logger');

// 库存服务及其依赖配置。
const app = express();
const port = Number(process.env.PORT || 3002);
const writeLog = createTelemetryLogger('inventory-demo', '1.0.0');
const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'otel',
  password: process.env.MYSQL_PASSWORD || 'otel-demo',
  database: process.env.MYSQL_DATABASE || 'otel_demo',
  connectionLimit: 4,
});
const supportedFailureModes = new Set(['db-error', 'redis-error']);

// 将公开查询参数限制为固定枚举，防止遥测属性产生无限基数。
function getFailureMode(value) {
  return supportedFailureModes.has(value) ? value : 'none';
}

// Redis 会通过 EventEmitter 报告后台连接错误；监听后由后续请求触发重连。
redisClient.on('error', (error) => {
  writeLog('ERROR', 'Redis 连接异常', {
    'error.type': error.name,
    'error.message': error.message,
  });
});

// Redis 连接 Promise：确保并发请求只触发一次连接。
let redisConnectionPromise;

// 获取已连接的 Redis 客户端。
async function getRedisClient() {
  if (!redisClient.isOpen) {
    redisConnectionPromise ||= redisClient.connect();
    try {
      await redisConnectionPromise;
    } finally {
      // 每次连接尝试结束后复位；连接后续断开时可再次调用 connect。
      redisConnectionPromise = undefined;
    }
  }

  return redisClient;
}

app.get('/health', (request, response) => {
  response.json({ status: 'ok' });
});

app.get('/inventory/:sku', async (request, response) => {
  const sku = request.params.sku;
  const failureMode = getFailureMode(request.query.failure);
  const baggage = propagation.getBaggage(context.active());
  const cartId = baggage?.getEntry('demo.cart.id')?.value;
  const tenantId = baggage?.getEntry('demo.tenant.id')?.value;

  try {
    const redis = await getRedisClient();
    const cacheKey = `inventory:${sku}`;
    const cachedStock = failureMode === 'redis-error'
      ? await redis.sendCommand(['GET'])
      : await redis.get(cacheKey);
    const [rows] = failureMode === 'db-error'
      ? await mysqlPool.execute('SELECT missing_stock FROM inventory WHERE sku = ?', [sku])
      : await mysqlPool.execute('SELECT stock FROM inventory WHERE sku = ?', [sku]);
    const stock = rows[0]?.stock ?? Number(cachedStock ?? 0);

    await redis.setEx(cacheKey, 30, String(stock));
    writeLog('INFO', '库存查询完成', {
      'demo.cart.id': cartId || 'missing',
      'demo.tenant.id': tenantId || 'missing',
      'demo.inventory.sku': sku,
      'demo.inventory.stock': stock,
      'demo.inventory.cache_present': cachedStock !== null,
      'demo.scenario': failureMode,
    });

    response.json({ sku, stock, cachePresent: cachedStock !== null });
  } catch (error) {
    const activeSpan = trace.getActiveSpan();
    activeSpan?.recordException(error);
    activeSpan?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    activeSpan?.setAttribute('demo.scenario', failureMode);
    writeLog('ERROR', '库存查询失败', {
      'demo.cart.id': cartId || 'missing',
      'demo.tenant.id': tenantId || 'missing',
      'demo.inventory.sku': sku,
      'demo.scenario': failureMode,
      'error.type': error.name,
      'error.message': error.message,
    });
    response.status(503).json({ error: error.message, scenario: failureMode });
  }
});

app.listen(port, () => {
  writeLog('INFO', `库存服务已启动：http://localhost:${port}`);
});
