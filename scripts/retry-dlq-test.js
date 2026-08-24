'use strict';

const {
  orderDeadLetterQueue,
  orderQueue,
  orderRetryQueue,
} = require('../messaging/rabbitmq-client');

const rabbitmqApiUrl = process.env.RABBITMQ_API_URL || 'http://localhost:15672/api';
const rabbitmqUsername = process.env.RABBITMQ_API_USER || 'otel';
const rabbitmqPassword = process.env.RABBITMQ_API_PASSWORD || 'otel-demo';
const authorization = `Basic ${Buffer.from(`${rabbitmqUsername}:${rabbitmqPassword}`).toString('base64')}`;

// 重复检查异步状态，覆盖重试 TTL、尾采样与批量导出延迟。
async function poll(check, attempts = 35) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('等待重试/DLQ 遥测数据超时');
}

// 查询 RabbitMQ 队列的 Ready、Unacked、Total 和 Consumer 数量。
async function getQueueState(queueName) {
  const response = await fetch(`${rabbitmqApiUrl}/queues/%2F/${encodeURIComponent(queueName)}`, {
    headers: { authorization },
  });
  if (!response.ok) {
    throw new Error(`RabbitMQ 队列不存在：${queueName}，请先启动 payment-service`);
  }
  const queue = await response.json();
  return {
    messages: queue.messages || 0,
    ready: queue.messages_ready || 0,
    unacked: queue.messages_unacknowledged || 0,
    consumers: queue.consumers || 0,
  };
}

// 读取后重新入队 DLQ 消息，验证 Payload 与传播 Header 而不删除学习数据。
async function findDeadLetter(orderId, traceId) {
  const response = await fetch(`${rabbitmqApiUrl}/queues/%2F/${encodeURIComponent(orderDeadLetterQueue)}/get`, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      count: 50,
      ackmode: 'ack_requeue_true',
      encoding: 'auto',
      truncate: 50000,
    }),
  });
  if (!response.ok) {
    throw new Error('无法读取 DLQ 消息');
  }
  const messages = await response.json();
  return messages.find((message) => {
    try {
      const payload = JSON.parse(message.payload);
      const headers = message.properties?.headers || {};
      return payload.orderId === orderId &&
        Number(headers['x-retry-count']) === 2 &&
        String(headers.traceparent || '').includes(traceId);
    } catch (error) {
      return false;
    }
  });
}

// 触发固定 checkout 场景并返回关联标识。
async function triggerScenario(queryName, expectedScenario) {
  const response = await fetch(`http://localhost:3000/checkout?${queryName}=true`);
  const body = await response.json();
  const traceId = response.headers.get('x-trace-id');
  if (!response.ok || body.scenario !== expectedScenario || !/^[a-f0-9]{32}$/.test(traceId || '')) {
    throw new Error(`${expectedScenario} 造数失败：${response.status} ${JSON.stringify(body)}`);
  }
  return { orderId: body.orderId, traceId };
}

// 从 Jaeger 获取一条包含指定数量消息消费 Span 的完整 Trace。
async function verifyTrace(traceId, expectedFinalRoute) {
  return poll(async () => {
    const response = await fetch(`http://localhost:16686/api/traces/${traceId}`);
    const result = await response.json();
    const jaegerTrace = result.data?.[0];
    if (!jaegerTrace) {
      return undefined;
    }
    const paymentSpans = jaegerTrace.spans.filter((span) => (
      jaegerTrace.processes?.[span.processID]?.serviceName === 'payment-service'
    ));
    const consumers = paymentSpans.filter((span) => span.operationName === `${orderQueue} process`);
    const retrySends = paymentSpans.filter((span) => span.operationName === `${orderRetryQueue} send`);
    const deadLetterSends = paymentSpans.filter((span) => span.operationName === `${orderDeadLetterQueue} send`);
    if (consumers.length !== 3 || retrySends.length !== 2) {
      return undefined;
    }
    if (expectedFinalRoute === 'paid' && deadLetterSends.length !== 0) {
      throw new Error('临时故障不应进入 DLQ');
    }
    if (expectedFinalRoute === 'dead-letter' && deadLetterSends.length !== 1) {
      return undefined;
    }
    const retryCounts = consumers.map((span) => (
      span.tags?.find((tag) => tag.key === 'demo.payment.retry.count')?.value
    )).sort();
    if (JSON.stringify(retryCounts) !== JSON.stringify([0, 1, 2])) {
      throw new Error(`Consumer 重试次数不正确：${JSON.stringify(retryCounts)}`);
    }
    return jaegerTrace;
  });
}

// 验证 Loki 中记录了两次 retry，以及最终成功或进入 DLQ。
async function verifyLogs(traceId, expectedFinalMessage) {
  return poll(async () => {
    const url = new URL('http://localhost:3100/loki/api/v1/query_range');
    url.searchParams.set('query', `{service_name="payment-service"} |= "${traceId}"`);
    url.searchParams.set('limit', '50');
    const response = await fetch(url);
    const result = await response.json();
    const lines = (result.data?.result || []).flatMap((stream) => (
      stream.values?.map((value) => value[1]) || []
    ));
    const retryLogs = lines.filter((line) => line.includes('支付失败，消息进入重试队列'));
    return retryLogs.length >= 2 && lines.some((line) => line.includes(expectedFinalMessage));
  });
}

// 顺序验证临时故障恢复和永久故障入死信队列。
async function main() {
  const initialMain = await getQueueState(orderQueue);
  const initialRetry = await getQueueState(orderRetryQueue);
  const initialDeadLetter = await getQueueState(orderDeadLetterQueue);
  if (initialMain.consumers !== 1) {
    throw new Error(`主队列 Consumer 应为 1，当前为 ${initialMain.consumers}；请关闭重复 payment-service`);
  }
  if (initialMain.messages || initialRetry.messages) {
    throw new Error('主队列或重试队列仍有历史消息，请等待处理完成后重试');
  }

  const recovered = await triggerScenario('paymentRetry', 'payment-retry');
  await Promise.all([
    verifyTrace(recovered.traceId, 'paid'),
    verifyLogs(recovered.traceId, '异步支付完成'),
  ]);
  const afterRecoveryDeadLetter = await getQueueState(orderDeadLetterQueue);
  if (afterRecoveryDeadLetter.messages !== initialDeadLetter.messages) {
    throw new Error('临时故障恢复后 DLQ 数量不应增加');
  }
  console.log(`临时故障重试成功：${recovered.orderId}，Trace ID：${recovered.traceId}`);

  const deadLettered = await triggerScenario('paymentDlq', 'payment-dlq');
  await Promise.all([
    verifyTrace(deadLettered.traceId, 'dead-letter'),
    verifyLogs(deadLettered.traceId, '支付失败，消息进入死信队列'),
    poll(async () => {
      const queue = await getQueueState(orderDeadLetterQueue);
      return queue.messages === initialDeadLetter.messages + 1;
    }),
    poll(() => findDeadLetter(deadLettered.orderId, deadLettered.traceId)),
  ]);
  console.log(`永久故障进入 DLQ：${deadLettered.orderId}，Trace ID：${deadLettered.traceId}`);
  console.log(`RabbitMQ：http://localhost:15672/#/queues/%2F/${encodeURIComponent(orderDeadLetterQueue)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
