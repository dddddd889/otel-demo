'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
const { context, createContextKey, trace } = require('@opentelemetry/api');
const {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} = require('@opentelemetry/sdk-trace-base');

const mode = process.argv[2];

// 用固定延迟制造可重复的并发交错。
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 格式化单个任务的上下文读取结果。
function printTaskResult(selectedMode, result) {
  console.log(
    `[TASK] mode=${selectedMode} expected=${result.expected} `
    + `actual=${result.actual} isolated=${result.expected === result.actual}`,
  );
}

// 演示进程级变量无法区分两个并发异步调用。
async function runGlobalMode() {
  let currentTaskId;

  async function runTask(taskId, milliseconds) {
    currentTaskId = taskId;
    await delay(milliseconds);
    return { expected: taskId, actual: currentTaskId };
  }

  const results = await Promise.all([
    runTask('A', 30),
    runTask('B', 10),
  ]);
  results.forEach((result) => printTaskResult('global', result));
}

// 演示 AsyncLocalStorage 为每条异步调用链保存独立 Store。
async function runAlsMode() {
  const storage = new AsyncLocalStorage();

  async function runTask(taskId, milliseconds) {
    return storage.run({ taskId }, async () => {
      await delay(milliseconds);
      return {
        expected: taskId,
        actual: storage.getStore()?.taskId,
      };
    });
  }

  try {
    const results = await Promise.all([
      runTask('A', 30),
      runTask('B', 10),
    ]);
    results.forEach((result) => printTaskResult('als', result));
  } finally {
    storage.disable();
  }
}

// 演示 OTel 把 Active Span 存入异步 Context，并自动继承为子 Span 的父级。
async function runOtelMode() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
  const tracer = trace.getTracer('context-propagation-lab');
  const taskContextKey = createContextKey('context-propagation-lab.task-id');

  async function runTask(taskId, milliseconds) {
    const taskContext = context.active().setValue(taskContextKey, taskId);
    return tracer.startActiveSpan(`task-${taskId.toLowerCase()}`, {
      attributes: { 'demo.task.id': taskId },
    }, taskContext, async (taskSpan) => {
      try {
        await delay(milliseconds);
        const activeSpan = trace.getActiveSpan();
        const childSpan = tracer.startSpan('task-child');
        childSpan.end();
        return {
          expected: taskId,
          actual: context.active().getValue(taskContextKey),
          activeMatches: activeSpan?.spanContext().spanId === taskSpan.spanContext().spanId,
          taskSpanId: taskSpan.spanContext().spanId,
          childSpanId: childSpan.spanContext().spanId,
        };
      } finally {
        taskSpan.end();
      }
    });
  }

  try {
    const results = await Promise.all([
      runTask('A', 30),
      runTask('B', 10),
    ]);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    results.forEach((result) => {
      printTaskResult('otel', result);
      const taskSpan = spans.find((span) => span.spanContext().spanId === result.taskSpanId);
      const childSpan = spans.find((span) => span.spanContext().spanId === result.childSpanId);
      console.log(
        `[RELATION] task=${result.expected} `
        + `active_matches=${result.activeMatches} `
        + `same_trace=${taskSpan.spanContext().traceId === childSpan.spanContext().traceId} `
        + `parent_matches=${childSpan.parentSpanContext?.spanId === result.taskSpanId}`,
      );
    });
  } finally {
    await provider.shutdown();
    contextManager.disable();
    context.disable();
    trace.disable();
  }
}

async function main() {
  if (mode === 'global') {
    await runGlobalMode();
    return;
  }
  if (mode === 'als') {
    await runAlsMode();
    return;
  }
  if (mode === 'otel') {
    await runOtelMode();
    return;
  }
  throw new Error(`未知实验模式：${mode || '<empty>'}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
