'use strict';

const http = require('http');
const express = require('express');
const { Histogram, Registry } = require('prom-client');
const { context, metrics, propagation, trace, SpanStatusCode } = require('@opentelemetry/api');
const { createTelemetryLogger } = require('./telemetry-logger');

// 结账服务的基础配置。
const app = express();
const port = Number(process.env.PORT || 3000);
const inventoryUrl = process.env.INVENTORY_URL || 'http://localhost:3002/inventory/SKU-001';
const tracer = trace.getTracer('checkout-demo', '2.0.0');
const meter = metrics.getMeter('checkout-demo', '2.0.0');
const writeLog = createTelemetryLogger('checkout-demo', '2.0.0');
const jaegerPublicUrl = process.env.JAEGER_PUBLIC_URL || 'http://localhost:16686';
const grafanaPublicUrl = process.env.GRAFANA_PUBLIC_URL || 'http://localhost:3001';
const prometheusPublicUrl = process.env.PROMETHEUS_PUBLIC_URL || 'http://localhost:9090';

// 根据当前 Trace ID 生成可直接打开的可观测性查询链接。
function createObservabilityLinks(traceId, scenario) {
  const lokiExpression = `{service_name=~"checkout-service|inventory-service"} |= "${traceId}"`;
  const exploreState = {
    traceLogs: {
      datasource: 'loki',
      queries: [{ refId: 'A', expr: lokiExpression, queryType: 'range' }],
      range: { from: 'now-15m', to: 'now' },
    },
  };
  const prometheusExpression = `checkout_request_duration_seconds_count{demo_scenario="${scenario}"}`;

  return {
    traceId,
    jaeger: `${jaegerPublicUrl}/trace/${traceId}`,
    grafanaLogs: `${grafanaPublicUrl}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(exploreState))}`,
    prometheus: `${prometheusPublicUrl}/query?g0.expr=${encodeURIComponent(prometheusExpression)}&g0.tab=0`,
    grafanaDashboard: `${grafanaPublicUrl}/dashboards`,
  };
}

// 将查询参数归一化为固定场景名，避免遥测属性产生无限基数。
function getScenario(query) {
  if (query.slow === 'true') {
    return 'slow';
  }
  if (query.dbError === 'true') {
    return 'db-error';
  }
  if (query.redisError === 'true') {
    return 'redis-error';
  }
  if (query.fail === 'true') {
    return 'business-error';
  }
  return 'normal';
}

