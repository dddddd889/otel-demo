'use strict';

const { SpanKind, SpanStatusCode } = require('@opentelemetry/api');

const spanKindNames = {
  [SpanKind.INTERNAL]: 'INTERNAL',
  [SpanKind.SERVER]: 'SERVER',
  [SpanKind.CLIENT]: 'CLIENT',
  [SpanKind.PRODUCER]: 'PRODUCER',
  [SpanKind.CONSUMER]: 'CONSUMER',
};

// 将 Span 压缩成一行输出，便于对比手写插桩和官方自动插桩。
class LearningSpanExporter {
  export(spans, resultCallback) {
    for (const span of spans) {
      const spanContext = span.spanContext();
      const parentSpanId = span.parentSpanContext?.spanId || '无';
      const status = span.status.code === SpanStatusCode.ERROR ? 'ERROR' : 'OK';
      console.log(
        `[SPAN] name=${span.name} kind=${spanKindNames[span.kind] || span.kind}` +
        ` trace_id=${spanContext.traceId} span_id=${spanContext.spanId}` +
        ` parent_span_id=${parentSpanId} status=${status}`,
      );
    }
    resultCallback({ code: 0 });
  }

  // 本实验没有异步缓冲，flush 立即完成。
  forceFlush() {
    return Promise.resolve();
  }

  // Exporter 不持有网络资源，关闭时无需额外处理。
  shutdown() {
    return Promise.resolve();
  }
}

module.exports = { LearningSpanExporter };
