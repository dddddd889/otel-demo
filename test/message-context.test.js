'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
} = require('@opentelemetry/api');
const {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} = require('@opentelemetry/core');

const { extractMessageContext, injectMessageContext } = require('../messaging/message-context');

test.before(() => {
  propagation.setGlobalPropagator(new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }));
});

test.after(() => propagation.disable());

test('消息 Header 能恢复同一个 Trace ID 和 Baggage', () => {
  const traceId = '0123456789abcdef0123456789abcdef';
  const spanId = '0123456789abcdef';
  const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
  });
  const sourceContext = propagation.setBaggage(parentContext, propagation.createBaggage({
    'demo.cart.id': { value: 'cart-context-001' },
    'demo.tenant.id': { value: 'demo-shop' },
  }));

  const headers = injectMessageContext(sourceContext);

  assert.equal(headers.traceparent, `00-${traceId}-${spanId}-01`);
  assert.match(headers.baggage, /demo\.cart\.id=cart-context-001/);
  assert.match(headers.baggage, /demo\.tenant\.id=demo-shop/);

  // RabbitMQ Field Table 可能把 Header 作为 Buffer 返回，提取端需要兼容。
  const extractedContext = extractMessageContext({
    traceparent: Buffer.from(headers.traceparent),
    baggage: Buffer.from(headers.baggage),
  }, context.active());

  assert.equal(trace.getSpanContext(extractedContext).traceId, traceId);
  assert.equal(propagation.getBaggage(extractedContext).getEntry('demo.cart.id').value, 'cart-context-001');
  assert.equal(propagation.getBaggage(extractedContext).getEntry('demo.tenant.id').value, 'demo-shop');
});

test('消费端忽略非白名单和含控制字符的 Baggage', () => {
  const extractedContext = extractMessageContext({
    baggage: 'demo.cart.id=cart%0Aforged,demo.tenant.id=demo-shop,secret.token=do-not-log',
  }, context.active());
  const baggage = propagation.getBaggage(extractedContext);

  assert.equal(baggage.getEntry('demo.cart.id'), undefined);
  assert.equal(baggage.getEntry('demo.tenant.id').value, 'demo-shop');
  assert.equal(baggage.getEntry('secret.token'), undefined);
});
