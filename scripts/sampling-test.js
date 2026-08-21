'use strict';

// 智能采样必须完整保留的场景。
const retainedScenarios = [
  ['slow', 'http://localhost:3000/checkout?slow=true'],
  ['db-error', 'http://localhost:3000/checkout?dbError=true'],
  ['redis-error', 'http://localhost:3000/checkout?redisError=true'],
  ['business-error', 'http://localhost:3000/checkout?fail=true'],
];

// 暂停指定时间，等待 Collector 决策和批量导出。
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 触发请求并返回服务端生成的 Trace ID。
async function trigger(url) {
  const response = await fetch(url);
  await response.arrayBuffer();
  const traceId = response.headers.get('x-trace-id');
  if (!/^[a-f0-9]{32}$/.test(traceId || '')) {
    throw new Error(`请求没有返回有效 Trace ID：${url}`);
  }
  return traceId;
}

// 查询 Jaeger，判断指定 Trace 是否已经入库。
async function hasTrace(traceId) {
  const response = await fetch(`http://localhost:16686/api/traces/${traceId}`);
  const result = await response.json();
  return Boolean(result.data?.length);
}

// 等待必须保留的 Trace 出现在 Jaeger。
async function waitForTrace(name, traceId) {
  for (let index = 0; index < 20; index += 1) {
    if (await hasTrace(traceId)) {
      console.log(`${name} 已保留，Trace ID：${traceId}`);
      return;
    }
    await delay(1000);
  }
  throw new Error(`${name} Trace 未被保留：${traceId}`);
}

// 验证 Collector 暴露的 Metric 不包含动态本地时间标签。
async function verifyStableMetricLabels() {
  const response = await fetch('http://localhost:8889/metrics');
  const metricsText = await response.text();
  if (!metricsText.includes('otel_demo_checkout_requests_total')) {
    throw new Error('Collector 端点缺少 checkout 业务指标，无法验证标签');
  }
  if (metricsText.includes('timestamp_zh_cn=')) {
    throw new Error('Metric 仍包含 timestamp_zh_cn 高基数标签');
  }
  console.log('Metric 标签稳定：未发现 timestamp_zh_cn');
}

// 验证错误和慢请求全保留、健康检查全丢弃、正常请求约保留 10%。
async function main() {
  const retainedTraceIds = [];
  for (const [name, url] of retainedScenarios) {
    // 每类必留场景重复三次，避免错误策略失效时偶然命中 10% 普通采样而假通过。
    for (let repeatIndex = 1; repeatIndex <= 3; repeatIndex += 1) {
      retainedTraceIds.push([`${name}#${repeatIndex}`, await trigger(url)]);
    }
  }

  const healthTraceIds = [];
  for (let batchIndex = 0; batchIndex < 5; batchIndex += 1) {
    const batchTraceIds = await Promise.all(Array.from(
      { length: 20 },
      () => trigger('http://localhost:3000/health'),
    ));
    healthTraceIds.push(...batchTraceIds);
  }
  const normalTraceIds = [];
  for (let batchIndex = 0; batchIndex < 100; batchIndex += 1) {
    // 每批并发不超过 MySQL 连接池大小，避免排队把普通请求误变成慢请求。
    const batchTraceIds = await Promise.all(Array.from(
      { length: 4 },
      () => trigger('http://localhost:3000/checkout'),
    ));
    normalTraceIds.push(...batchTraceIds);
  }

  await Promise.all(retainedTraceIds.map(([name, traceId]) => waitForTrace(name, traceId)));
  await delay(8000);

  const healthResults = await Promise.all(healthTraceIds.map(hasTrace));
  const retainedHealthTraceIds = healthTraceIds.filter((traceId, index) => healthResults[index]);
  if (retainedHealthTraceIds.length) {
    throw new Error(`/health Trace 不应被保留：${retainedHealthTraceIds.join(', ')}`);
  }
  console.log('/health 已全部丢弃：0/100 保留');

  const normalResults = await Promise.all(normalTraceIds.map(hasTrace));
  const retainedNormalCount = normalResults.filter(Boolean).length;
  // 400 个样本使用约 99% 置信区间，可稳定区分目标 10% 与明显误配的 20%。
  if (retainedNormalCount < 24 || retainedNormalCount > 56) {
    throw new Error(`正常 Trace 采样数量异常：${retainedNormalCount}/400`);
  }
  console.log(`正常 Trace 保留 ${retainedNormalCount}/400，目标比例约 10%`);

  await verifyStableMetricLabels();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
