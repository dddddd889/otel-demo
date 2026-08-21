#!/usr/bin/env bash

set -euo pipefail

# 等待指定 HTTP 地址返回成功。
wait_for_url() {
  local url="$1"
  local attempts="${2:-30}"

  for ((index = 1; index <= attempts; index += 1)); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "等待服务超时：$url" >&2
  return 1
}

wait_for_url 'http://localhost:3000/health'
wait_for_url 'http://localhost:3002/health'
wait_for_url 'http://localhost:3100/ready'

# 触发一条必定被尾采样保留的慢链路，并从响应头提取 Trace ID。
response_headers="$(mktemp)"
trap 'rm -f "$response_headers"' EXIT
curl --silent --show-error --dump-header "$response_headers" \
  'http://localhost:3000/checkout?slow=true' >/dev/null
trace_id="$(awk 'BEGIN { IGNORECASE=1 } /^X-Trace-Id:/ { gsub("\\r", "", $2); print $2 }' "$response_headers")"
export TRACE_ID="$trace_id"

if [[ ! "$trace_id" =~ ^[a-f0-9]{32}$ ]]; then
  echo "响应中没有有效的 X-Trace-Id：$trace_id" >&2
  exit 1
fi

# 等待 Collector 与 Jaeger 的批处理完成，最多等待 30 秒。
jaeger_result=''
for ((index = 1; index <= 30; index += 1)); do
  jaeger_result="$(curl --silent --show-error "http://localhost:16686/api/traces/$trace_id")"
  if node -e '
    const trace = JSON.parse(process.argv[1]).data?.[0];
    const services = new Set(Object.values(trace?.processes || {}).map((item) => item.serviceName));
    const operations = new Set((trace?.spans || []).map((span) => span.operationName));
    process.exit(
      services.has("checkout-service") && services.has("inventory-service") &&
      operations.has("SELECT") && operations.has("redis-GET") ? 0 : 1
    );
  ' "$jaeger_result"; then
    break
  fi
  sleep 1
done

# 独立轮询 Loki，避免 Trace 已入库而日志批次仍在传输时误报。
loki_result=''
for ((index = 1; index <= 30; index += 1)); do
  loki_result="$(curl --silent --show-error --get 'http://localhost:3100/loki/api/v1/query_range' \
    --data-urlencode "query={service_name=~\"checkout-service|inventory-service\"} |= \"$trace_id\"" \
    --data-urlencode 'limit=20')"
  if node -e '
    const streams = JSON.parse(process.argv[1]).data?.result || [];
    const services = new Set(streams.map((item) => item.stream?.service_name));
    process.exit(services.has("checkout-service") && services.has("inventory-service") ? 0 : 1);
  ' "$loki_result"; then
    break
  fi
  sleep 1
done

# 验证 Prometheus Exemplar、告警规则与 Grafana 托管告警均已装载。
end_time="$(date +%s)"
start_time="$((end_time - 300))"
exemplar_result=''
for ((index = 1; index <= 30; index += 1)); do
  end_time="$(date +%s)"
  exemplar_result="$(curl --silent --show-error --get 'http://localhost:9090/api/v1/query_exemplars' \
    --data-urlencode 'query=checkout_request_duration_seconds_bucket' \
    --data-urlencode "start=$start_time" \
    --data-urlencode "end=$end_time")"
  if node -e '
    const traceIds = (JSON.parse(process.argv[1]).data || []).flatMap((series) =>
      (series.exemplars || []).map((item) => item.labels?.trace_id),
    );
    process.exit(traceIds.some((traceId) => Boolean(traceId) && /^[a-f0-9]{32}$/.test(traceId)) ? 0 : 1);
  ' "$exemplar_result"; then
    break
  fi
  sleep 1
done
prometheus_rules="$(curl --silent --show-error 'http://localhost:9090/api/v1/rules')"
grafana_rules="$(curl --silent --show-error --user admin:admin \
  'http://localhost:3001/api/v1/provisioning/alert-rules')"

# /health Trace 应由 Collector 的尾采样策略整条丢弃。
health_headers="$response_headers"
curl --silent --show-error --dump-header "$health_headers" http://localhost:3000/health >/dev/null
health_trace_id="$(awk 'BEGIN { IGNORECASE=1 } /^X-Trace-Id:/ { gsub("\\r", "", $2); print $2 }' "$health_headers")"
health_trace_result='{"data":[]}'
for ((index = 1; index <= 10; index += 1)); do
  health_trace_result="$(curl --silent --show-error "http://localhost:16686/api/traces/$health_trace_id")"
  if node -e 'process.exit(JSON.parse(process.argv[1]).data?.length ? 0 : 1)' "$health_trace_result"; then
    break
  fi
  sleep 1
done

node -e '
  const [jaegerText, lokiText, exemplarText, rulesText, grafanaText, healthText] = process.argv.slice(1);
  const jaeger = JSON.parse(jaegerText);
  const loki = JSON.parse(lokiText);
  const exemplars = JSON.parse(exemplarText);
  const rules = JSON.parse(rulesText);
  const grafanaRules = JSON.parse(grafanaText);
  const healthTrace = JSON.parse(healthText);
  const trace = jaeger.data?.[0];
  const services = new Set(
    Object.values(trace?.processes || {}).map((process) => process.serviceName),
  );
  const operations = new Set((trace?.spans || []).map((span) => span.operationName));
  const logStreams = loki.data?.result || [];

  if (!services.has("checkout-service") || !services.has("inventory-service")) {
    throw new Error(`跨服务 Trace 不完整：${[...services].join(", ")}`);
  }
  if (!operations.has("SELECT") || !operations.has("redis-GET")) {
    throw new Error(`数据库 Span 不完整：${[...operations].join(", ")}`);
  }
  if (logStreams.length < 2) {
    throw new Error("Loki 中缺少两服务关联日志");
  }
  const inventoryLogs = logStreams.filter((item) => item.stream?.service_name === "inventory-service");
  if (!inventoryLogs.some((item) => item.stream?.demo_tenant_id === "demo-shop")) {
    throw new Error("库存日志中缺少跨服务 Baggage");
  }
  const exemplarTraceIds = (exemplars.data || []).flatMap((series) =>
    (series.exemplars || []).map((item) => item.labels?.trace_id),
  );
  if (!exemplarTraceIds.some((traceId) => /^[a-f0-9]{32}$/.test(traceId || ""))) {
    throw new Error("Prometheus 中缺少有效的 Trace Exemplar");
  }
  const ruleNames = new Set((rules.data?.groups || []).flatMap((group) =>
    (group.rules || []).map((rule) => rule.name),
  ));
  if (!ruleNames.has("CheckoutFailuresDetected") || !ruleNames.has("CheckoutP95LatencyHigh")) {
    throw new Error("Prometheus 告警规则未完整加载");
  }
  if (!grafanaRules.some((rule) => rule.uid === "checkout-failures")) {
    throw new Error("Grafana 托管告警未加载");
  }
  if (healthTrace.data?.length) {
    throw new Error("/health Trace 未被尾采样策略过滤");
  }
' "$jaeger_result" "$loki_result" "$exemplar_result" "$prometheus_rules" \
  "$grafana_rules" "$health_trace_result"

echo "冒烟测试通过，Trace ID：$trace_id"
