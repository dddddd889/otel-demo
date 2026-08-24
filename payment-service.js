'use strict';

const { randomUUID } = require('crypto');
const { context, propagation, trace } = require('@opentelemetry/api');
const {
  connectRabbitMQ,
  ensurePaymentQueues,
  orderDeadLetterQueue,
  orderQueue,
  orderRetryQueue,
} = require('./messaging/rabbitmq-client');
const { extractMessageContext, injectMessageContext } = require('./messaging/message-context');
const {
  runConsumerSpan,
  runFailureRouteSpan,
  runPaymentSpan,
} = require('./messaging/messaging-spans');
const {
  createRetryHeaders,
  decideFailureRoute,
  defaultMaxRetries,
  getRetryCount,
  retryDelayMilliseconds,
} = require('./messaging/payment-retry');
const { createTelemetryLogger } = require('./telemetry-logger');
const { registerShutdownHook } = require('./shutdown-coordinator');

const writeLog = createTelemetryLogger('payment-demo', '1.0.0');

// 校验订单消息，并根据固定教学场景模拟临时或永久支付故障。
async function processOrderMessage(orderMessage, retryCount = 0) {
  if (!orderMessage?.orderId) {
    throw new Error('订单消息缺少 orderId');
  }
  if (!Number.isFinite(orderMessage.amount) || orderMessage.amount <= 0) {
    throw new Error('订单消息 amount 必须为正数');
  }
  if (!orderMessage.currency) {
    throw new Error('订单消息缺少 currency');
  }
  if (orderMessage.scenario === 'payment-retry' && retryCount < 2) {
    throw new Error('模拟支付网关临时故障');
  }
  if (orderMessage.scenario === 'payment-dlq') {
    throw new Error('模拟支付永久失败');
  }

  return {
    paymentId: `payment-${randomUUID()}`,
    orderId: orderMessage.orderId,
    status: 'paid',
    amount: orderMessage.amount,
    currency: orderMessage.currency,
    paidAt: new Date().toISOString(),
  };
}

// 将解析后的订单字段补充到 Consumer Span，避免坏 JSON 阻止 Span 创建。
function createConsumerOrderAttributes(orderMessage) {
  const attributes = {};
  if (orderMessage?.messageId) {
    attributes['messaging.message.id'] = orderMessage.messageId;
  }
  if (orderMessage?.orderId) {
    attributes['demo.order.id'] = orderMessage.orderId;
  }
  if (orderMessage?.scenario) {
    attributes['demo.scenario'] = orderMessage.scenario;
  }
  return attributes;
}

// 将失败消息可靠发布到重试队列或死信队列，并等待 Broker Confirm。
async function routeFailedMessage(channel, message, orderMessage, retryCount, error) {
  const decision = decideFailureRoute(retryCount);
  const destinationQueue = decision.action === 'retry' ? orderRetryQueue : orderDeadLetterQueue;
  const messageMetadata = {
    messageId: message.properties.messageId || orderMessage?.messageId,
    orderId: orderMessage?.orderId,
    retryCount: decision.nextRetryCount,
  };

  await runFailureRouteSpan(messageMetadata, decision.action, async () => {
    const propagationHeaders = injectMessageContext();
    const headers = createRetryHeaders({
      ...message.properties.headers,
      ...propagationHeaders,
    }, decision.nextRetryCount);
    channel.sendToQueue(destinationQueue, message.content, {
      persistent: true,
      contentType: message.properties.contentType || 'application/json',
      headers,
      messageId: messageMetadata.messageId,
    });
    await channel.waitForConfirms();

    writeLog('ERROR', decision.action === 'retry' ? '支付失败，消息进入重试队列' : '支付失败，消息进入死信队列', {
      'demo.order.id': messageMetadata.orderId || 'unknown',
      'demo.payment.retry.count': decision.nextRetryCount,
      'demo.payment.failure.route': decision.action,
      'demo.scenario': orderMessage?.scenario || 'invalid-message',
      'error.type': error.name,
      'error.message': error.message,
    });
  });

  return { decision, destinationQueue };
}

