'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handlePaymentMessage } = require('../payment-service');

// 创建可直接交给 Consumer 的最小 RabbitMQ 消息。
function createMessage(scenario = 'payment-retry') {
  return {
    content: Buffer.from(JSON.stringify({
      messageId: `message-${scenario}`,
      orderId: `order-${scenario}`,
      amount: 199,
      currency: 'CNY',
      scenario,
    })),
    properties: {
      contentType: 'application/json',
      headers: { 'x-retry-count': 0 },
      messageId: `message-${scenario}`,
    },
  };
}

test('失败消息 Broker Confirm 成功后才 ACK 原消息', async () => {
  const calls = [];
  const channel = {
    sendToQueue: () => calls.push('send'),
    waitForConfirms: async () => calls.push('confirm'),
    ack: () => calls.push('ack'),
    nack: () => calls.push('nack'),
  };
  let infrastructureFailures = 0;

  await handlePaymentMessage(channel, createMessage(), async () => {
    infrastructureFailures += 1;
  });

  assert.deepEqual(calls, ['send', 'confirm', 'ack']);
  assert.equal(infrastructureFailures, 0);
});

test('Broker Confirm 失败时不 ACK，并将原消息重新入队后关闭', async () => {
  const calls = [];
  const channel = {
    sendToQueue: () => calls.push('send'),
    waitForConfirms: async () => {
      calls.push('confirm');
      throw new Error('Broker Confirm 失败');
    },
    ack: () => calls.push('ack'),
    nack: (message, allUpTo, requeue) => calls.push(`nack:${allUpTo}:${requeue}`),
  };
  let infrastructureFailures = 0;

  await handlePaymentMessage(channel, createMessage(), async () => {
    infrastructureFailures += 1;
  });

  assert.deepEqual(calls, ['send', 'confirm', 'nack:false:true']);
  assert.equal(infrastructureFailures, 1);
});

test('ACK 抛错时关闭消费者且不再次 NACK', async () => {
  const calls = [];
  const channel = {
    ack: () => {
      calls.push('ack');
      throw new Error('ACK 失败');
    },
    nack: () => calls.push('nack'),
  };
  let infrastructureFailures = 0;

  await handlePaymentMessage(channel, createMessage('normal'), async () => {
    infrastructureFailures += 1;
  });

  assert.deepEqual(calls, ['ack']);
  assert.equal(infrastructureFailures, 1);
});
