'use strict';

const { randomUUID } = require('crypto');
const { context, propagation, trace } = require('@opentelemetry/api');
const { connectRabbitMQ, ensureQueue, orderQueue } = require('./messaging/rabbitmq-client');
const { extractMessageContext } = require('./messaging/message-context');
const { runConsumerSpan, runPaymentSpan } = require('./messaging/messaging-spans');
const { createTelemetryLogger } = require('./telemetry-logger');
const { registerShutdownHook } = require('./shutdown-coordinator');

const writeLog = createTelemetryLogger('payment-demo', '1.0.0');

// 校验订单消息并生成最小支付结果；重试与死信队列留到第 5 步。
async function processOrderMessage(orderMessage) {
  if (!orderMessage?.orderId) {
    throw new Error('订单消息缺少 orderId');
  }
  if (!Number.isFinite(orderMessage.amount) || orderMessage.amount <= 0) {
    throw new Error('订单消息 amount 必须为正数');
  }
  if (!orderMessage.currency) {
    throw new Error('订单消息缺少 currency');
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
  return attributes;
}

// 启动 payment-service，成功支付后 ACK，非法消息则丢弃。
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
    channel = await connection.createChannel();
    await ensureQueue(channel);
    await channel.prefetch(1);

    console.log(`payment-service 等待订单队列：${orderQueue}`);
    await channel.consume(orderQueue, async (message) => {
      if (!message) {
        return;
      }

      const messageContext = extractMessageContext(message.properties.headers);
      let ackAttempted = false;
      try {
        await runConsumerSpan(messageContext, {
          messageId: message.properties.messageId,
        }, async (consumerSpan) => {
          const orderMessage = JSON.parse(message.content.toString('utf8'));
          consumerSpan.setAttributes(createConsumerOrderAttributes(orderMessage));
          const payment = await runPaymentSpan(messageContext, orderMessage, async () => {
            const spanContext = trace.getSpanContext(context.active());
            const baggage = propagation.getBaggage(context.active());
            const cartId = baggage?.getEntry('demo.cart.id')?.value;
            const tenantId = baggage?.getEntry('demo.tenant.id')?.value;
            console.log(`payment-service 恢复消息上下文：trace_id=${spanContext?.traceId || '无'} cart_id=${cartId || '无'} tenant_id=${tenantId || '无'}`);
            console.log(`payment-service 开始处理订单：${orderMessage.orderId || '未知订单'}`);
            const paymentResult = await processOrderMessage(orderMessage);
            console.log('payment-service 支付完成：');
            console.log(JSON.stringify(paymentResult, null, 2));
            const logAttributes = {
              'demo.order.id': paymentResult.orderId,
              'demo.payment.id': paymentResult.paymentId,
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
          ackAttempted = true;
          channel.ack(message);
          console.log(`payment-service 已 ACK：${payment.orderId}`);
        });
      } catch (error) {
        console.error('payment-service 拒绝订单消息：', error.message);
        if (!ackAttempted) {
          try {
            channel.nack(message, false, false);
          } catch (channelError) {
            console.error('payment-service NACK 失败：', channelError.message);
            await shutdown(1);
          }
        } else {
          await shutdown(1);
        }
      }
    }, { noAck: false });
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
  processOrderMessage,
  startPaymentService,
};
