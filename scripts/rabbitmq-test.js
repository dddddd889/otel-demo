'use strict';

const {
  connectRabbitMQ,
  consumeOne,
  publishJson,
} = require('../messaging/rabbitmq-client');

// 使用独立临时队列验证 Producer 发布、Consumer 消费和 ACK。
async function main() {
  const queue = `otel.demo.test.${process.pid}.${Date.now()}`;
  const expectedMessage = {
    messageId: `test-message-${Date.now()}`,
    orderId: 'test-order-001',
    amount: 199,
    currency: 'CNY',
  };
  const connection = await connectRabbitMQ();
  let cleanupChannel;
  let testError;

  try {
    await publishJson(connection, expectedMessage, queue);
    const actualMessage = await consumeOne(connection, queue);
    if (JSON.stringify(actualMessage) !== JSON.stringify(expectedMessage)) {
      throw new Error(`消息内容不一致：${JSON.stringify(actualMessage)}`);
    }

    console.log(`RabbitMQ 基础消息流通过：${expectedMessage.messageId}`);
  } catch (error) {
    testError = error;
    throw error;
  } finally {
    try {
      // 即使断言失败也删除临时队列，避免测试数据污染管理界面。
      cleanupChannel = await connection.createChannel();
      await cleanupChannel.deleteQueue(queue);
      await cleanupChannel.close();
    } catch (cleanupError) {
      if (!testError) {
        throw cleanupError;
      }
      console.error('清理临时队列失败：', cleanupError.message);
    } finally {
      try {
        await connection.close();
      } catch (closeError) {
        if (!testError) {
          throw closeError;
        }
        console.error('关闭 RabbitMQ 连接失败：', closeError.message);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
