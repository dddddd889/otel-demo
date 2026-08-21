# Commit 1：RabbitMQ 基础消息流

## 本次改动边界

这一学习 commit 只建立最小异步通道：Producer 把订单 JSON 写入持久化队列 `otel.demo.orders`，Consumer 读取并 ACK。新增 RabbitMQ Management、`amqplib`、共享连接模块、两个命令行程序和自动收发测试。

```text
Producer → RabbitMQ:5672 → otel.demo.orders → Consumer
                   └─ Management UI:15672
```

本次**没有**接入 checkout、payment-service、OpenTelemetry 消息插桩、Trace Context、Span Link、重试或死信队列；这些分别属于后续 commit。

## 手工验证：亲眼看到消息流转

### 1. 启动 RabbitMQ

```bash
docker compose up -d rabbitmq
docker compose ps rabbitmq
```

状态应包含 `healthy`。打开 <http://localhost:15672>，使用 `otel` / `otel-demo` 登录。确认 Consumer 没有运行；如果 **Queues and Streams → `otel.demo.orders`** 已存在，点击 **Purge Messages** 清空它。此操作只删除该学习队列中尚未消费的演示消息，确保下面从 0 开始计数。

### 2. 只启动 Producer，让消息留在队列

此时先不要启动 Consumer。在终端 A 发布一条固定订单：

```bash
npm run rabbitmq:producer -- order-learning-001
```

终端应打印发送的 JSON。然后在管理界面进入 **Queues and Streams → `otel.demo.orders`**，应看到：

- `Ready = 1`：消息在队列里，尚未交给 Consumer。
- `Unacked = 0`：当前没有 Consumer 正在处理。
- `Total = 1`：队列中共有一条未完成消息。

再执行一次并换一个 ID：

```bash
npm run rabbitmq:producer -- order-learning-002
```

刷新管理界面后，`Ready` 应变成 2。这一步证明 Producer 和 RabbitMQ 已连通，而且消息可以在 Consumer 不在线时暂存。

### 3. 启动 Consumer，观察消息被取走

在终端 B 启动：

```bash
npm run rabbitmq:consumer
```

终端 B 应依次打印两个订单的完整 JSON 及 `消息已 ACK：order-learning-...`。刷新队列页面后应看到 `Ready = 0`、`Unacked = 0`、`Total = 0`。终端的 ACK 输出是确定性证据，界面计数归零是 Broker 侧证据。

### 4. 在线观察一发一收

保持 Consumer 运行，在终端 A 再发送：

```bash
npm run rabbitmq:producer -- order-learning-003
```

终端 B 会立即打印相同 `orderId`。管理界面的 **Message rates** 会短暂出现 Publish、Deliver 和 Ack 曲线。最后按 `Ctrl+C` 停止 Consumer。

### 5. 出现问题时先看哪里

```bash
docker compose logs --tail=100 rabbitmq
docker compose ps rabbitmq
```

- 没有 `otel.demo.orders`：Producer 尚未成功执行，先看终端 A 的连接错误。
- `Ready` 持续增加：Producer 正常，Consumer 没启动或连接失败。
- `Unacked` 不归零：Consumer 收到了消息，但还没有 ACK 或处理被阻塞。
- `ACCESS_REFUSED`：检查账号密码是否为 `otel` / `otel-demo`，以及 `AMQP_URL` 是否被本地环境覆盖。

## 可选：自动回归

```bash
npm run test:rabbitmq
```

手工观察完成后，才用此命令做快速回归。它会创建唯一临时队列，发布 JSON、消费并比较内容、ACK，最后删除队列；它不能替代上面的 UI 学习过程。

## 学习点

- Broker 负责路由和暂存，队列解耦 Producer 与 Consumer 的运行时间。
- `durable: true` 保留队列定义，`persistent: true` 请求持久化消息；两者含义不同。
- Confirm Channel 证明 Broker 接受了发布，Consumer ACK 证明业务侧处理完成。
- `prefetch(1)` 限制单个 Consumer 同时持有的未确认消息数。
- JSON 只是载荷格式；稳定的消息契约、幂等和错误恢复将在后续 commit 继续补充。
