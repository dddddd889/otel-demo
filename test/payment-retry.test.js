'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRetryHeaders,
  decideFailureRoute,
  getRetryCount,
} = require('../messaging/payment-retry');

test('支付失败最多重试两次，第三次失败进入死信队列', () => {
  assert.deepEqual(decideFailureRoute(0, 2), {
    action: 'retry',
    nextRetryCount: 1,
  });
  assert.deepEqual(decideFailureRoute(1, 2), {
    action: 'retry',
    nextRetryCount: 2,
  });
  assert.deepEqual(decideFailureRoute(2, 2), {
    action: 'dead-letter',
    nextRetryCount: 2,
  });
});

test('重试 Header 保留 Trace Context，并规范化非法重试次数', () => {
  const originalHeaders = {
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    baggage: 'demo.cart.id=cart-001',
    'x-retry-count': 'invalid',
  };

  assert.equal(getRetryCount(originalHeaders), 0);
  assert.deepEqual(createRetryHeaders(originalHeaders, 1), {
    ...originalHeaders,
    'x-retry-count': 1,
  });
  assert.equal(getRetryCount({ 'x-retry-count': 2 }), 2);
  assert.equal(getRetryCount({ 'x-retry-count': -1 }), 0);
});
