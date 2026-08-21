#!/usr/bin/env bash

set -u

# 持续制造请求，并把每条请求对应的查询入口打印出来。
while true; do
  request_url='http://localhost:3000/checkout'
  if ((RANDOM % 5 == 0)); then
    request_url='http://localhost:3000/checkout?fail=true'
  fi

  response_body="$(curl --silent --show-error "$request_url")"
  RESPONSE_BODY="$response_body" node -e '
    const response = JSON.parse(process.env.RESPONSE_BODY);
    const links = response.observability || {};
    console.log(`\n[${response.status || "failed"}] Trace ID: ${links.traceId || "missing"}`);
    console.log(`Jaeger Trace : ${links.jaeger || "missing"}`);
    console.log(`Grafana Logs : ${links.grafanaLogs || "missing"}`);
    console.log(`Prometheus   : ${links.prometheus || "missing"}`);
    console.log(`Dashboard    : ${links.grafanaDashboard || "missing"}`);
  '

  sleep 1
done
