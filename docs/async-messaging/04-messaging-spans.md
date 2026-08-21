# Commit 4：Producer、Consumer Span 与 Span Link

## 相对 Commit 3 的改动

Commit 3 只传播上下文，所以 Loki 有 payment 日志，Jaeger 却没有 payment-service。本步手动创建三个 Span，让异步链路真正进入 Jaeger：

```text
GET /checkout                         checkout-service
└─ otel.demo.orders send              PRODUCER / checkout-service
   └─ otel.demo.orders process        CONSUMER / payment-service
      └─ process-payment              INTERNAL / payment-service
         └─ Link → Producer Span
```

Producer Span 内注入 `traceparent`，因此消息指向 Producer，而不是直接指向 HTTP Span。Consumer 以提取出的 Producer Context 为父级；`process-payment` 是 Consumer 的子级，并用 Span Link 保留对原 Producer 的额外引用。

amqplib 自动插桩仍保持关闭，避免自动 Span 与手动 Span 重复。重试和死信队列仍属于 Commit 5。

## 手工验证：在 Jaeger 看见 payment-service

### 1. 重新加载 Collector 配置

本步把尾采样 `decision_wait` 从 3 秒提高到 8 秒，覆盖三个进程各自批量导出的时间差。修改配置后必须重启 Collector：

```bash
npm run infra:up
docker compose restart otel-collector
```

### 2. 启动三个业务进程

```bash
# 终端 A：checkout + inventory
npm start

# 终端 B：payment
npm run start:payment
```

确认 Commit 1 的普通 `rabbitmq:consumer` 没有运行，否则它可能先取走订单。

### 3. 产生必定保留的异步 Trace

```bash
curl -s 'http://localhost:3000/checkout?slow=true'
```

复制响应中的 `observability.jaeger` 链接。等待约 12–15 秒，再打开链接；慢请求由尾采样 100% 保留。

### 4. 在 Jaeger 核对 Span 树

Trace 页面应同时出现三种 Service：

- `checkout-service`
- `inventory-service`
- `payment-service`

在搜索框输入 `otel.demo.orders`，应找到：

- `otel.demo.orders send`：`span.kind=producer`，属于 checkout-service。
- `otel.demo.orders process`：`span.kind=consumer`，属于 payment-service。
- `process-payment`：属于 payment-service，是真正的支付业务步骤。

三个 Span 都应带相同的 `demo.order.id`。消息 Span 还包含：

```text
messaging.system = rabbitmq
messaging.destination.name = otel.demo.orders
messaging.operation.type = send | process
messaging.message.id = message-...
```

Consumer Span 覆盖消息解析、支付处理和 ACK；只有 ACK 成功后才标记 `OK`。坏 JSON、业务处理失败或 ACK 失败都会在 Consumer Span 上记录异常并标记 `ERROR`。

### 5. 查看父子关系和 Span Link

展开 `process-payment` 的 References：

- `CHILD_OF` 指向 Consumer Span。
- `FOLLOWS_FROM` 指向 Producer Span；这是 OpenTelemetry Span Link 在 Jaeger 中的展示。

父子关系决定 Span 在同一 Trace 树中的主要位置；Link 表示额外因果关系，不改变父级。单消息场景仅靠父子关系已足够，本项目额外添加 Link 是为了学习；批量消费、多来源聚合时 Link 更有价值。

### 6. 从 payment 日志跳回 Trace

在 Grafana Explore 查询：

```logql
{service_name="payment-service"} |= "TRACE_ID"
```

此时支付日志的 `span_id` 应对应 `process-payment`，点击 Trace ID 可打开包含三个服务的完整 Jaeger Trace。

### 7. 可选：运行态快速回归

保持两个业务终端运行，再在第三个终端执行：

```bash
npm run test:messaging-e2e
```

它会自行触发一次慢请求，然后查询 Jaeger，验证 Producer、Consumer、`process-payment` 的服务名、父子关系和 Span Link。这个命令是辅助检查；建议仍按第 3–6 步亲手打开界面核对字段。

## 常见问题

- Jaeger 返回 `trace not found`：Collector 尚未完成 8 秒尾采样和批量导出，等待 12–15 秒；并确认已重启 Collector。
- Trace 有 checkout/inventory、没有 payment：payment-service 没启动，消息被普通 Consumer 抢走，或运行的仍是旧进程。
- 出现两套 RabbitMQ Span：不要启用 amqplib 自动插桩；本步使用手动 Span。
- Jaeger 里 Link 显示为 `FOLLOWS_FROM`：这是 Jaeger 对 OTel Span Link 的转换结果。
- payment 离线超过 8 秒：Collector 可能已经对不完整 Trace 做出尾采样决定；本提交先学习及时消费，离线重试与更长异步链路留到后续设计。

## 学习点

- Context 负责传播身份，Span 负责记录实际操作。
- Producer Span 覆盖发布与 Broker Confirm，Consumer Span 覆盖消息处理入口。
- `SpanKind.PRODUCER` / `CONSUMER` 让后端理解消息方向。
- Span Link 适合表达无法作为单一父子关系的异步因果关联。
- Tail Sampling 必须等待跨进程 Span 到齐，否则可能基于不完整 Trace 提前决策。
