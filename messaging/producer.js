'use strict';

const { connectRabbitMQ, orderQueue, publishJson } = require('./rabbitmq-client');

// 根据命令行参数创建一条最小订单消息。
function createOrderMessage(orderId) {
  return {
    messageId: `message-${Date.now()}`,
    orderId,
    amount: 199,
    currency: 'CNY',
    createdAt: new Date().toISOString(),
  };
}

// 连接 Broker、发布一条消息并在确认后退出。
async function main() {
  const orderId = process.argv[2] || `order-${Date.now()}`;
  const message = createOrderMessage(orderId);
  const connection = await connectRabbitMQ();

  try {
    await publishJson(connection, message);
    console.log(`消息已发送到 ${orderQueue}`);
    console.log(JSON.stringify(message, null, 2));
  } finally {
    await connection.close();
  }
}

main().catch((error) => {
  console.error('发送消息失败：', error.message);
  process.exitCode = 1;
});
