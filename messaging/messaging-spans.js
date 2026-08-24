'use strict';

const {
  SpanKind,
  SpanStatusCode,
  trace,
} = require('@opentelemetry/api');
const { orderQueue } = require('./rabbitmq-client');

const tracer = trace.getTracer('rabbitmq-order-messaging', '1.0.0');

// 构造低基数消息属性；唯一消息 ID 仅用于 Trace，不用于 Metric 标签。
function createMessagingAttributes(orderMessage, operationType) {
  const attributes = {
    'messaging.system': 'rabbitmq',
    'messaging.destination.name': orderQueue,
    'messaging.operation.type': operationType,
    'demo.async.messaging': 'true',
  };
  if (orderMessage.messageId) {
    attributes['messaging.message.id'] = orderMessage.messageId;
  }
  if (orderMessage.orderId) {
    attributes['demo.order.id'] = orderMessage.orderId;
  }
  if (Number.isSafeInteger(orderMessage.retryCount)) {
    attributes['demo.payment.retry.count'] = orderMessage.retryCount;
  }
  return attributes;
}

// 在 checkout 当前 Span 下创建 Producer Span，回调内部注入的 traceparent 会指向它。
async function runProducerSpan(orderMessage, publishCallback) {
  return tracer.startActiveSpan('otel.demo.orders send', {
    kind: SpanKind.PRODUCER,
    attributes: createMessagingAttributes(orderMessage, 'send'),
  }, async (span) => {
    try {
      const result = await publishCallback();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

// 为重试或死信发布创建独立 Producer Span，便于在 Jaeger 观察失败路由。
async function runFailureRouteSpan(messageMetadata, route, publishCallback) {
  const destinationName = route === 'retry' ? `${orderQueue}.retry` : `${orderQueue}.dlq`;
  return tracer.startActiveSpan(`${destinationName} send`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      ...createMessagingAttributes(messageMetadata, 'send'),
      'messaging.destination.name': destinationName,
      'demo.payment.failure.route': route,
      'demo.payment.retry.count': messageMetadata.retryCount,
    },
  }, async (span) => {
    try {
      const result = await publishCallback();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

// 以消息上下文为父级创建 Consumer Span；回调应覆盖解析、业务处理和 ACK。
async function runConsumerSpan(messageContext, messageMetadata, consumeCallback) {
  return tracer.startActiveSpan('otel.demo.orders process', {
    kind: SpanKind.CONSUMER,
    attributes: createMessagingAttributes(messageMetadata, 'process'),
  }, messageContext, async (consumerSpan) => {
    try {
      const result = await consumeCallback(consumerSpan);
      consumerSpan.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      consumerSpan.recordException(error);
      consumerSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      consumerSpan.end();
    }
  });
}

// 创建支付业务 Span，并用 Span Link 保留对原 Producer 的额外引用。
async function runPaymentSpan(messageContext, orderMessage, processCallback) {
  const producerSpanContext = trace.getSpanContext(messageContext);
  const links = producerSpanContext ? [{
    context: producerSpanContext,
    attributes: { 'messaging.link.type': 'producer' },
  }] : [];
  return tracer.startActiveSpan('process-payment', {
    attributes: {
      'demo.order.id': orderMessage.orderId,
      'demo.order.amount': orderMessage.amount,
      'demo.order.currency': orderMessage.currency,
      'demo.payment.retry.count': orderMessage.retryCount || 0,
      'demo.scenario': orderMessage.scenario || 'normal',
    },
    links,
  }, async (paymentSpan) => {
    try {
      const result = await processCallback();
      paymentSpan.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      paymentSpan.recordException(error);
      paymentSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      paymentSpan.end();
    }
  });
}

module.exports = {
  createMessagingAttributes,
  runConsumerSpan,
  runFailureRouteSpan,
  runPaymentSpan,
  runProducerSpan,
};
