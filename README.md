# OpenTelemetry Node.js 全栈 Demo

这个 Demo 同时演示 OpenTelemetry 的 Trace、Metric、Log 三类数据，以及四个可观测性后端：

```text
Node.js / Express
  ├─ Trace  ─┐
  ├─ Metric ─┼─ OTLP/HTTP ─> OpenTelemetry Collector
  └─ Log    ─┘                    ├─ Trace  ─> Jaeger
                                 ├─ Metric ─> Prometheus
                                 └─ Log    ─> Loki

Grafana ──> Prometheus + Loki + Jaeger
```

| 组件 | 作用 | 地址 |
|---|---|---|
| Node.js Demo | 产生 Trace、Metric、Log | <http://localhost:3000> |
| Jaeger | 链路存储和查询 | <http://localhost:16686> |
| Prometheus | 指标抓取、存储和 PromQL 查询 | <http://localhost:9090> |
| Loki | 日志存储和 LogQL 查询 | <http://localhost:3100> |
| Grafana | 指标、日志、链路统一可视化 | <http://localhost:3001> |

## 1. 启动

要求：Node.js 20+、Docker 和 Docker Compose。

```bash
npm install
npm run infra:up
npm start
```

Grafana 已开启匿名只读访问。需要管理权限时使用：

```text
用户名：admin
密码：admin
```

## 2. 产生遥测数据

另开一个终端，分别触发成功和失败请求：

```bash
curl http://localhost:3000/checkout
curl 'http://localhost:3000/checkout?fail=true'
```

多调用几次更容易观察速率曲线：

```bash
for i in {1..10}; do curl -s http://localhost:3000/checkout; echo; done
```

## 3. 查看 Trace：Jaeger

1. 打开 <http://localhost:16686>。
2. 在 **Service** 中选择 `checkout-service`。
3. 点击 **Find Traces**。
4. 打开任意链路，可以看到自动插桩和手动业务 Span：
   - `GET /checkout`
   - `validate-cart`
   - `query-inventory`
   - `create-order`

访问 `/checkout?fail=true` 后，可以看到 HTTP 500 和异常事件。

## 4. 查看 Metric：Prometheus

打开 <http://localhost:9090>，执行以下 PromQL：

```promql
# 请求总数
sum(otel_demo_checkout_requests_total)

# 按状态码统计请求
sum by (http_response_status_code) (otel_demo_checkout_requests_total)

# 结账失败总数
sum(otel_demo_checkout_failures_total)

# P95 请求耗时
histogram_quantile(
  0.95,
  sum by (le) (rate(otel_demo_checkout_request_duration_milliseconds_bucket[5m]))
)
```

## 5. 查看 Log：Loki / Grafana

推荐从 Grafana 查看：

1. 打开 <http://localhost:3001>。
2. 进入预置的 **OpenTelemetry Demo / OpenTelemetry Node.js 全栈 Demo** Dashboard。
3. 底部日志面板使用以下 LogQL：

```logql
{service_name="checkout-service"}
```

每条业务日志都包含 `trace_id`。Grafana 的 Loki 数据源已配置 Derived Field，点击日志中的 TraceID 可以跳转到对应 Jaeger 链路。

只查看错误日志：

```logql
{service_name="checkout-service"} | detected_level="error"
```

## 6. Grafana Dashboard

Dashboard 已自动预置，无需手动添加数据源，包括：

- 请求总数
- 结账失败总数
- 按 HTTP 状态码划分的请求速率
- 请求耗时 P95
- 带 TraceID 的应用日志
- 跳转 Jaeger 的快捷入口

Grafana 已自动连接：

- Prometheus：`http://prometheus:9090`
- Loki：`http://loki:3100`
- Jaeger：`http://jaeger:16686`

## 7. 常用命令

```bash
# 查看所有后端状态
npm run infra:status

# 查看 Collector 收到的三类数据
docker compose logs -f otel-collector

# 停止后端，但保留 Prometheus、Loki、Grafana 数据卷
npm run infra:down

# 连数据卷一起删除，完全清空演示数据
docker compose down -v

# JavaScript 和 Compose 静态检查
npm run check
docker compose config --quiet
```

## 8. 文件说明

| 文件 | 作用 |
|---|---|
| `app.js` | Express 接口、业务 Span、自定义指标和关联日志 |
| `instrumentation.js` | OpenTelemetry SDK、自动插桩和三种 OTLP exporter |
| `otel-collector-config.yaml` | Trace、Metric、Log 三条 Collector pipeline |
| `prometheus.yaml` | Prometheus 抓取 Collector 的配置 |
| `loki-config.yaml` | Loki 单机存储配置 |
| `grafana/provisioning/` | Grafana 数据源和 Dashboard 自动预置 |
| `grafana/dashboards/` | 全栈 Demo Dashboard |
| `docker-compose.yaml` | Jaeger、Collector、Prometheus、Loki、Grafana |

这个配置用于本地学习，不是生产配置。生产环境还需要认证、TLS、持久化备份、采样、限流和高可用等设计。
