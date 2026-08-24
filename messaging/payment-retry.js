'use strict';

const defaultMaxRetries = 2;
const retryDelayMilliseconds = 2000;

// 将 RabbitMQ Header 中的重试次数规范化为非负整数。
function getRetryCount(headers = {}) {
  const retryCount = Number(headers['x-retry-count']);
  return Number.isSafeInteger(retryCount) && retryCount >= 0 ? retryCount : 0;
}

// 根据当前尝试次数决定重新入队或进入死信队列。
function decideFailureRoute(retryCount, maxRetries = defaultMaxRetries) {
  if (retryCount < maxRetries) {
    return {
      action: 'retry',
      nextRetryCount: retryCount + 1,
    };
  }
  return {
    action: 'dead-letter',
    nextRetryCount: retryCount,
  };
}

// 复制原传播 Header，并写入下一次消费所需的重试次数。
function createRetryHeaders(originalHeaders = {}, retryCount) {
  return {
    ...originalHeaders,
    'x-retry-count': retryCount,
  };
}

module.exports = {
  createRetryHeaders,
  decideFailureRoute,
  defaultMaxRetries,
  getRetryCount,
  retryDelayMilliseconds,
};
