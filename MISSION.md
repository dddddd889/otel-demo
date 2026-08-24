# Mission: 掌握 OpenTelemetry Node.js 全链路

## Why

能够在真实 Node.js 服务中独立接入 OpenTelemetry，并在“为什么没有数据、Trace 为什么断了、字段在哪里变化”时定位到 SDK、Context、Collector 或后端，而不是只会复制配置。

## Success looks like

- 能解释自动插桩如何 patch 模块、创建 Active Span 并传播 `traceparent`。
- 能亲手产生并关联 Trace、Metric、Log，在 Jaeger、Prometheus、Loki、Grafana 中完成排障。
- 能判断问题发生在应用 SDK、Collector Processor、Exporter 还是存储与查询层。

## Constraints

- 使用中文、短步骤和可立即验证的输出。
- 每个学习主题保持独立，不破坏现有可运行、可调试的 Demo。
- 代码改动按学习提交拆分，不自动提交。

## Out of scope

- 暂不继续扩展支付、幂等、事务补偿等生产级 MQ 业务能力。
- 暂不以 Kubernetes、多租户和大规模容量治理为主线。
