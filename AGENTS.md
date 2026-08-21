# Repository Guidelines

## Project Structure & Module Organization

This Node.js observability demo contains checkout and inventory services in `app.js` and `inventory-service.js`; `start-services.js` runs both. `instrumentation.js` initializes OpenTelemetry before application modules load, while `telemetry-logger.js` centralizes correlated logs. Infrastructure lives in `docker-compose.yaml`, with Collector, Prometheus, Loki, alerting, and Grafana configuration in top-level YAML files and `grafana/`. MySQL seed data is in `mysql/`, and end-to-end checks are in `scripts/`.

## Build, Test, and Development Commands

- `npm install`: install the locked Node.js dependencies. Use Node.js 20 or newer.
- `npm run infra:up`: start Jaeger, the Collector, Prometheus, Loki, and Grafana.
- `npm start`: run checkout on port 3000 and inventory on port 3002.
- `npm run check`: perform JavaScript syntax checks.
- `npm run test:smoke`: verify traces, logs, baggage, exemplars, alerts, and health filtering.
- `npm run test:scenarios`: verify slow, MySQL-error, and Redis-error troubleshooting paths.
- `npm run test:sampling`: verify tail-sampling decisions and stable metric labels.
- `npm run traffic`: continuously generate demo traffic and print direct observability links.
- `docker compose config --quiet`: validate Compose configuration.
- `npm run infra:down`: stop the stack while retaining named-volume data.

## Coding Style & Naming Conventions

Use CommonJS modules, `'use strict'`, two-space indentation, semicolons, and trailing commas in multiline objects. Prefer `camelCase` for variables and functions, descriptive names such as `checkoutFailureCounter`, and kebab-case for span names such as `query-inventory`. Keep telemetry attribute names stable and namespaced (`demo.order.amount`) or aligned with OpenTelemetry semantic conventions. Add concise Chinese comments for functions, methods, variables, and non-obvious telemetry behavior. No formatter or linter is configured, so match the surrounding style and run `npm run check`.

## Testing Guidelines

There is no unit-test framework or coverage threshold. Every change must pass `npm run check`, `docker compose config --quiet`, and—when the stack is running—`npm run test:smoke`. For behavior changes, also exercise `curl 'http://localhost:3000/checkout?fail=true'`. Put future unit tests in `test/` and name them `*.test.js`.

## Commit & Pull Request Guidelines

History uses short subjects such as `init` and concise Chinese descriptions. Keep commits focused and use an imperative summary. Pull requests should explain behavior and telemetry impact, list validation commands, link relevant issues, and include screenshots for dashboard changes. Do not commit secrets, generated telemetry data, or local volume contents.

## Security & Configuration

Default Grafana credentials and unauthenticated endpoints are for development only. Production deployments require authentication, TLS, durable storage, sampling, rate limits, and reviewed exporter endpoints.
