'use strict';

const express = require('express');
const { metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const app = express();
const port = Number(process.env.PORT || 3000);
const tracer = trace.getTracer('checkout-demo', '1.0.0');
const meter = metrics.getMeter('checkout-demo', '1.0.0');
const logger = logs.getLogger('checkout-demo', '1.0.0');

// 请求计数器：在 Prometheus 中显示每个接口、状态码的请求量。
const requestCounter = meter.createCounter('checkout.requests', {
  description: 'Demo HTTP 请求总数',
});

// 请求耗时直方图：用于计算平均值和 P95 等延迟指标。
const requestDuration = meter.createHistogram('checkout.request.duration', {
  description: 'Demo HTTP 请求耗时',
  unit: 'ms',
});

// 订单失败计数器：演示业务错误指标，而不仅仅是 HTTP 指标。
const checkoutFailureCounter = meter.createCounter('checkout.failures', {
  description: '结账失败总数',
});

// 同时写入终端和 OpenTelemetry，日志正文携带 trace_id 以支持从 Loki 跳转到 Jaeger。
function writeLog(severityText, message, attributes = {}) {
  const activeSpan = trace.getActiveSpan();
  const spanContext = activeSpan?.spanContext();
  const traceId = spanContext?.traceId;
  const spanId = spanContext?.spanId;
  const body = traceId ? `${message} trace_id=${traceId} span_id=${spanId}` : message;
  const severityNumbers = {
    INFO: SeverityNumber.INFO,
    ERROR: SeverityNumber.ERROR,
  };

  logger.emit({
    severityNumber: severityNumbers[severityText] || SeverityNumber.INFO,
    severityText,
    body,
    attributes: {
      ...attributes,
      ...(traceId ? { 'demo.trace_id': traceId, 'demo.span_id': spanId } : {}),
    },
  });

  const consoleMethod = severityText === 'ERROR' ? console.error : console.log;
  consoleMethod(JSON.stringify({ severity: severityText, message, traceId, spanId, ...attributes }));
}

// 模拟异步业务耗时。
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 在当前请求链路下创建一个业务 Span，并记录业务属性。
async function runStep(spanName, duration, attributes = {}) {
  return tracer.startActiveSpan(spanName, async (span) => {
    try {
      span.setAttributes(attributes);
      await delay(duration);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

// 在业务路由之前统计每次请求的数量、状态码和耗时。
app.use((request, response, next) => {
  const startedAt = process.hrtime.bigint();

  response.once('finish', () => {
    const durationMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const metricAttributes = {
      'http.request.method': request.method,
      'http.route': request.route?.path || request.path,
      'http.response.status_code': response.statusCode,
    };

    requestCounter.add(1, metricAttributes);
    requestDuration.record(durationMilliseconds, metricAttributes);
  });

  next();
});

app.get('/', (request, response) => {
  response.json({
    message: 'OpenTelemetry Node.js Demo',
    endpoints: ['/checkout', '/checkout?fail=true', '/health'],
  });
});

app.get('/health', (request, response) => {
  response.json({ status: 'ok' });
});

app.get('/checkout', async (request, response) => {
  try {
    writeLog('INFO', '开始处理结账请求', { 'demo.cart.item_count': 3 });
    await runStep('validate-cart', 80, {
      'demo.cart.item_count': 3,
    });
    await runStep('query-inventory', 120, {
      'demo.inventory.warehouse': 'shanghai-01',
    });

    if (request.query.fail === 'true') {
      throw new Error('模拟库存不足');
    }

    await runStep('create-order', 160, {
      'demo.order.currency': 'CNY',
      'demo.order.amount': 199,
    });

    writeLog('INFO', '订单创建成功', { 'demo.order.amount': 199 });

    response.json({
      orderId: `order-${Date.now()}`,
      status: 'created',
    });
  } catch (error) {
    const activeSpan = trace.getActiveSpan();
    activeSpan?.recordException(error);
    activeSpan?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    checkoutFailureCounter.add(1, { 'error.type': error.name });
    writeLog('ERROR', '创建订单失败', {
      'error.type': error.name,
      'error.message': error.message,
    });
    response.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  writeLog('INFO', `Demo 已启动：http://localhost:${port}`);
  console.log('Grafana：http://localhost:3001');
});
