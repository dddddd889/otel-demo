'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} = require('@opentelemetry/api');
const {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} = require('@opentelemetry/core');
const {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');

const { extractMessageContext, injectMessageContext } = require('../messaging/message-context');
const {
  runConsumerSpan,
  runPaymentSpan,
  runProducerSpan,
} = require('../messaging/messaging-spans');

test('消息 Span 形成 Producer → Consumer → process-payment，并保留 Producer Link', async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }));

  const tracer = trace.getTracer('messaging-span-test');
  const checkoutSpan = tracer.startSpan('checkout-test');
  let headers;
  const orderMessage = {
    messageId: 'message-span-001',
    orderId: 'order-span-001',
    amount: 199,
    currency: 'CNY',
  };

  await context.with(trace.setSpan(context.active(), checkoutSpan), async () => {
    await runProducerSpan(orderMessage, async () => {
      headers = injectMessageContext();
    });
  });
  checkoutSpan.end();

  const messageContext = extractMessageContext(headers);
  await runConsumerSpan(messageContext, {
    messageId: orderMessage.messageId,
  }, async () => runPaymentSpan(messageContext, orderMessage, async () => 'paid'));

  await assert.rejects(
    runConsumerSpan(messageContext, { messageId: 'message-ack-error' }, async () => {
      throw new Error('模拟 ACK 失败');
    }),
    /模拟 ACK 失败/,
  );
  await provider.forceFlush();

  const spans = exporter.getFinishedSpans();
  const checkout = spans.find((span) => span.name === 'checkout-test');
  const producer = spans.find((span) => span.name === 'otel.demo.orders send');
  const consumer = spans.find((span) => span.name === 'otel.demo.orders process');
  const payment = spans.find((span) => span.name === 'process-payment');
  const failedConsumer = spans.find((span) => (
    span.attributes['messaging.message.id'] === 'message-ack-error'
  ));

  assert.equal(producer.kind, SpanKind.PRODUCER);
  assert.equal(consumer.kind, SpanKind.CONSUMER);
  assert.equal(payment.kind, SpanKind.INTERNAL);
  assert.equal(producer.parentSpanContext.spanId, checkout.spanContext().spanId);
  assert.equal(consumer.parentSpanContext.spanId, producer.spanContext().spanId);
  assert.equal(payment.parentSpanContext.spanId, consumer.spanContext().spanId);
  assert.equal(payment.links[0].context.spanId, producer.spanContext().spanId);
  assert.equal(new Set([checkout, producer, consumer, payment].map((span) => span.spanContext().traceId)).size, 1);
  assert.equal(failedConsumer.status.code, SpanStatusCode.ERROR);
  assert.equal(failedConsumer.events.some((event) => event.name === 'exception'), true);

  await provider.shutdown();
  contextManager.disable();
  context.disable();
  trace.disable();
  propagation.disable();
});
