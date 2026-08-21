'use strict';

const { randomUUID } = require('crypto');

// 创建 checkout 与命令行 Producer 共用的订单消息契约。
function createOrderMessage(orderId, options = {}) {
  return {
    messageId: `message-${randomUUID()}`,
    orderId,
    amount: options.amount ?? 199,
    currency: options.currency || 'CNY',
    scenario: options.scenario || 'manual',
    createdAt: new Date().toISOString(),
  };
}

module.exports = { createOrderMessage };
