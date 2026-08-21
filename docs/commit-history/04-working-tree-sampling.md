# Working Tree：智能尾采样与 Metric 高基数治理

## 状态说明

这部分是当前工作区相对 `HEAD`（`8a0461b`）的尚未提交改动，没有 commit hash。项目指令禁止自动提交，因此本文明确标记为 Working Tree；未来提交后应按实际 hash 重命名并更新索引。

## 这组改动解决什么问题

让 Collector 按 Trace 价值决定是否保存，同时移除 Metric 的动态时间标签，避免时间序列爆炸和 `rate()` 失真。

## 相对 `8a0461b` 的主要改动

### Metric 高基数治理

- 删除 `metric_statements` 中动态 `timestamp_zh_cn`。
- Metric pipeline 移除 `transform/add-local-time`。
- Trace 和 Log 继续保留中文本地时间字段。
- Metric 只保留原生时间戳和有限场景、状态等稳定标签。

### 智能尾采样

`otel-collector-config.yaml` 当前策略：

| 条件 | 决策 |
| --- | --- |
| `/health` | 0%，全部丢弃 |
| Trace 含 `ERROR` | 100% 保留 |
| 总耗时超过 1000ms | 100% 保留 |
| 其他正常 Trace | 约 10% 保留 |

`decision_wait` 从 1 秒增加到 3 秒，避免在 1.2 秒慢请求完成前提前做出采样决定。

### 测试适配

- 新增 `scripts/sampling-test.js` 和 `npm run test:sampling`。
- 原 smoke test 改用必定保留的 `slow` 请求，避免正常 Trace 只采样 10% 后随机失败。
- scenario test 的 Exemplar 验证改为遍历场景内全部候选 ID，并要求至少一条真实 Jaeger Trace 带相同 `demo.scenario`。这符合 Exemplar 是抽样点且可能被并发流量替换的语义。

## 如何测试

```bash
npm run test:sampling
```

测试样本不是简单请求一次：

- `slow`、`db-error`、`redis-error`、`business-error` 各 3 次，要求 12/12 保留。
- `/health` 触发 100 次，要求 0/100 保留。
- 正常请求触发 400 次，10% 采样接受区间为 24～56。
- 先确认 Collector 暴露 checkout 业务 Metric，再断言不存在 `timestamp_zh_cn` 动态标签。

一次实际验证结果：

```text
四类必留：12/12
/health：0/100
正常 Trace：37/400
Metric timestamp_zh_cn：不存在
```

完整回归：

```bash
npm run check
npm run test:scenarios
npm run test:smoke
docker compose config --quiet
```

## 这个阶段要学什么

### Head Sampling 与 Tail Sampling

Head Sampling 在请求开始时决定，成本低，但不知道请求最终是否错误或变慢。Tail Sampling 等待完整 Trace 后决定，能优先保留高价值链路，但增加 Collector 的等待、内存和状态管理成本。

被 SDK Head Sampling 丢弃的数据不会到达 Collector，Tail Sampling 无法恢复，因此本实验要求 SDK 默认 `always_on`。

### 为什么 Metric 不能加动态时间字符串

Prometheus 使用“指标名 + 完整标签集”确定一条时间序列。时间字符串每次变化都会创建新序列，造成高基数、额外内存和存储开销，并让同一 Counter 被拆散，破坏 `rate()`。

验证 Collector 原始端点：

```bash
curl -s http://localhost:8889/metrics | grep timestamp_zh_cn
```

正确结果为空。Prometheus 中旧序列可能在陈旧标记或保留期结束前继续可见。

## 下一次 Commit 建议

把这组改动作为一个独立 commit，因为“采样策略”和“Metric 标签治理”共同围绕生产可用性与成本控制。提交后应：

1. 用真实短 hash 替换本文标题和状态说明。
2. 保留上述统计测试结果作为验收证据。
3. 不把 RabbitMQ/payment-service 混入同一 commit；异步消息传播应形成下一篇独立文档。
