'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const labDirectory = path.join(repositoryRoot, 'labs', 'auto-instrumentation');
const runLabPath = path.join(labDirectory, 'run-lab.js');
const officialInstrumentationPath = path.join(labDirectory, 'official-instrumentation.js');

// 在独立 Node 进程中运行实验，防止全局 Provider 和 module patch 相互污染。
function runMode(mode) {
  const nodeArguments = mode === 'official'
    ? ['--require', officialInstrumentationPath, runLabPath, mode]
    : [runLabPath, mode];
  return execFileSync(process.execPath, nodeArguments, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

// 从下游回显中解析 W3C traceparent 的 Trace ID 与父 Span ID。
function parseTraceparent(output) {
  const match = output.match(/downstream_traceparent=00-([a-f0-9]{32})-([a-f0-9]{16})-01/);
  assert.ok(match, '输出缺少合法 traceparent');
  return { traceId: match[1], parentSpanId: match[2] };
}

// 按 SpanKind 解析一行学习 Exporter 输出。
function parseSpan(output, spanKind) {
  const pattern = new RegExp(
    `\\[SPAN\\] name=(.+?) kind=${spanKind}` +
    ' trace_id=([a-f0-9]{32}) span_id=([a-f0-9]{16})' +
    ' parent_span_id=([a-f0-9]{16}|无) status=(OK|ERROR)',
  );
  const match = output.match(pattern);
  assert.ok(match, `输出缺少 ${spanKind} Span`);
  return {
    name: match[1],
    traceId: match[2],
    spanId: match[3],
    parentSpanId: match[4],
    status: match[5],
  };
}

// baseline 不应注入 Header，也不应产生任何 Span。
const baselineOutput = runMode('baseline');
assert.match(baselineOutput, /mode=baseline downstream_traceparent=无/);
assert.doesNotMatch(baselineOutput, /\[SPAN\]/);

// 手写 patch 应注入 W3C Header，并产生一个 CLIENT Span。
const manualOutput = runMode('manual');
const manualTraceparent = parseTraceparent(manualOutput);
const manualClientSpan = parseSpan(manualOutput, 'CLIENT');
assert.equal(manualClientSpan.name, 'manual-http-get');
assert.equal(manualTraceparent.traceId, manualClientSpan.traceId);
assert.equal(manualTraceparent.parentSpanId, manualClientSpan.spanId);

// 官方 instrumentation 应同时捕获客户端与服务端 HTTP Span。
const officialOutput = runMode('official');
const officialTraceparent = parseTraceparent(officialOutput);
const officialClientSpan = parseSpan(officialOutput, 'CLIENT');
const officialServerSpan = parseSpan(officialOutput, 'SERVER');
assert.equal(officialTraceparent.traceId, officialClientSpan.traceId);
assert.equal(officialTraceparent.parentSpanId, officialClientSpan.spanId);
assert.equal(officialServerSpan.traceId, officialClientSpan.traceId);
assert.equal(officialServerSpan.parentSpanId, officialClientSpan.spanId);

console.log('自动插桩实验通过：baseline 无 Span，手写 patch 产生 CLIENT，官方插桩产生 CLIENT + SERVER。');
