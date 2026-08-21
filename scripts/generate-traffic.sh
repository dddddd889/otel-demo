#!/usr/bin/env bash

set -u

# 场景列表：轮流制造正常、慢请求和三类错误。
scenario_urls=(
  'http://localhost:3000/checkout'
  'http://localhost:3000/checkout?slow=true'
  'http://localhost:3000/checkout?dbError=true'
  'http://localhost:3000/checkout?redisError=true'
  'http://localhost:3000/checkout?fail=true'
)
scenario_index=0

# 持续制造请求，并把每条请求对应的查询入口打印出来。
while true; do
  request_url="${scenario_urls[$scenario_index]}"
  scenario_index="$(((scenario_index + 1) % ${#scenario_urls[@]}))"

  response_body="$(curl --silent --show-error "$request_url")"
  RESPONSE_BODY="$response_body" node -e '
    const response = JSON.parse(process.env.RESPONSE_BODY);
    const links = response.observability || {};
    console.log(`\n[${response.scenario || "unknown"}] Trace ID: ${links.traceId || "missing"}`);
    console.log(`Jaeger Trace : ${links.jaeger || "missing"}`);
    console.log(`Grafana Logs : ${links.grafanaLogs || "missing"}`);
    console.log(`Prometheus   : ${links.prometheus || "missing"}`);
    console.log(`Dashboard    : ${links.grafanaDashboard || "missing"}`);
  '

  sleep 1
done
