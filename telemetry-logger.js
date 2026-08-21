'use strict';

const { trace } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

// 创建同时输出终端和 OpenTelemetry 的关联日志函数。
function createTelemetryLogger(scopeName, scopeVersion) {
  const logger = logs.getLogger(scopeName, scopeVersion);
  const severityNumbers = {
    INFO: SeverityNumber.INFO,
    ERROR: SeverityNumber.ERROR,
  };

  // 写入携带当前 Trace ID、Span ID 和业务属性的结构化日志。
  return function writeLog(severityText, message, attributes = {}) {
    const spanContext = trace.getActiveSpan()?.spanContext();
    const traceId = spanContext?.traceId;
    const spanId = spanContext?.spanId;
    const body = traceId ? `${message} trace_id=${traceId} span_id=${spanId}` : message;

    logger.emit({
      severityNumber: severityNumbers[severityText] || SeverityNumber.INFO,
      severityText,
      body,
      attributes: {
        ...attributes,
        ...(traceId ? { 'demo.trace_id': traceId, 'demo.span_id': spanId } : {}),
      },
    });

    const consoleMethod = severityText === 'ERROR' ? console.error : console.log;
    consoleMethod(JSON.stringify({ severity: severityText, message, traceId, spanId, ...attributes }));
  };
}

module.exports = { createTelemetryLogger };
