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
