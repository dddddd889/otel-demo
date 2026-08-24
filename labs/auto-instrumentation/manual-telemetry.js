'use strict';

const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { context, propagation, trace } = require('@opentelemetry/api');
const {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} = require('@opentelemetry/core');
const {
  BasicTracerProvider,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');
const { LearningSpanExporter } = require('./learning-span-exporter');

// 为手写 patch 建立最小 TracerProvider、异步上下文和 W3C Propagator。
function setupManualTelemetry() {
  const exporter = new LearningSpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();

  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }));

  // 结束实验时刷新 Span，并释放 AsyncLocalStorage 上下文。
  async function shutdown() {
    await provider.forceFlush();
    await provider.shutdown();
    contextManager.disable();
  }

  return { shutdown };
}

module.exports = { setupManualTelemetry };
