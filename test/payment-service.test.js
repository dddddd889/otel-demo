'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { processOrderMessage } = require('../payment-service');

test('payment-service 将有效订单处理为已支付结果', async () => {
  const result = await processOrderMessage({
    messageId: 'message-001',
    orderId: 'order-001',
    amount: 199,
    currency: 'CNY',
    createdAt: '2026-08-21T12:00:00.000Z',
  });

  assert.equal(result.orderId, 'order-001');
  assert.equal(result.status, 'paid');
  assert.equal(result.amount, 199);
  assert.equal(result.currency, 'CNY');
  assert.match(result.paymentId, /^payment-/);
  assert.doesNotThrow(() => new Date(result.paidAt).toISOString());
});

test('payment-service 拒绝缺少订单号的消息', async () => {
  await assert.rejects(
    processOrderMessage({ amount: 199, currency: 'CNY' }),
    /orderId/,
  );
});

test('payment-retry 场景前两次失败，第三次支付成功', async () => {
  const orderMessage = {
    orderId: 'order-retry-001',
    amount: 199,
    currency: 'CNY',
    scenario: 'payment-retry',
  };

  await assert.rejects(processOrderMessage(orderMessage, 0), /模拟支付网关临时故障/);
  await assert.rejects(processOrderMessage(orderMessage, 1), /模拟支付网关临时故障/);
  const result = await processOrderMessage(orderMessage, 2);
  assert.equal(result.status, 'paid');
});

test('payment-dlq 场景每次都失败', async () => {
  const orderMessage = {
    orderId: 'order-dlq-001',
    amount: 199,
    currency: 'CNY',
    scenario: 'payment-dlq',
  };

  await assert.rejects(processOrderMessage(orderMessage, 0), /模拟支付永久失败/);
  await assert.rejects(processOrderMessage(orderMessage, 2), /模拟支付永久失败/);
});
