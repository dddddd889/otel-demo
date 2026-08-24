# 异步消息传播学习路线

异步消息能力按五个独立学习 commit 递进实现。每个 commit 只引入一个核心概念，并配一篇可独立操作的文档。

| 顺序 | 学习主题 | 状态 | 文档 |
| --- | --- | --- | --- |
| 1 | RabbitMQ 基础消息流 | commit `8764dce` | [01-rabbitmq-basic.md](01-rabbitmq-basic.md) |
| 2 | checkout 发布、`payment-service` 异步支付 | commit `c7d3ec7` | [02-payment-service.md](02-payment-service.md) |
| 3 | 消息中传播 `traceparent` / Baggage | commit `84b1fa3` | [03-context-propagation.md](03-context-propagation.md) |
| 4 | Producer/Consumer Span 与 Span Link | commit `8296ff9` | [04-messaging-spans.md](04-messaging-spans.md) |
| 5 | 重试、死信队列与可观测性 | commit `7aecc6d` | [05-retry-and-dlq.md](05-retry-and-dlq.md) |

五个主题保持独立文档，便于按提交顺序复现能力演进。完成这条支线后，继续学习 [Node.js 自动插桩原理](../../lessons/0001-how-node-auto-instrumentation-works.html)。
