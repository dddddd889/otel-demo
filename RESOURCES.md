# OpenTelemetry Node.js Resources

## Knowledge

- [OpenTelemetry JavaScript：Instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
  官方手动插桩入口。用于区分 API、SDK、手动插桩和 instrumentation library 的职责。
- [OpenTelemetry JavaScript：Using instrumentation libraries](https://opentelemetry.io/docs/languages/js/libraries/)
  官方自动插桩注册说明。用于理解为什么 instrumentation 必须交给 SDK 初始化。
- [Node 自动插桩元包 README](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/packages/auto-instrumentations-node/README.md)
  官方源码仓库说明。用于核对 `--require`、启用范围和诊断日志配置。
- [HTTP Instrumentation API](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_instrumentation-http.html)
  官方 HTTP/HTTPS 插桩 API。用于查看支持范围、Hook 和配置项。
- [Instrumentation 实现指南](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/GUIDELINES.md)
  官方维护者指南。用于理解模块加载 Hook、patch/unpatch 和诊断消息。
- [Node.js：Async Context](https://nodejs.org/api/async_context.html)
  官方 `AsyncLocalStorage.run/getStore` 与 Context 丢失排查说明。
- [OpenTelemetry JavaScript：Context](https://opentelemetry.io/docs/languages/js/context/)
  官方进程内 Context、Active Span 与 Context Manager 说明。
- [OpenTelemetry JavaScript：Propagation](https://opentelemetry.io/docs/languages/js/propagation/)
  官方跨进程 inject/extract 与 Carrier 说明。
- [OpenTelemetry Trace API：Span Events 与 RecordException](https://opentelemetry.io/docs/specs/otel/trace/api/#add-events)
  官方 Trace API 规范。用于区分 Span Event、`addEvent()` 和 `recordException()`。
- [OpenTelemetry Logs API](https://opentelemetry.io/docs/specs/otel/logs/api/)
  官方 Logs API 规范。用于理解 `Logger.emit()` 如何生成独立 LogRecord。

## Wisdom (Communities)

- [OpenTelemetry GitHub Discussions](https://github.com/open-telemetry/opentelemetry-js/discussions)
  适合核对 JavaScript SDK 行为、版本差异和具体插桩问题。
- [CNCF OpenTelemetry Slack](https://cloud-native.slack.com/)
  适合携带最小复现询问 Collector、语义约定和跨语言传播问题。
