# Commit 3：异步 Trace Context 与 Baggage

## 相对 Commit 2 的改动

Commit 2 的业务消息能到达 payment-service，但可观测上下文在 RabbitMQ 处中断。本步使用 OpenTelemetry Propagator，将 checkout 当前上下文注入 AMQP Headers，并在 payment-service 消费时提取：

```text
checkout active context
  → inject
  → AMQP headers: traceparent + baggage
  → extract
  → payment active context
```

`traceparent` 携带 Trace ID、上游 Span ID 和采样标志；`baggage` 携带 `demo.cart.id`、`demo.tenant.id`。消息 JSON 仍只放订单业务数据，业务契约与传播协议互不混合。

消费端只接受上述两个 Baggage 键，并限制传播 Header 和字段长度、拒绝控制字符。消息 Header 属于外部输入，不能直接作为可信日志属性。

本步没有启用 amqplib 自动插桩，也没有创建 Producer/Consumer Span 或 Span Link。因此 payment 日志可以带原 Trace ID，但 Jaeger 中暂时没有 payment-service Span；这是 Commit 4 的内容。

## 手工验证：看见上下文穿过 RabbitMQ

### 1. 只启动 HTTP 服务

```bash
npm run infra:up
npm start
```

确认旧的 `rabbitmq:consumer` 和 `start:payment` 都已停止。在 <http://localhost:15672> 使用 `otel` / `otel-demo` 登录，并清空 `otel.demo.orders` 中的演示消息。

### 2. 创建一条必定保留的慢请求

```bash
curl -s 'http://localhost:3000/checkout?slow=true'
```

复制响应中的 `orderId` 和 32 位 `observability.traceId`。使用慢请求是为了让 Collector 尾采样 100% 保留该 Trace。

### 3. 在 RabbitMQ 查看 Headers

进入 **Queues and Streams → `otel.demo.orders` → Get messages**：

- Ack Mode：`Nack message requeue true`
- Messages：`1`
- 点击 **Get Message(s)**

不要选择 Ack，否则消息会被移除。展开 Properties，应看到类似：

```text
traceparent: 00-TRACE_ID-PARENT_SPAN_ID-01
baggage: demo.cart.id=cart-...,demo.tenant.id=demo-shop
```

`traceparent` 中第二段必须与 checkout 响应的 Trace ID 完全相同。Payload 的 `orderId` 也应与响应一致。

### 4. 启动 payment-service 并核对提取结果

```bash
npm run start:payment
```

终端应打印：

```text
payment-service 恢复消息上下文：trace_id=TRACE_ID cart_id=cart-... tenant_id=demo-shop
payment-service 开始处理订单：order-...
payment-service 已 ACK：order-...
```

这里的 Trace ID 必须与 checkout 响应及 RabbitMQ `traceparent` 一致。

### 5. 在 Loki 查询跨异步服务日志

打开 checkout 响应中的 `grafanaLogs` 链接，或在 Grafana Explore 选择 Loki：

```logql
{service_name=~"checkout-service|inventory-service|payment-service"} |= "TRACE_ID"
```

只看支付日志：

```logql
{service_name="payment-service"} |= "TRACE_ID"
```

支付日志应包含 `异步支付完成`、相同 Trace ID、`demo.cart.id` 和 `demo.tenant.id`。

### 6. 理解 Jaeger 中“缺失”的部分

在 Jaeger 打开该 Trace：checkout 和 inventory Span 正常存在，但看不到 payment-service。上下文传播只把身份带过去，不会自动产生新 Span。payment 日志使用的 `span_id` 仍是消息发送时的上游 Span ID。Commit 4 将创建真正的 Producer/Consumer Span，并展示异步处理节点。

## 常见问题

- Header 中没有 `traceparent`：checkout 未通过 `instrumentation.js` 启动，或查看的是 Commit 1 命令行 Producer 产生的消息。
- payment 显示 `trace_id=无`：消息来自旧版本/手工 Producer，或者 payment 没用 `npm run start:payment` 启动。
- Loki 暂时搜不到：日志是批量导出的，等待约 3–5 秒并扩大到最近 15 分钟。
- Jaeger 看不到 payment-service：本步预期如此，不代表传播失败。

## 学习点

- Trace Context 是传播数据，不等于 Span。
- Baggage 适合传播少量业务上下文，但不应放密码、Token 或无限基数数据。
- `context.with(extractedContext, ...)` 保证异步处理和日志读取的是消息携带的上下文。
- HTTP Header 与 AMQP Header 使用不同载体，但都可通过同一 OTel Propagator 注入和提取。