// 处理单条支付消息；Broker 异常时保留原消息并通知进程关闭。
async function handlePaymentMessage(channel, message, onInfrastructureFailure = async () => {}) {
  if (!message) {
    return;
  }

  const messageContext = extractMessageContext(message.properties.headers);
  const retryCount = getRetryCount(message.properties.headers);
  let ackAttempted = false;
  let messageSettled = false;
  try {
    await runConsumerSpan(messageContext, {
      messageId: message.properties.messageId,
      retryCount,
    }, async (consumerSpan) => {
      let orderMessage;
      let payment;
      try {
        orderMessage = JSON.parse(message.content.toString('utf8'));
        consumerSpan.setAttributes({
          ...createConsumerOrderAttributes(orderMessage),
          'demo.payment.retry.count': retryCount,
        });
        payment = await runPaymentSpan(messageContext, {
          ...orderMessage,
          retryCount,
        }, async () => {
          const spanContext = trace.getSpanContext(context.active());
          const baggage = propagation.getBaggage(context.active());
          const cartId = baggage?.getEntry('demo.cart.id')?.value;
          const tenantId = baggage?.getEntry('demo.tenant.id')?.value;
          console.log(`payment-service 恢复消息上下文：trace_id=${spanContext?.traceId || '无'} cart_id=${cartId || '无'} tenant_id=${tenantId || '无'}`);
          console.log(`payment-service 开始处理订单：${orderMessage.orderId || '未知订单'}，第 ${retryCount + 1} 次尝试`);
          const paymentResult = await processOrderMessage(orderMessage, retryCount);
          console.log('payment-service 支付完成：');
          console.log(JSON.stringify(paymentResult, null, 2));
          const logAttributes = {
            'demo.order.id': paymentResult.orderId,
            'demo.payment.id': paymentResult.paymentId,
            'demo.payment.retry.count': retryCount,
            'demo.scenario': orderMessage.scenario || 'normal',
          };
          if (cartId) {
            logAttributes['demo.cart.id'] = cartId;
          }
          if (tenantId) {
            logAttributes['demo.tenant.id'] = tenantId;
          }
          writeLog('INFO', '异步支付完成', logAttributes);
          return paymentResult;
        });
      } catch (processingError) {
        const routeResult = await routeFailedMessage(
          channel,
          message,
          orderMessage,
          retryCount,
          processingError,
        );
        consumerSpan.setAttributes({
          'demo.payment.failure.route': routeResult.decision.action,
          'demo.payment.next_retry.count': routeResult.decision.nextRetryCount,
        });
        ackAttempted = true;
        channel.ack(message);
        messageSettled = true;
        console.log(`payment-service 已路由失败消息：${routeResult.destinationQueue}`);
        throw processingError;
      }
      ackAttempted = true;
      channel.ack(message);
      messageSettled = true;
      console.log(`payment-service 已 ACK：${payment.orderId}`);
    });
  } catch (error) {
    console.error('payment-service 拒绝订单消息：', error.message);
    if (!messageSettled) {
      if (!ackAttempted) {
        try {
          channel.nack(message, false, true);
        } catch (channelError) {
          console.error('payment-service NACK 失败：', channelError.message);
        }
      }
      await onInfrastructureFailure(error);
    }
  }
}

// 启动 payment-service；失败消息有限重试，超过上限后进入 DLQ。
async function startPaymentService() {
  let connection;
  let channel;
  let shuttingDown = false;

  // 启动失败或收到终止信号时，幂等关闭 AMQP 资源。
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await channel?.close();
    } catch (error) {
      console.error('关闭支付 Channel 失败：', error.message);
    }
    try {
      await connection?.close();
    } catch (error) {
      console.error('关闭支付 RabbitMQ 连接失败：', error.message);
    }
    process.exitCode = exitCode;
  };

  try {
    connection = await connectRabbitMQ();
    channel = await connection.createConfirmChannel();
    await ensurePaymentQueues(channel, retryDelayMilliseconds);
    await channel.prefetch(1);

    console.log(`payment-service 等待订单队列：${orderQueue}（最多重试 ${defaultMaxRetries} 次，间隔 ${retryDelayMilliseconds}ms）`);
    await channel.consume(orderQueue, (message) => (
      handlePaymentMessage(channel, message, () => shutdown(1))
    ), { noAck: false });
  } catch (error) {
    await shutdown(1);
    throw error;
  }

  registerShutdownHook(() => shutdown(0));
}

if (require.main === module) {
  startPaymentService().catch((error) => {
    console.error('payment-service 启动失败：', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  handlePaymentMessage,
  processOrderMessage,
  startPaymentService,
};
