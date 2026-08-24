# Commit 5：支付重试、死信队列与可观测性

## 相对 Commit 4 的改动

本步为异步支付增加两种固定故障场景、最多两次延迟重试和最终死信队列：

```text
otel.demo.orders
  ├─ 处理成功 → ACK
  └─ 处理失败 → Confirm 发布到 otel.demo.orders.retry → ACK 原消息
                    │ 2 秒 TTL 到期
                    └─ RabbitMQ DLX → otel.demo.orders

第三次仍失败 → Confirm 发布到 otel.demo.orders.dlq → ACK 原消息
```

主队列、重试队列和 DLQ 都是持久队列，消息也以 persistent 模式发布。只有 Broker Confirm 成功后才 ACK 原消息，避免发布失败时丢单。若 Confirm 成功但 ACK 失败，系统仍可能重复投递，因此生产系统还必须用 `messageId` / `orderId` 做幂等；本 Demo 暂不实现支付落库与幂等表。

## 1. 启动并确认只有一个 Consumer

RabbitMQ 本地演示环境使用以下连接信息：

```text
管理界面：http://localhost:15672
用户名：otel
密码：otel-demo
应用 AMQP 地址：amqp://otel:otel-demo@localhost:5672
```

浏览器登录使用管理界面的用户名和密码；Node.js 服务使用 AMQP 地址连接 Broker。

```bash
npm run infra:up
npm start
```

另开终端：

```bash
npm run start:payment
```

启动信息应显示：

```text
最多重试 2 次，间隔 2000ms
```

打开 [主队列](http://localhost:15672/#/queues/%2F/otel.demo.orders)，确认 `Consumers = 1`。

## 2. 体验临时故障后恢复

```bash
curl -s 'http://localhost:3000/checkout?paymentRetry=true' | jq
```

payment 终端应依次显示：

```text
第 1 次尝试 → 进入 otel.demo.orders.retry
第 2 次尝试 → 进入 otel.demo.orders.retry
第 3 次尝试 → 支付完成并 ACK
```

在 [重试队列](http://localhost:15672/#/queues/%2F/otel.demo.orders.retry) 可短暂看到 `Ready = 1`；两秒后 RabbitMQ 通过 DLX 自动送回主队列。最终三个队列的新增消息都应归零，DLQ 不增加。

等待约 12–15 秒后打开响应中的 Jaeger 链接，应看到同一 Trace 中的链式结构：

```text
otel.demo.orders send
└─ otel.demo.orders process       retry.count=0 / ERROR
   └─ otel.demo.orders.retry send
      └─ otel.demo.orders process retry.count=1 / ERROR
         └─ otel.demo.orders.retry send
            └─ otel.demo.orders process retry.count=2 / OK
               └─ process-payment / OK
```

## 3. 体验永久失败进入 DLQ

先打开 [死信队列](http://localhost:15672/#/queues/%2F/otel.demo.orders.dlq)，记住当前 `Ready`。如需从零观察，可在队列页面执行 **Purge Messages**；这会删除该学习队列中已有的死信，不能恢复。

```bash
curl -s 'http://localhost:3000/checkout?paymentDlq=true' | jq
```

三次处理都会失败。最终应看到：

- 主队列和重试队列回到 `Ready = 0`。
- `otel.demo.orders.dlq` 的 `Ready` 增加 1。
- Jaeger 中出现两个 `otel.demo.orders.retry send` 和一个 `otel.demo.orders.dlq send`。
- 三个 Consumer Span 的 `demo.payment.retry.count` 分别为 `0`、`1`、`2`。

在 DLQ 页面选择 **Get messages**，Ack Mode 使用 **Nack message requeue true**，可查看但不删除消息。Payload 中是原订单，Headers 中应有：

```text
x-retry-count = 2
traceparent = 00-...
baggage = demo.cart.id=...,demo.tenant.id=...
```

## 4. 在 Loki 查看每次失败路由

复制响应的 Trace ID，在 Grafana Explore 选择 Loki：

```logql
{service_name="payment-service"} |= "TRACE_ID"
```

临时故障应有两条“支付失败，消息进入重试队列”和一条“异步支付完成”；永久故障应再有一条“支付失败，消息进入死信队列”。展开日志检查：

```text
demo_payment_retry_count
demo_payment_failure_route
demo_scenario
error_message
```

## 5. 可选运行态检查

保持服务运行，并确保主队列只有一个 Consumer：

```bash
npm run test:retry-dlq
```

脚本会真实验证 checkout、RabbitMQ 三个队列、Jaeger 重试 Span 和 Loki 日志。它会向 DLQ 增加一条教学消息，不会自动清空已有死信。

## 学习点与边界

- `NACK + requeue=true` 会立即重投，容易形成忙循环；TTL 重试队列提供明确退避。
- 重试次数放在消息 Header，业务 Payload 保持稳定。
- 每次重试重新注入 `traceparent`，下一次 Consumer 成为 retry Producer 的子级。
- 错误日志和 ERROR Span 使这些 Trace 被尾采样 100% 保留。
- DLQ 是隔离区，不是自动修复机制；人工检查、重新驱动、指数退避、随机抖动、幂等与告警属于后续生产化工作。
