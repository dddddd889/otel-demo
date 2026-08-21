# 按 Commit 学习 OpenTelemetry Demo

本目录严格按照 Git 历史拆分文档：一个 commit 对应一篇文档，只解释该 commit 相对父提交新增的能力、测试方式和学习重点。当前尚未提交的工作区改动单独记录，不伪造 commit hash。

| 顺序 | Commit | 主题 | 文档 |
| --- | --- | --- | --- |
| 1 | `d226a31` | 初始化单服务三类遥测 | [01-d226a31-init.md](01-d226a31-init.md) |
| 2 | `477a32e` | 跨服务采集、存储、查询和关联 | [02-477a32e-observability.md](02-477a32e-observability.md) |
| 3 | `8a0461b` | 可控故障与排障练习 | [03-8a0461b-troubleshooting.md](03-8a0461b-troubleshooting.md) |
| 4 | 尚未提交 | 智能尾采样与 Metric 高基数治理 | [04-working-tree-sampling.md](04-working-tree-sampling.md) |

异步消息使用另一条递进学习线，见 [异步消息传播学习路线](../async-messaging/README.md)。RabbitMQ 基础流为 `8764dce`，checkout 到 payment-service 为 `9770baf`；异步上下文传播正在工作区实现。

## 推荐学习方式

按表格顺序阅读。每篇文档都先列出该 commit 的边界，再给出运行和查询步骤。需要切换到历史版本实际操作时，可在独立临时分支或 worktree 中检出对应 commit；不要在有未提交改动的当前工作区直接切换。

## 异步能力边界

当前已有 RabbitMQ 基础流、checkout 发布和 payment-service 消费，工作区还实现了异步 Trace Context 与 Baggage。Producer/Consumer Span、Span Link、重试和死信队列仍未实现，不能写成已完成能力。
