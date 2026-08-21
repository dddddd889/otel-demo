# Commit 2：checkout 到 payment-service

## 相对 Commit 1 的改动

Commit 1 只能用独立命令行 Producer/Consumer 观察 RabbitMQ。本步把消息流接入业务：checkout 查询库存并创建订单后，将订单消息发布到 `otel.demo.orders`；独立 `payment-service` 消费消息、生成支付结果并 ACK。

```text
curl /checkout
  → checkout-service
  → HTTP inventory-service
  → RabbitMQ: otel.demo.orders
  → payment-service
```

checkout 只等待 RabbitMQ 的 Broker Confirm，响应中的 `paymentStatus` 是 `queued`；它不等待支付完成。这正是同步 HTTP 与异步消息的区别。

本步仍未传播 `traceparent` / Baggage，且明确关闭 amqplib 自动插桩，因此 Jaeger 暂时看不到 RabbitMQ 和 payment-service；这些属于 Commit 3、4。重试和死信队列属于 Commit 5。

## 手工验证：一次 checkout 触发异步支付

### 1. 准备干净队列

```bash
npm run infra:up
npm start
```

在终端 A 运行 `npm start` 并保持进程。打开 <http://localhost:15672>，以 `otel` / `otel-demo` 登录。确认 Commit 1 的 `rabbitmq:consumer` 已停止，在 **Queues and Streams → `otel.demo.orders`** 执行 **Purge Messages**。这只删除该学习队列里未消费的演示消息。

### 2. 暂不启动支付服务，先结账

```bash
curl -s http://localhost:3000/checkout
```

响应应包含以下关键字段：

```json
{
  "status": "created",
  "paymentStatus": "queued",
  "messageQueue": "otel.demo.orders"
}
```

复制响应中的 `orderId`。等待数秒并刷新 RabbitMQ 队列页面，应显示 `Ready = 1`、`Unacked = 0`，证明 checkout 已发布消息，即使支付服务不在线也能暂存。

要查看 RabbitMQ 中的原始消息，在队列页面展开 **Get messages**，将 **Ack Mode** 设为 `Nack message requeue true`、Messages 设为 1，再点 **Get Message(s)**。Payload 中的 `orderId` 应与 checkout 响应一致；requeue 模式会把消息放回队列，payment-service 后续仍能消费。

### 3. 启动 payment-service

另开终端：

```bash
npm run start:payment
```

终端应依次显示：

```text
payment-service 开始处理订单：order-...
payment-service 支付完成：
  "status": "paid"
payment-service 已 ACK：order-...
```

三个位置的 `orderId` 必须一致：checkout 响应、RabbitMQ Payload、支付终端。等待数秒并刷新管理界面，应为 `Ready = 0`、`Unacked = 0`、`Total = 0`。

### 4. 验证在线异步消费

保持 payment-service 运行，再执行一次 `curl`。checkout 会先返回 `queued`，支付终端随后打印同一订单的 `paid` 和 ACK。管理界面的 **Message rates** 可辅助观察 Publish、Deliver、Ack。

## 常见现象

- checkout 返回 500 且包含 RabbitMQ 连接错误：Broker 未启动，消息没有得到 Confirm。
- `Ready` 增长但支付终端没输出：payment-service 未启动、连接失败，或 Commit 1 的普通 Consumer 抢走了消息。
- 支付终端提示拒绝消息：消息缺少 `orderId`、正数 `amount` 或 `currency`，该消息会 NACK 且不重新入队。
- Jaeger 里只有 checkout/inventory：这是本步预期，异步上下文尚未传播。

## 学习点

- checkout 是 Producer，payment-service 是独立 Consumer；双方只共享消息契约和队列名。
- `queued` 表示 Broker 已接收，不等于 `paid`；支付最终结果不能从本次 checkout 响应推断。
- payment-service 成功处理后才 ACK；业务校验失败会 NACK 丢弃。
- Consumer 离线不影响 Producer 发布，恢复后可继续处理积压消息。
