'use strict';

const { connectRabbitMQ, ensureQueue, orderQueue } = require('./rabbitmq-client');
const { injectMessageContext } = require('./message-context');

let connection;
let connectionPromise;
let confirmChannel;
let confirmChannelPromise;

// 连接关闭后清空缓存，使下一次 checkout 可以按需重连。
function invalidateConnection(expectedConnection) {
  if (connection === expectedConnection) {
    connection = undefined;
    confirmChannel = undefined;
    confirmChannelPromise = undefined;
  }
}

// 获取进程级 RabbitMQ 连接，避免每个请求重复 TCP/AMQP 握手。
async function getConnection() {
  if (connection) {
    return connection;
  }
  if (!connectionPromise) {
    connectionPromise = connectRabbitMQ()
      .then((createdConnection) => {
        connection = createdConnection;
        createdConnection.on('error', (error) => {
          console.error('订单 RabbitMQ 连接错误：', error.message);
        });
        createdConnection.once('close', () => invalidateConnection(createdConnection));
        return createdConnection;
      })
      .finally(() => {
        connectionPromise = undefined;
      });
  }
  return connectionPromise;
}

// 复用 Confirm Channel；关闭后下一次发布会重新创建。
async function getConfirmChannel() {
  if (confirmChannel) {
    return confirmChannel;
  }
  if (!confirmChannelPromise) {
    confirmChannelPromise = getConnection()
      .then(async (activeConnection) => {
        const channel = await activeConnection.createConfirmChannel();
        await ensureQueue(channel);
        confirmChannel = channel;
        channel.on('error', (error) => {
          console.error('订单 Confirm Channel 错误：', error.message);
          if (confirmChannel === channel) {
            confirmChannel = undefined;
          }
        });
        channel.once('close', () => {
          if (confirmChannel === channel) {
            confirmChannel = undefined;
          }
        });
        return channel;
      })
      .finally(() => {
        confirmChannelPromise = undefined;
      });
  }
  return confirmChannelPromise;
}

// 发布订单并等待 Broker Confirm，但不等待 payment-service 完成支付。
async function publishOrder(orderMessage) {
  const channel = await getConfirmChannel();
  const headers = injectMessageContext();
  channel.sendToQueue(orderQueue, Buffer.from(JSON.stringify(orderMessage)), {
    persistent: true,
    contentType: 'application/json',
    headers,
  });
  await channel.waitForConfirms();
}

// 应用退出时关闭共享 Channel 和 Connection。
async function closeOrderPublisher() {
  const channelToClose = confirmChannel;
  const connectionToClose = connection;
  confirmChannel = undefined;
  connection = undefined;
  await channelToClose?.close().catch(() => undefined);
  await connectionToClose?.close().catch(() => undefined);
}

module.exports = {
  closeOrderPublisher,
  publishOrder,
};
