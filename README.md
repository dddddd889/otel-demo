# OpenTelemetry Node.js 全栈 Demo

这是一个 Node.js + OpenTelemetry 可观测性示例，通过 Jaeger、Prometheus、Loki 和 Grafana 统一体验分布式链路、指标、日志及三者关联。

按 Git 提交拆分的改动、测试和学习文档见 [按 Commit 学习 OpenTelemetry Demo](docs/commit-history/README.md)。
异步消息按五个独立学习 commit 递进，见 [异步消息传播学习路线](docs/async-messaging/README.md)。

```text
客户端 → checkout-service:3000 → inventory-service:3002
          │                           ├─ Redis
          │                           └─ MySQL
          └─ RabbitMQ → payment-service（异步，暂未接入 OTel 上下文）

两个应用进程 ── OTLP/HTTP ──> OpenTelemetry Collector
                                ├─ Trace  ─> Jaeger
                                ├─ Metric ─> Prometheus
                                └─ Log    ─> Loki

Grafana ──> Prometheus + Loki + Jaeger
```

## 功能清单

- Node.js HTTP、Express、Redis、MySQL 自动插桩
- `validate-cart`、`create-order` 等业务 Span 手动插桩
- 跨进程 W3C Trace Context 与 Baggage 传播
- `X-Trace-Id` 响应头，可立即定位单次请求
- Trace、Metric、Log 通过 OTLP 统一发送到 Collector
- Collector 内存保护、批处理、资源属性补充和智能尾采样
- Loki 日志到 Jaeger Trace 跳转
- Prometheus Exemplar 到 Jaeger Trace 跳转
- SDK 可配置头部采样
- Prometheus 规则告警和 Grafana 托管告警
- 可在 Grafana UI 中修改并保存预置 Dashboard

## 1. 启动

要求：Node.js 20+、Docker 和 Docker Compose。

```bash
npm install
npm run infra:up
npm start
```

首次启动需要等待 MySQL 健康：

```bash
npm run infra:status
curl http://localhost:3002/health
curl http://localhost:3000/health
```

| 组件 | 地址 | 用途 |
|---|---|---|
| Checkout | <http://localhost:3000> | 对外结账服务 |
| Inventory | <http://localhost:3002> | 库存、Redis、MySQL 调用 |
| Jaeger | <http://localhost:16686> | Trace 查询 |
| Prometheus | <http://localhost:9090> | Metric 和规则告警 |
| Loki API | <http://localhost:3100> | Log 存储，无独立 UI |
| Grafana | <http://localhost:3001> | 统一查询和 Dashboard |
| RabbitMQ | <http://localhost:15672> | 消息队列管理，账号 `otel` / `otel-demo` |

Grafana 管理员账号为 `admin` / `admin`；匿名访问只有 Viewer 权限。

## 2. 产生数据并获取 Trace ID

成功请求：

```bash
curl -i http://localhost:3000/checkout
```

响应头会立即返回：

```text
X-Trace-Id: 0123456789abcdef0123456789abcdef
```

响应 JSON 的 `observability` 字段还会直接提供 Jaeger Trace、Grafana 日志、Prometheus 查询和 Grafana Dashboard 链接，复制到浏览器即可打开。

失败请求：

```bash
curl -i 'http://localhost:3000/checkout?fail=true'
```

持续轮流产生正常、慢请求、数据库错误、Redis 错误和业务错误，并为每条请求打印 Jaeger、Grafana 和 Prometheus 直达链接：

```bash
npm run traffic
```

按 `Ctrl+C` 停止造数。不要在 `curl` 后添加 `>/dev/null`，它会丢弃包含查询链接的响应。

### 可控故障场景

| 场景 | 请求 | 预期结果 |
| --- | --- | --- |
| 正常 | `curl http://localhost:3000/checkout` | HTTP 200 |
| 慢请求 | `curl 'http://localhost:3000/checkout?slow=true'` | HTTP 200，新增约 1.2 秒 Span |
| MySQL 错误 | `curl 'http://localhost:3000/checkout?dbError=true'` | HTTP 500，SQL Span 标记错误 |
| Redis 错误 | `curl 'http://localhost:3000/checkout?redisError=true'` | HTTP 500，Redis Span 标记错误 |
| 业务错误 | `curl 'http://localhost:3000/checkout?fail=true'` | HTTP 500，根 Span 标记错误 |

## 3. Trace 与跨服务传播

打开 Jaeger，选择 `checkout-service` 后点击 **Find Traces**。成功链路包含：

```text
GET /checkout                         checkout-service
├─ validate-cart                      手动业务 Span
├─ GET inventory-service:3002         HTTP 客户端自动 Span
│  └─ GET /inventory/:sku             inventory-service
│     ├─ redis-GET / redis-SETEX       Redis 自动 Span
│     └─ SELECT                        MySQL 自动 Span
└─ create-order                       手动业务 Span
```

两个服务共享同一个 Trace ID。`demo.cart.id` 和 `demo.tenant.id` 通过 W3C Baggage 传播到库存服务，并出现在库存日志中。为完整展示两种客户端自动插桩，演示接口每次都会访问 Redis 和 MySQL；Redis 命中状态仅作为遥测属性，不用于跳过数据库查询。Collector 会整条丢弃 `/health` Trace，避免健康检查污染业务链路。

## 4. Metric、Exemplar 与告警

Prometheus 常用查询：

```promql
sum(checkout_request_duration_seconds_count)
```

```promql
sum by (demo_scenario, http_response_status_code) (
  checkout_request_duration_seconds_count
)
```

```promql
histogram_quantile(
  0.95,
  sum by (le) (
    rate(checkout_request_duration_seconds_bucket[5m])
  )
) * 1000
```

