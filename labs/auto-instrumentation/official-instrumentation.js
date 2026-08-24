'use strict';

const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { LearningSpanExporter } = require('./learning-span-exporter');

// 只启用官方 HTTP instrumentation；必须在业务代码 require('http') 前执行。
const labTelemetrySdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor(new LearningSpanExporter())],
  instrumentations: [new HttpInstrumentation()],
});

labTelemetrySdk.start();
globalThis.__autoInstrumentationLabSdk = labTelemetrySdk;
