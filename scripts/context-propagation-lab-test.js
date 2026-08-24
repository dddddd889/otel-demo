'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const labEntry = path.join(projectRoot, 'labs/context-propagation/run-lab.js');

// 在独立进程中运行实验，避免全局 Context Manager 相互污染。
function runMode(mode) {
  return execFileSync(process.execPath, [labEntry, mode], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

// 将 CLI 的任务结果解析为便于断言的对象。
function parseTasks(output) {
  return [...output.matchAll(
    /^\[TASK\] mode=(\S+) expected=(\S+) actual=(\S+) isolated=(true|false)$/gm,
  )].map((match) => ({
    mode: match[1],
    expected: match[2],
    actual: match[3],
    isolated: match[4] === 'true',
  }));
}

// 解析子 Span 与当前任务 Span 的父子关系。
function parseRelations(output) {
  return [...output.matchAll(
    /^\[RELATION\] task=(\S+) active_matches=(true|false) same_trace=(true|false) parent_matches=(true|false)$/gm,
  )].map((match) => ({
    task: match[1],
    activeMatches: match[2] === 'true',
    sameTrace: match[3] === 'true',
    parentMatches: match[4] === 'true',
  }));
}

const globalTasks = parseTasks(runMode('global'));
assert.equal(globalTasks.length, 2);
assert.deepEqual(globalTasks.map(({ expected, actual, isolated }) => ({
  expected,
  actual,
  isolated,
})), [
  { expected: 'A', actual: 'B', isolated: false },
  { expected: 'B', actual: 'B', isolated: true },
]);

const alsTasks = parseTasks(runMode('als'));
assert.equal(alsTasks.length, 2);
assert.ok(alsTasks.every(({ expected, actual, isolated }) => (
  expected === actual && isolated
)));

const otelOutput = runMode('otel');
const otelTasks = parseTasks(otelOutput);
const otelRelations = parseRelations(otelOutput);
assert.equal(otelTasks.length, 2);
assert.ok(otelTasks.every(({ expected, actual, isolated }) => (
  expected === actual && isolated
)));
assert.deepEqual(otelRelations.map(({ task }) => task).sort(), ['A', 'B']);
assert.ok(otelRelations.every(({ activeMatches, sameTrace, parentMatches }) => (
  activeMatches && sameTrace && parentMatches
)));

console.log(
  'Context 传播实验测试通过：全局变量串线，ALS/OTel 隔离且 Span 父子关系正确',
);
