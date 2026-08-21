'use strict';

const { randomUUID } = require('crypto');
const { connectRabbitMQ, ensureQueue, orderQueue } = require('./messaging/rabbitmq-client');

// 校验订单消息并生成最小支付结果；下一学习提交再加入 Trace Context。
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

      let orderMessage;
      let payment;
      try {
        orderMessage = JSON.parse(message.content.toString('utf8'));
        console.log(`payment-service 开始处理订单：${orderMessage.orderId || '未知订单'}`);
        payment = await processOrderMessage(orderMessage);
        console.log('payment-service 支付完成：');
        console.log(JSON.stringify(payment, null, 2));
      } catch (error) {
        console.error('payment-service 拒绝订单消息：', error.message);
        try {
          channel.nack(message, false, false);
        } catch (channelError) {
          console.error('payment-service NACK 失败：', channelError.message);
          await shutdown(1);
        }
        return;
      }

      try {
        channel.ack(message);
        console.log(`payment-service 已 ACK：${payment.orderId}`);
      } catch (channelError) {
        console.error('payment-service ACK 失败：', channelError.message);
        await shutdown(1);
      }
    }, { noAck: false });
  } catch (error) {
    await shutdown(1);
    throw error;
  }

  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
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
