# Repository Guidelines

## Project Structure & Module Organization

This is a compact Node.js observability demo. `app.js` contains the Express service and telemetry. `instrumentation.js` initializes OpenTelemetry before the application loads. Infrastructure is defined in `docker-compose.yaml`; component configuration lives in `otel-collector-config.yaml`, `prometheus.yaml`, and `loki-config.yaml`. Grafana provisioning and dashboards are under `grafana/provisioning/` and `grafana/dashboards/`.

## Build, Test, and Development Commands

- `npm install`: install the locked Node.js dependencies. Use Node.js 20 or newer.
- `npm run infra:up`: start Jaeger, the Collector, Prometheus, Loki, and Grafana.
- `npm start`: run the instrumented service on `http://localhost:3000`.
- `npm run check`: perform JavaScript syntax checks.
- `docker compose config --quiet`: validate Compose configuration.
- `npm run infra:status`: inspect local service health and state.
- `npm run infra:down`: stop the stack while retaining named-volume data.

Exercise both paths with `curl http://localhost:3000/checkout` and `curl 'http://localhost:3000/checkout?fail=true'`.

## Coding Style & Naming Conventions

Use CommonJS modules, `'use strict'`, two-space indentation, semicolons, and trailing commas in multiline objects. Prefer `camelCase` for variables and functions, descriptive names such as `checkoutFailureCounter`, and kebab-case for span names such as `query-inventory`. Keep telemetry attribute names stable and namespaced (`demo.order.amount`) or aligned with OpenTelemetry semantic conventions. Add concise Chinese comments for functions, methods, variables, and non-obvious telemetry behavior. No formatter or linter is configured, so match the surrounding style and run `npm run check`.

## Testing Guidelines

There is currently no automated test framework or coverage threshold. Every change must pass the syntax and Compose checks above. For behavior changes, manually verify successful and failed checkout responses, then confirm traces in Jaeger, metrics in Prometheus, and correlated logs in Grafana. If tests are introduced, place them in `test/` and name them `*.test.js`.

## Commit & Pull Request Guidelines

Git history is unavailable in this workspace, so no repository-specific convention can be inferred. Use short, imperative commit subjects, optionally following Conventional Commits (for example, `feat: add payment span`). Keep commits focused. Pull requests should explain the behavior and telemetry impact, list validation commands, link relevant issues, and include screenshots for dashboard or provisioning changes. Do not commit secrets, generated telemetry data, or local volume contents.

## Security & Configuration

Default Grafana credentials and unauthenticated endpoints are for development only. Production deployments require authentication, TLS, durable storage, sampling, rate limits, and reviewed exporter endpoints.
