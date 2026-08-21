# Commit 3：可控故障与排障练习

## Commit 信息

- Hash：`8a0461b4a1a526e006ca5ef423c1f0ae1f8001d9`
- Subject：`尝试体验排查错误`
- 时间：2026-08-21 15:58:01 +08:00
- 父提交：`477a32e`

## 这个 Commit 解决什么问题

把“能看到遥测数据”升级为“能针对不同故障完成 Metric → Trace → Log 排查”。所有场景使用固定低基数名称，能够重复触发和自动验证。

## 相对上一个 Commit 的主要改动

### 新增五种固定场景

| 请求 | `demo.scenario` | 结果 |
| --- | --- | --- |
| `/checkout` | `normal` | HTTP 200 |
| `/checkout?slow=true` | `slow` | HTTP 200，增加约 1.2 秒 Span |
| `/checkout?dbError=true` | `db-error` | MySQL 错误，最终 HTTP 500 |
| `/checkout?redisError=true` | `redis-error` | Redis 错误，最终 HTTP 500 |
| `/checkout?fail=true` | `business-error` | 模拟库存不足，HTTP 500 |

### 遥测标记

- checkout 根 Span、业务日志、Metric 增加 `demo.scenario`。
- inventory 限制允许的失败枚举，避免任意查询参数进入 Loki/Metric 标签。
- DB、Redis 错误记录 Exception 并把 Span 标记为 `ERROR`。
- 错误日志记录 `error.type`、`error.message` 和场景。

### Dashboard 与告警

- 请求速率按 `demo_scenario` 和 HTTP 状态分组。
- P95 按场景分组，可直接看到 `slow` 曲线。
- 错误告警改用 OpenMetrics 请求状态数据，继续覆盖 500 响应。

### 测试和造数

- `npm run traffic` 轮流制造五种场景并打印直达链接。
- 新增 `scripts/scenario-test.js` 和 `npm run test:scenarios`。

## 如何测试

```bash
npm run test:scenarios
```

测试逐场景检查：

- 响应状态、场景名和 Trace 链接。
- Jaeger 中的场景属性和目标 Span。
- `slow` Span 至少持续一秒。
- DB/Redis 客户端 Span 属于 inventory-service 且为 `ERROR`。
- Loki 中存在相同场景和正确日志级别。
- Prometheus 存在场景 Metric，Exemplar 能跳到真实 Jaeger Trace。

## 按场景学习排障

### slow

```bash
curl 'http://localhost:3000/checkout?slow=true'
```

Metric P95 先显示 `slow` 升高；Jaeger 中 `simulate-slow-checkout` 最长；日志没有 ERROR。学习点是“慢不等于错”。

### db-error

```bash
curl 'http://localhost:3000/checkout?dbError=true'
```

Jaeger 中 inventory 的 `SELECT` 为红色；Loki 第一条 ERROR 来自 inventory，错误消息包含未知字段。checkout 错误是上游传播结果。

### redis-error

```bash
curl 'http://localhost:3000/checkout?redisError=true'
```

Jaeger 中 `redis-GET` 为红色；inventory 日志包含 Redis 参数错误；checkout 最终返回 500。

### business-error

```bash
curl 'http://localhost:3000/checkout?fail=true'
```

Redis、MySQL Span 正常，checkout 根 Span 和业务日志报“模拟库存不足”。学习点是依赖正常时应把故障边界定位到业务服务。

## 这个 Commit 要学什么

- 排障先看 Metric 判断影响，再用 Trace 找第一个错误或最长 Span，最后用 Log 确认细节。
- `service_name` 决定故障边界，`trace_id` 关联整次请求，`span_id` 精确关联步骤。
- 测试必须确认错误 Span 的服务归属，不能只按常见操作名匹配。
- 场景标签必须固定枚举，否则调试入口本身会制造高基数。

## 这个阶段还没有什么

- 尚未按价值采样，普通、错误、慢 Trace 的保留策略没有区分。
- Metric 曾包含动态本地时间标签，存在高基数教学问题。
- 没有 RabbitMQ、payment-service 或异步消息上下文传播。
