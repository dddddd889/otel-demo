'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require('@opentelemetry/semantic-conventions');

// 链路导出器：通过 OTLP/HTTP 把 Span 发给 OpenTelemetry Collector。
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces',
});

// 指标导出器：定时把 Counter、Histogram 等指标发给 Collector。
const metricExporter = new OTLPMetricExporter({
  url: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || 'http://localhost:4318/v1/metrics',
});

// 日志导出器：将带 Trace 上下文的结构化日志发给 Collector。
const logExporter = new OTLPLogExporter({
  url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || 'http://localhost:4318/v1/logs',
});

// OpenTelemetry SDK：必须在加载 Express 等业务模块前启动，自动插桩才能生效。
const telemetrySdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'checkout-service',
    [ATTR_SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter,
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 2000,
    }),
  ],
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: logExporter })],
  instrumentations: [getNodeAutoInstrumentations()],
});

telemetrySdk.start();

// 退出前刷新并关闭 SDK，避免进程结束时丢失尚未导出的 Span。
async function shutdownTelemetry() {
  let exitCode = 0;

  try {
    await telemetrySdk.shutdown();
    console.log('OpenTelemetry SDK 已关闭');
  } catch (error) {
    console.error('关闭 OpenTelemetry SDK 失败', error);
    exitCode = 1;
  } finally {
    // 信号的默认退出行为已被监听器替代，刷新遥测数据后需要显式结束进程。
    process.exit(exitCode);
  }
}

process.once('SIGTERM', shutdownTelemetry);
process.once('SIGINT', shutdownTelemetry);
