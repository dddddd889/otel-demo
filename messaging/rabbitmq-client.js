'use strict';

const amqp = require('amqplib');

// RabbitMQ 基础配置；后续学习提交会在消息头中增加 Trace Context。
const rabbitmqUrl = process.env.AMQP_URL || 'amqp://otel:otel-demo@localhost:5672';
const orderQueue = process.env.RABBITMQ_ORDER_QUEUE || 'otel.demo.orders';

// 建立 RabbitMQ TCP/AMQP 连接。
function connectRabbitMQ(url = rabbitmqUrl) {
  return amqp.connect(url);
}

// 声明持久化队列，Producer 和 Consumer 使用相同配置。
function ensureQueue(channel, queue = orderQueue) {
  return channel.assertQueue(queue, { durable: true });
}

// 使用 Confirm Channel 发布持久化 JSON 消息，并等待 Broker 确认。
async function publishJson(connection, message, queue = orderQueue) {
  const channel = await connection.createConfirmChannel();
  await ensureQueue(channel, queue);
  const content = Buffer.from(JSON.stringify(message));
  channel.sendToQueue(queue, content, {
    persistent: true,
    contentType: 'application/json',
  });
  await channel.waitForConfirms();
  await channel.close();
}

// 消费一条消息，解析成功后 ACK；超时则拒绝测试。
async function consumeOne(connection, queue = orderQueue, timeoutMilliseconds = 5000) {
  const channel = await connection.createChannel();
  await ensureQueue(channel, queue);

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`等待消息超时：${queue}`)), timeoutMilliseconds);

      channel.consume(queue, (message) => {
        if (!message) {
          return;
        }
        try {
          const body = JSON.parse(message.content.toString('utf8'));
          channel.ack(message);
          clearTimeout(timeout);
          resolve(body);
        } catch (error) {
          channel.nack(message, false, false);
          clearTimeout(timeout);
          reject(error);
        }
      }, { noAck: false }).catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    await channel.close();
  }
}

module.exports = {
  connectRabbitMQ,
  consumeOne,
  ensureQueue,
  orderQueue,
  publishJson,
  rabbitmqUrl,
};
