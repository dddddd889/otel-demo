'use strict';

const { context, propagation } = require('@opentelemetry/api');

const w3cHeaderNames = ['traceparent', 'tracestate', 'baggage'];
const headerByteLimits = {
  traceparent: 512,
  tracestate: 1024,
  baggage: 4096,
};
const allowedBaggageKeys = ['demo.cart.id', 'demo.tenant.id'];
const baggageValueMaxLength = 128;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/;

// 把当前 OTel 上下文注入为可写入 AMQP Field Table 的 W3C Headers。
function injectMessageContext(sourceContext = context.active()) {
  const headers = {};
  propagation.inject(sourceContext, headers);
  return headers;
}

// 将 RabbitMQ 返回的 Buffer Header 归一化为 OTel Propagator 可读取的文本。
function normalizeMessageHeaders(headers = {}) {
  const normalizedHeaders = {};
  for (const headerName of w3cHeaderNames) {
    const value = headers[headerName];
    if (Buffer.isBuffer(value)) {
      if (value.byteLength <= headerByteLimits[headerName]) {
        normalizedHeaders[headerName] = value.toString('utf8');
      }
    } else if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') <= headerByteLimits[headerName]) {
        normalizedHeaders[headerName] = value;
      }
    }
  }
  return normalizedHeaders;
}

// 从 AMQP Headers 提取远端 Trace Context 与 Baggage。
function extractMessageContext(headers, baseContext = context.active()) {
  const extractedContext = propagation.extract(baseContext, normalizeMessageHeaders(headers));
  const extractedBaggage = propagation.getBaggage(extractedContext);
  const allowedEntries = {};

  for (const baggageKey of allowedBaggageKeys) {
    const baggageValue = extractedBaggage?.getEntry(baggageKey)?.value;
    if (baggageValue
      && baggageValue.length <= baggageValueMaxLength
      && !controlCharacterPattern.test(baggageValue)) {
      allowedEntries[baggageKey] = { value: baggageValue };
    }
  }

  return propagation.setBaggage(extractedContext, propagation.createBaggage(allowedEntries));
}

module.exports = {
  extractMessageContext,
  injectMessageContext,
  normalizeMessageHeaders,
};