应用同时通过 OTLP 记录标准指标，并在 `/metrics` 暴露一个 OpenMetrics Histogram 用于演示 Exemplar。Prometheus 直接抓取该端点；Grafana 的“请求耗时 P95”面板已启用 Exemplar，将鼠标移到数据点并点击 Exemplar 可跳转到 Jaeger。

### 一次完整排障练习

1. 执行 `npm run traffic`，在 Grafana Dashboard 查看按 `demo_scenario` 分组的请求速率和 P95。
2. 在“请求耗时 P95”曲线上找到 `slow`，点击数据点的 Exemplar 跳转 Jaeger。
3. 在 Jaeger 中找到 `simulate-slow-checkout`；错误场景则查看红色的 SQL、Redis 或根 Span。
4. 复制 Trace ID，在 Grafana Loki 查询 `{service_name=~"checkout-service|inventory-service"} |= "TRACE_ID"`。
5. 展开日志，检查 `demo_scenario`、`error.type`、`error.message` 和 `timestamp_zh_cn`。

自动验证全部故障链路：

```bash
npm run test:scenarios
```

Prometheus 告警规则位于 `prometheus-alerts.yaml`：

- `CheckoutFailuresDetected`：最近一分钟出现失败。
- `CheckoutP95LatencyHigh`：P95 延迟持续一分钟超过 500ms。

在 <http://localhost:9090/alerts> 查看 Prometheus 告警。Grafana 还预置了 `Checkout failures detected` 托管告警，可在 **Alerting → Alert rules** 查看。

## 5. Log 与 Trace 关联

在 Grafana **Explore** 选择 Loki：

```logql
{service_name=~"checkout-service|inventory-service"}
```

只看错误：

```logql
{service_name="checkout-service"} | detected_level="error"
```

按 Trace ID 查询：

```logql
{service_name=~"checkout-service|inventory-service"}
  |= "0123456789abcdef0123456789abcdef"
```

展开日志后点击 `TraceID` 可跳转到 Jaeger。不要使用 `{trace_id="..."}`，因为 Trace ID 是结构化元数据和日志正文，不是 Loki 流标签。

## 6. 采样

应用 SDK 默认采集全部 Trace，Collector 查看完整链路后执行尾采样：

| Trace 类型 | Collector 决策 |
| --- | --- |
| `/health` | 0%，整条丢弃 |
| 状态为 `ERROR` | 100% 保留 |
| 总耗时超过 1000ms | 100% 保留 |
| 其他正常请求 | 约 10% 保留 |

运行可重复实验：

```bash
npm run test:sampling
```

如果在 SDK 侧改为 50% 头部采样：

```bash
OTEL_TRACES_SAMPLER=parentbased_traceidratio \
OTEL_TRACES_SAMPLER_ARG=0.5 \
npm start
```

`parentbased_traceidratio` 会让库存服务继承结账服务的采样决定，但被 SDK 丢弃的 Trace 永远到不了 Collector，因此错误/慢请求也无法被尾采样“救回”。研究尾采样时应保持 SDK 默认 `always_on`。示例变量见 `.env.example`。

### Metric 高基数对比

Metric 数据点原生带时间戳，不再添加动态 `timestamp_zh_cn` 标签。动态时间标签会让每次采集形成新序列，破坏 `rate()`、增加内存和存储成本。Collector 原始 Prometheus 端点可直接验证：

```bash
curl -s http://localhost:8889/metrics | grep timestamp_zh_cn
```

正确结果为空。Prometheus 中历史高基数序列可能要等待陈旧标记或数据保留期结束后才消失。

## 7. Collector 处理与调试

Collector 的处理流程：

```text
OTLP receiver
  → memory_limiter
  → tail_sampling（丢弃健康检查；全留错误/慢请求；正常采样 10%）
  → resource（deployment.environment.name=local-demo）
  → batch
  → exporters
```

`transform/add-local-time` 只为 Log 和 Span 添加 `timestamp_zh_cn`；Metric 保留原生时间戳和稳定标签。

查看 Collector 收到的数据和导出错误：

```bash
docker compose logs -f otel-collector
```

## 8. Grafana Dashboard

进入 **Dashboards → OpenTelemetry Demo → OpenTelemetry Node.js 全栈 Demo**，可查看请求、失败、状态码速率、P95、Exemplar 和两服务关联日志。

预置配置启用了 `allowUiUpdates`。使用 `admin` 登录后可直接编辑和保存，也可通过 **Save as** 创建实验副本。

## 9. RabbitMQ 基础消息流

当前已实现 checkout → RabbitMQ → payment-service：checkout 返回 `paymentStatus: queued`，支付服务异步处理并 ACK。OpenTelemetry 异步上下文传播尚未加入。

```bash
# 终端 1：启动 checkout 与 inventory
npm start

# 终端 2：启动异步支付消费者
npm run start:payment

# 终端 3：创建订单并发布支付消息
curl -s http://localhost:3000/checkout
```

管理界面：<http://localhost:15672>。先学习 [Commit 1：RabbitMQ 基础消息流](docs/async-messaging/01-rabbitmq-basic.md)，再操作 [Commit 2：checkout 到 payment-service](docs/async-messaging/02-payment-service.md)。

## 10. 检查与清理

```bash
npm run check
docker compose config --quiet
npm run infra:status
npm run test:smoke

# 停止后端并保留数据卷
npm run infra:down

# 连同 MySQL、Prometheus、Loki、Grafana 数据一起清空
docker compose down -v
```

本项目用于本地学习。生产环境还需使用密钥管理、认证、TLS、持久化备份、正式采样策略、限流、高可用和告警通知渠道。
