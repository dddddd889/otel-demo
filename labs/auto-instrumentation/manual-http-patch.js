'use strict';

const {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} = require('@opentelemetry/api');

// 创建一个只服务于本实验的 http.get patch，展示自动插桩的核心骨架。
function createManualHttpPatch(httpModule) {
  const tracer = trace.getTracer('manual-http-patch', '1.0.0');
  const originalGet = httpModule.get;
  let enabled = false;

  // 恢复原函数时使用同一个引用，避免重复 patch。
  function disable() {
    if (!enabled) {
      return;
    }
    httpModule.get = originalGet;
    enabled = false;
  }

  // 替换 http.get；本实验刻意只覆盖 options-object 这一种调用形式。
  function enable() {
    if (enabled) {
      return;
    }
    httpModule.get = function patchedGet(options, responseCallback) {
      return tracer.startActiveSpan('manual-http-get', {
        kind: SpanKind.CLIENT,
      }, (span) => {
        const headers = { ...(options.headers || {}) };
        propagation.inject(context.active(), headers);
        const patchedOptions = { ...options, headers };
        let ended = false;

        // Span 只能结束一次，避免 response 和 request 错误重复结束。
        const endSpan = (error) => {
          if (ended) {
            return;
          }
          ended = true;
          if (error) {
            span.recordException(error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
          } else {
            span.setStatus({ code: SpanStatusCode.OK });
          }
          span.end();
        };

        const request = originalGet.call(httpModule, patchedOptions, (response) => {
          span.setAttribute('http.response.status_code', response.statusCode);
          response.once('end', () => endSpan());
          response.once('error', endSpan);
          responseCallback?.(response);
        });
        request.once('error', endSpan);
        return request;
      });
    };
    enabled = true;
  }

  return { disable, enable };
}

module.exports = { createManualHttpPatch };
