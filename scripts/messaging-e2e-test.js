'use strict';

const checkoutUrl = 'http://localhost:3000/checkout?slow=true';
const jaegerBaseUrl = 'http://localhost:16686/api/traces';

// 轮询 Jaeger，覆盖 Collector 的 8 秒尾采样等待与批量导出。
async function pollTrace(traceId, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    const response = await fetch(`${jaegerBaseUrl}/${traceId}`);
    const result = await response.json();
    if (result.data?.[0]) {
      return result.data[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`等待 Jaeger Trace 超时：${traceId}`);
}

// 找到指定服务和操作的 Span，避免同名操作跨服务误匹配。
function findSpan(jaegerTrace, serviceName, operationName) {
  return jaegerTrace.spans.find((span) => (
    span.operationName === operationName &&
    jaegerTrace.processes?.[span.processID]?.serviceName === serviceName
  ));
}

// 判断 Jaeger Span 是否包含指定类型、目标 Span ID 的引用。
function hasReference(span, refType, spanId) {
  return span.references?.some((reference) => (
    reference.refType === refType && reference.spanID === spanId
  ));
}

// 触发慢请求并验证真实 RabbitMQ → payment → Jaeger 链路。
async function main() {
  const response = await fetch(checkoutUrl);
  const body = await response.json();
  const traceId = response.headers.get('x-trace-id');

  if (!response.ok || !/^[a-f0-9]{32}$/.test(traceId || '')) {
    throw new Error(`checkout 请求失败：${response.status} ${JSON.stringify(body)}`);
  }

  const jaegerTrace = await pollTrace(traceId);
  const producer = findSpan(jaegerTrace, 'checkout-service', 'otel.demo.orders send');
  const consumer = findSpan(jaegerTrace, 'payment-service', 'otel.demo.orders process');
  const payment = findSpan(jaegerTrace, 'payment-service', 'process-payment');

  if (!producer || !consumer || !payment) {
    throw new Error('Trace 不完整：确认 payment-service 已启动，且普通 rabbitmq:consumer 未运行');
  }
  if (!hasReference(consumer, 'CHILD_OF', producer.spanID)) {
    throw new Error('Consumer Span 不是 Producer Span 的子级');
  }
  if (!hasReference(payment, 'CHILD_OF', consumer.spanID)) {
    throw new Error('process-payment 不是 Consumer Span 的子级');
  }
  if (!hasReference(payment, 'FOLLOWS_FROM', producer.spanID)) {
    throw new Error('process-payment 缺少指向 Producer Span 的 Link');
  }

  console.log('异步消息 Trace 验证通过：');
  console.log(`Trace ID：${traceId}`);
  console.log(`Jaeger：http://localhost:16686/trace/${traceId}`);
  console.log('Span 树：checkout Producer → payment Consumer → process-payment');
  console.log('Span Link：process-payment FOLLOWS_FROM checkout Producer');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
