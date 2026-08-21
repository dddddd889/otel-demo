# 异步消息传播学习路线

异步消息能力按五个独立学习 commit 递进实现。每个 commit 只引入一个核心概念，并配一篇可独立操作的文档。

| 顺序 | 学习主题 | 状态 | 文档 |
| --- | --- | --- | --- |
| 1 | RabbitMQ 基础消息流 | commit `8764dce` | [01-rabbitmq-basic.md](01-rabbitmq-basic.md) |
| 2 | checkout 发布、`payment-service` 异步支付 | 已实现，工作区未提交 | [02-payment-service.md](02-payment-service.md) |
| 3 | 消息中传播 `traceparent` / Baggage | 待实现 | `03-context-propagation.md` |
| 4 | Producer/Consumer Span 与 Span Link | 待实现 | `04-messaging-spans.md` |
| 5 | 重试、死信队列与可观测性 | 待实现 | `05-retry-and-dlq.md` |

第 2 步真正提交后，应将“工作区未提交”替换为 commit hash。不要把五个主题合并成一篇完成态文档，否则无法按提交顺序复现能力演进。
