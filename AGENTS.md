# Repository Guidelines

## Project Structure & Module Organization

Checkout and inventory services live in `app.js` and `inventory-service.js`; `start-services.js` runs both. `instrumentation.js` initializes OpenTelemetry first, and `telemetry-logger.js` centralizes correlated logs. RabbitMQ examples live in `messaging/`, checks in `scripts/`, and learning notes in `docs/`. Compose and backend configuration live in the root; Grafana assets are under `grafana/`.

## Build, Test, and Development Commands

- `npm install`: install the locked Node.js dependencies. Use Node.js 20 or newer.
- `npm run infra:up`: start all infrastructure, including RabbitMQ and its management UI.
- `npm start`: run checkout on port 3000 and inventory on port 3002.
- `npm run check`: perform JavaScript syntax checks.
- `npm run test:smoke`: verify traces, logs, baggage, exemplars, alerts, and health filtering.
- `npm run test:scenarios`: verify slow, MySQL-error, and Redis-error troubleshooting paths.
- `npm run test:sampling`: verify tail-sampling decisions and stable metric labels.
- `npm run test:rabbitmq`: verify one isolated publish, consume, and ACK cycle.
- `npm run rabbitmq:producer` / `npm run rabbitmq:consumer`: exercise the queue manually.
- `npm run traffic`: continuously generate demo traffic and print direct observability links.
- `docker compose config --quiet`: validate Compose configuration.
- `npm run infra:down`: stop the stack while retaining named-volume data.

## Coding Style & Naming Conventions

Use CommonJS, `'use strict'`, two-space indentation, semicolons, and trailing commas in multiline objects. Prefer `camelCase` for code and kebab-case for spans such as `query-inventory`. Keep telemetry attributes stable and namespaced (`demo.order.amount`) or aligned with OpenTelemetry conventions. Add concise Chinese comments for functions, variables, and non-obvious telemetry behavior. Match surrounding style and run `npm run check`.

## Testing Guidelines

There is no unit-test framework or coverage threshold. Every change must pass `npm run check`, `docker compose config --quiet`, and, when running, `npm run test:smoke`. Exercise relevant manual scenarios too. Put future unit tests in `test/` as `*.test.js`.

## Commit & Pull Request Guidelines

History uses short subjects such as `init` and concise Chinese descriptions. Keep commits focused and use an imperative summary. Pull requests should explain behavior and telemetry impact, list validation commands, link relevant issues, and include screenshots for dashboard changes. Do not commit secrets, generated telemetry data, or local volume contents.

## Security & Configuration

Default Grafana credentials and unauthenticated endpoints are for development only. Production deployments require authentication, TLS, durable storage, sampling, rate limits, and reviewed exporter endpoints.
