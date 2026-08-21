# OpenTelemetry Collector 数据处理配置

OpenTelemetry Collector 不处理业务请求，只接收应用产生的 Trace、Metric 和 Log。它通过 Pipeline 决定每类遥测数据从哪里进入、经过哪些处理、最终发送到哪个后端。

## 数据流概览

```text
Node.js 应用
  └─ OTLP/HTTP :4318
       ├─ Trace  → processors → Jaeger
       ├─ Metric → processors → Prometheus
       └─ Log    → processors → Loki
```

每条 Pipeline 都由三部分组成：

```text
Receiver → Processor → Exporter
接收数据    加工数据     导出数据
```

## Receiver：接收数据

`otel-collector-config.yaml` 使用 OTLP Receiver：

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
```

应用的 `instrumentation.js` 分别请求以下 OTLP/HTTP 路径：

```text
/v1/traces
/v1/metrics
/v1/logs
```

端口只表示传输协议，具体路径决定发送的是哪类信号。

## Processor：加工数据

本项目配置了以下处理器：

- `memory_limiter`：限制 Collector 的内存使用，避免流量过大导致进程失控。
- `tail_sampling`：等待 Trace 基本完整后决定是否保留；健康检查 Trace 会整条丢弃。
- `resource`：给三类数据增加 `deployment.environment.name=local-demo`。
- `batch`：将零散数据合并成批次，提高导出效率。

处理器只在被 Pipeline 引用时才会执行。仅在 `processors:` 中声明而不加入 Pipeline，不会产生效果。

## Exporter：发送数据

```yaml
exporters:
  otlp/jaeger:
    endpoint: jaeger:4317

  prometheus:
    endpoint: 0.0.0.0:8889
    namespace: otel_demo

  otlphttp/loki:
    endpoint: http://loki:3100/otlp
```

- Jaeger Exporter 主动将 Trace 推送到 Jaeger。
- Prometheus Exporter 在 `:8889/metrics` 暴露指标，由 Prometheus 定时抓取。
- Loki Exporter 使用 OTLP/HTTP 将日志推送到 Loki。

`debug` Exporter 同时输出每批数据的数量，便于观察 Collector 是否收到数据。

## Pipeline：组装处理路径

真正决定处理逻辑的是 `service.pipelines`：

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, tail_sampling, resource, batch]
      exporters: [debug, otlp/jaeger]

    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [debug, prometheus]

    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource, batch]
      exporters: [debug, otlphttp/loki]
```

三种信号共享 OTLP Receiver，但各自进入独立 Pipeline。Trace 使用尾部采样，Metric 和 Log 不使用，互相不会混入错误的后端。

## 配置如何生效

`docker-compose.yaml` 将配置文件只读挂载到容器：

```yaml
otel-collector:
  command: ["--config=/etc/otelcol-contrib/config.yaml"]
  volumes:
    - ./otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml:ro
```

修改配置后执行：

```bash
docker compose restart otel-collector
```

查看处理结果和导出错误：

```bash
docker compose logs -f otel-collector
```

修改前可以验证配置语法：

```bash
docker run --rm \
  -v "$PWD/otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.136.0 \
  validate --config=/etc/otelcol-contrib/config.yaml
```

## 各组件的区别

| 组件 | 主要职责 | 主要数据 | 是否存储 | 查询界面 |
| --- | --- | --- | --- | --- |
| Collector | 接收、处理、采样和转发 | Trace、Metric、Log | 默认不持久化 | 无业务查询界面 |
| Jaeger | 分布式链路查询 | Trace | 是；本项目使用内存存储 | Jaeger UI |
| Prometheus | 抓取、存储和查询时序指标 | Metric | 是 | 自带基础查询界面 |
| Loki | 按标签索引和存储日志 | Log | 是 | 无独立 UI，通常使用 Grafana |
| Grafana | 统一查询和可视化多个后端 | 不直接接收遥测信号 | 不存储遥测数据 | Grafana UI |
| Elasticsearch | 通用文档存储和全文检索 | Log、Trace，也可存 Metric | 是 | 通常配合 Kibana |
| Kibana | 查询和可视化 Elasticsearch | Elasticsearch 中的数据 | 不存储遥测数据 | Kibana UI |

当前项目选择专用后端：Jaeger 处理 Trace、Prometheus 处理 Metric、Loki 处理 Log，Grafana 负责统一展示。Grafana 不是 Prometheus 的必需组件；Prometheus 可以独立执行 PromQL，但 Grafana 更适合长期 Dashboard 和跨数据源关联。

Elasticsearch 和 Kibana 当前未部署，它们是可选方案，不是 Collector 的必需组件。需要体验时，可以让 Collector 的 Elasticsearch Exporter 额外复制三类数据：

```text
Collector ─┬─ Trace  → Jaeger
           ├─ Metric → Prometheus
           ├─ Log    → Loki
           └─ Trace / Metric / Log → Elasticsearch → Kibana
```

Elasticsearch Exporter 对 Log 和 Trace 的支持相对成熟，Metric 支持仍处于开发阶段。Collector 直接写入 Elasticsearch 的 Trace 也不能自动被 Jaeger UI 查询；需要 Jaeger UI 时，应继续保留 Jaeger 数据路径。

## 常见误区

- Collector 不是 MQ；默认内存队列不能提供长时间持久化缓冲。
- Collector 本身不是数据库；Elasticsearch、Jaeger、Prometheus 和 Loki 才是数据后端。
- Collector 不代理 `/checkout` 等业务请求，只接收遥测数据。
- Prometheus 的数据流是“Prometheus 拉取 Collector”，不是 Collector 主动推送。
- Grafana 和 Kibana 主要负责查询与展示，不替代对应的存储后端。
- 声明组件不等于启用组件，必须将其加入对应 Pipeline。
- Processor 的排列顺序就是实际执行顺序，调整顺序可能改变结果。
