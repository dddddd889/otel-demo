'use strict';

const { connectRabbitMQ, ensureQueue, orderQueue } = require('./rabbitmq-client');

// 启动一个长期 Consumer；本次只学习基础收发，不创建 OTel Consumer Span。
async function main() {
  let connection;
  let channel;
  let shuttingDown = false;

  // 关闭资源时保持幂等；启动中途失败也不能遗留 AMQP 连接。
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await channel?.close();
    } catch (error) {
      console.error('关闭 Channel 失败：', error.message);
    }
    try {
      await connection?.close();
    } catch (error) {
      console.error('关闭 RabbitMQ 连接失败：', error.message);
    }
    process.exitCode = exitCode;
  };

  try {
    connection = await connectRabbitMQ();
    channel = await connection.createChannel();
    await ensureQueue(channel);
    await channel.prefetch(1);

    console.log(`等待队列 ${orderQueue} 的消息，按 Ctrl+C 停止`);
    await channel.consume(orderQueue, (message) => {
      if (!message) {
        return;
      }

      try {
        const body = JSON.parse(message.content.toString('utf8'));
        console.log('收到订单消息：');
        console.log(JSON.stringify(body, null, 2));
        channel.ack(message);
        console.log(`消息已 ACK：${body.orderId || body.messageId || '未知消息'}`);
      } catch (error) {
        console.error('消息格式错误，丢弃：', error.message);
        channel.nack(message, false, false);
      }
    }, { noAck: false });
  } catch (error) {
    await shutdown(1);
    throw error;
  }

  // 收到终止信号后关闭 Channel 和 Connection，避免消息处于未确认状态。
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
}

main().catch((error) => {
  console.error('消费消息失败：', error.message);
  process.exitCode = 1;
});
