'use strict';

// 故障场景定义：覆盖慢请求、数据库错误和 Redis 错误三条排障链路。
const scenarios = [
  {
    name: 'slow',
    url: 'http://localhost:3000/checkout?slow=true',
    status: 200,
    operation: 'simulate-slow-checkout',
    logLevel: 'info',
  },
  {
    name: 'db-error',
    url: 'http://localhost:3000/checkout?dbError=true',
    status: 500,
    operation: 'SELECT',
    logLevel: 'error',
  },
  {
    name: 'redis-error',
    url: 'http://localhost:3000/checkout?redisError=true',
    status: 500,
    operation: 'redis-GET',
    logLevel: 'error',
  },
];

// 等待异步导出完成，直到检查函数返回有效结果。
async function poll(check, attempts = 30) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('等待遥测数据超时');
}

// 触发单个场景并验证响应中的场景名、Trace ID 与直达链接。
async function triggerScenario(scenario) {
  const response = await fetch(scenario.url);
  const body = await response.json();
  const traceId = response.headers.get('x-trace-id');

  if (response.status !== scenario.status || body.scenario !== scenario.name) {
    throw new Error(`${scenario.name} 响应不符合预期：${response.status} ${JSON.stringify(body)}`);
  }
  if (!/^[a-f0-9]{32}$/.test(traceId || '') || !body.observability?.jaeger?.endsWith(traceId)) {
    throw new Error(`${scenario.name} 缺少有效的 Trace 查询链接`);
  }
  return traceId;
}

// 验证 Jaeger 中存在预期操作和场景属性。
async function verifyTrace(scenario, traceId) {
  return poll(async () => {
    const response = await fetch(`http://localhost:16686/api/traces/${traceId}`);
    const result = await response.json();
    const trace = result.data?.[0];
    const spans = trace?.spans || [];
    const getServiceName = (span) => trace.processes?.[span.processID]?.serviceName;
    const rootSpan = spans.find((span) =>
      getServiceName(span) === 'checkout-service' &&
      span.tags?.some((tag) => tag.key === 'demo.scenario' && tag.value === scenario.name));
    const expectedSpan = spans.find((span) =>
      span.operationName === scenario.operation &&
      (scenario.name === 'slow' || getServiceName(span) === 'inventory-service'));

    if (!rootSpan || !expectedSpan) {
      return undefined;
    }
    if (scenario.name === 'slow' && expectedSpan.duration < 1_000_000) {
      throw new Error('慢请求 Span 耗时不足一秒');
    }
    if (scenario.status >= 500) {
      const errorTag = rootSpan.tags?.find((tag) => tag.key === 'otel.status_code');
      if (errorTag?.value !== 'ERROR') {
        throw new Error(`${scenario.name} 根 Span 未标记 ERROR`);
      }
      const dependencyErrorTag = expectedSpan.tags?.find((tag) => tag.key === 'otel.status_code');
      if (dependencyErrorTag?.value !== 'ERROR') {
        throw new Error(`${scenario.name} 依赖 Span 未标记 ERROR`);
      }
    }
    return trace;
  });
}

// 验证 Prometheus 场景标签与 Exemplar 能关联到一条真实 Trace。
async function verifyMetrics(scenario) {
  return poll(async () => {
    const metricExpression = `checkout_request_duration_seconds_count{demo_scenario="${scenario.name}"}`;
    const metricUrl = new URL('http://localhost:9090/api/v1/query');
    metricUrl.searchParams.set('query', metricExpression);
    const metricResponse = await fetch(metricUrl);
    const metricResult = await metricResponse.json();
    if (!(metricResult.data?.result || []).length) {
      return undefined;
    }

    const exemplarExpression = `checkout_request_duration_seconds_bucket{demo_scenario="${scenario.name}"}`;
    const exemplarUrl = new URL('http://localhost:9090/api/v1/query_exemplars');
    exemplarUrl.searchParams.set('query', exemplarExpression);
    exemplarUrl.searchParams.set('start', String(Math.floor(Date.now() / 1000) - 120));
    exemplarUrl.searchParams.set('end', String(Math.floor(Date.now() / 1000)));
    const exemplarResponse = await fetch(exemplarUrl);
    const exemplarResult = await exemplarResponse.json();
    const exemplarTraceIds = [...new Set((exemplarResult.data || []).flatMap((series) =>
      (series.exemplars || []).map((exemplar) => exemplar.labels?.trace_id))
      .filter((traceId) => /^[a-f0-9]{32}$/.test(traceId || '')))];
    if (!exemplarTraceIds.length) {
      return undefined;
    }
    const traceResults = await Promise.all(exemplarTraceIds.map(async (exemplarTraceId) => {
      const traceResponse = await fetch(`http://localhost:16686/api/traces/${exemplarTraceId}`);
      return traceResponse.json();
    }));
    const linkedTraceExists = traceResults.some((traceResult) =>
      (traceResult.data?.[0]?.spans || []).some((span) =>
        span.tags?.some((tag) => tag.key === 'demo.scenario' && tag.value === scenario.name)));

    return linkedTraceExists ? metricResult.data.result : undefined;
  });
}

// 验证 Loki 中可以使用同一个 Trace ID 找到带场景标签的日志。
async function verifyLogs(scenario, traceId) {
  return poll(async () => {
    const query = `{service_name=~"checkout-service|inventory-service"} |= "${traceId}"`;
    const url = new URL('http://localhost:3100/loki/api/v1/query_range');
    url.searchParams.set('query', query);
    url.searchParams.set('limit', '20');
    const response = await fetch(url);
    const result = await response.json();
    const streams = result.data?.result || [];

    return streams.some((stream) =>
      stream.stream?.demo_scenario === scenario.name &&
      stream.stream?.detected_level === scenario.logLevel) ? streams : undefined;
  });
}

// 顺序执行，避免并发请求覆盖 Prometheus Exemplar 的演示数据。
async function main() {
  for (const scenario of scenarios) {
    const traceId = await triggerScenario(scenario);
    await Promise.all([
      verifyTrace(scenario, traceId),
      verifyLogs(scenario, traceId),
      verifyMetrics(scenario),
    ]);
    console.log(`${scenario.name} 场景通过，Trace ID：${traceId}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