// OpenMetrics 注册表：专门演示带 Trace ID 的 Prometheus Exemplar。
const prometheusRegistry = new Registry();
prometheusRegistry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
const exemplarRequestDuration = new Histogram({
  name: 'checkout_request_duration_seconds',
  help: '结账请求耗时，附带可跳转 Trace 的 Exemplar',
  labelNames: ['http_request_method', 'http_route', 'http_response_status_code', 'demo_scenario'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  enableExemplars: true,
  registers: [prometheusRegistry],
});

// 请求计数器：在 Prometheus 中显示每个接口、状态码的请求量。
const requestCounter = meter.createCounter('checkout.requests', {
  description: 'Demo HTTP 请求总数',
});

// 请求耗时直方图：通过 OTLP 导出标准 OpenTelemetry 指标。
const requestDuration = meter.createHistogram('checkout.request.duration', {
  description: 'Demo HTTP 请求耗时',
  unit: 'ms',
});

// 订单失败计数器：演示业务错误指标，而不仅仅是 HTTP 指标。
const checkoutFailureCounter = meter.createCounter('checkout.failures', {
  description: '结账失败总数',
});

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

// 调用库存服务；Node.js HTTP 自动插桩会注入 traceparent 和 baggage 请求头。
function queryInventory(scenario) {
  return new Promise((resolve, reject) => {
    const requestUrl = new URL(inventoryUrl);
    if (scenario === 'db-error' || scenario === 'redis-error') {
      requestUrl.searchParams.set('failure', scenario);
    }

    const request = http.get(requestUrl, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`库存服务返回 ${response.statusCode}: ${body}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`库存服务返回无效 JSON: ${error.message}`));
        }
      });
    });

    request.setTimeout(3000, () => request.destroy(new Error('库存服务请求超时')));
    request.on('error', reject);
  });
}

// 返回当前 Trace ID，方便调用方拿到 ID 后直接查询 Jaeger 或 Loki。
app.use((request, response, next) => {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;

  if (traceId) {
    response.setHeader('X-Trace-Id', traceId);
  }

  next();
});

// 在业务路由之前统计每次请求的数量、状态码和耗时。
app.use((request, response, next) => {
  const startedAt = process.hrtime.bigint();
  const requestContext = context.active();

  response.once('finish', () => {
    if (request.path === '/health' || request.path === '/metrics') {
      return;
    }

    const durationMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const metricAttributes = {
      'http.request.method': request.method,
      'http.route': request.route?.path || request.path,
      'http.response.status_code': response.statusCode,
      'demo.scenario': getScenario(request.query),
    };

    // 使用请求开始时的上下文记录指标，使 Histogram Exemplar 携带 Trace ID。
    context.with(requestContext, () => {
      requestCounter.add(1, metricAttributes);
      requestDuration.record(durationMilliseconds, metricAttributes);

      const spanContext = trace.getSpanContext(requestContext);
      exemplarRequestDuration.observe({
        labels: {
          http_request_method: request.method,
          http_route: request.route?.path || request.path,
          http_response_status_code: String(response.statusCode),
          demo_scenario: getScenario(request.query),
        },
        value: durationMilliseconds / 1000,
        exemplarLabels: spanContext ? {
          trace_id: spanContext.traceId,
          span_id: spanContext.spanId,
        } : {},
      });
    });
  });

  next();
});

app.get('/', (request, response) => {
  response.json({
    message: 'OpenTelemetry Node.js Demo',
    endpoints: [
      '/checkout',
      '/checkout?slow=true',
      '/checkout?dbError=true',
      '/checkout?redisError=true',
      '/checkout?fail=true',
      '/health',
    ],
    interfaces: {
      jaeger: jaegerPublicUrl,
      grafana: grafanaPublicUrl,
      prometheus: prometheusPublicUrl,
    },
  });
});

app.get('/health', (request, response) => {
  response.json({ status: 'ok' });
});

app.get('/metrics', async (request, response) => {
  response.setHeader('Content-Type', prometheusRegistry.contentType);
  response.end(await prometheusRegistry.metrics());
});

app.get('/checkout', async (request, response) => {
  // Baggage 会随跨服务 HTTP 请求传播，但不作为高基数指标标签使用。
  const cartId = `cart-${Date.now()}`;
  const baggage = propagation.createBaggage({
    'demo.cart.id': { value: cartId },
    'demo.tenant.id': { value: 'demo-shop' },
  });
  const baggageContext = propagation.setBaggage(context.active(), baggage);
  const scenario = getScenario(request.query);

  return context.with(baggageContext, async () => {
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    const observability = traceId ? createObservabilityLinks(traceId, scenario) : undefined;
    const activeSpan = trace.getActiveSpan();
    activeSpan?.setAttribute('demo.scenario', scenario);

    try {
      writeLog('INFO', '开始处理结账请求', {
        'demo.cart.id': cartId,
        'demo.cart.item_count': 3,
        'demo.scenario': scenario,
      });
      await runStep('validate-cart', 80, {
        'demo.cart.id': cartId,
        'demo.cart.item_count': 3,
      });

      const inventory = await queryInventory(scenario);

      if (scenario === 'business-error') {
        throw new Error('模拟库存不足');
      }

      if (scenario === 'slow') {
        await runStep('simulate-slow-checkout', 1200, {
          'demo.scenario': scenario,
          'demo.delay.ms': 1200,
        });
      }

      await runStep('create-order', 160, {
        'demo.order.currency': 'CNY',
        'demo.order.amount': 199,
        'demo.inventory.stock': inventory.stock,
        'demo.scenario': scenario,
      });

      writeLog('INFO', '订单创建成功', {
        'demo.cart.id': cartId,
        'demo.order.amount': 199,
        'demo.inventory.stock': inventory.stock,
      });

      response.json({
        orderId: `order-${Date.now()}`,
        status: 'created',
        scenario,
        inventory,
        observability,
      });
    } catch (error) {
      activeSpan?.recordException(error);
      activeSpan?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      activeSpan?.setAttribute('demo.scenario', scenario);
      checkoutFailureCounter.add(1, {
        'error.type': error.name,
        'demo.scenario': scenario,
      });
      writeLog('ERROR', '创建订单失败', {
        'demo.cart.id': cartId,
        'error.type': error.name,
        'error.message': error.message,
        'demo.scenario': scenario,
      });
      response.status(500).json({
        error: error.message,
        scenario,
        observability,
      });
    }
  });
});

app.listen(port, () => {
  writeLog('INFO', `结账服务已启动：http://localhost:${port}`);
  console.log('Grafana：http://localhost:3001');
});
