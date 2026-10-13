import test from 'node:test';
import assert from 'node:assert/strict';
import { createInferenceQueue } from '../queue.js';
import { summarizeEvaluation } from '../public/contract.js';
import { EVALUATION_SET } from '../public/dataset.js';
import { evaluate } from '../decision.js';
import { createApp } from '../server.js';

test('serializes concurrent requests and enforces exact interval boundaries', async () => {
  let time = 0;
  let nextTimer;
  const queue = createInferenceQueue(61000, { now: () => time, setTimer: (fn) => { nextTimer = fn; return 1; }, clearTimer: () => {} });
  const starts = [];
  const first = queue.run(async () => { starts.push(time); return 'first'; });
  const second = queue.run(async () => { starts.push(time); return 'second'; });
  assert.equal(await first, 'first');
  await new Promise(setImmediate);
  time = 60999;
  nextTimer();
  assert.deepEqual(starts, [0]);
  time = 61000;
  nextTimer();
  assert.equal(await second, 'second');
  assert.deepEqual(starts, [0, 61000]);
  queue.stop();
});

test('bounds queued requests, removes cancelled work, and propagates active cancellation', async () => {
  const queue = createInferenceQueue(0, { limit: 1 });
  const activeController = new AbortController();
  const active = queue.run((signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), activeController.signal);
  await new Promise(setImmediate);
  const pendingController = new AbortController();
  let called = false;
  const waiting = queue.run(() => { called = true; }, pendingController.signal);
  await assert.rejects(queue.run(() => {}), /queue is full/);
  const cancelled = assert.rejects(waiting, /cancelled/);
  pendingController.abort(new Error('cancelled'));
  await cancelled;
  assert.equal(queue.status().pending, 0);
  const activeCancelled = assert.rejects(active, /active cancelled/);
  activeController.abort(new Error('active cancelled'));
  await activeCancelled;
  assert.equal(called, false);
  queue.stop();
  await assert.rejects(queue.run(() => {}), /shutting down/);
});

test('upstream cooldown delays later work without retrying or shortening the interval', async () => {
  let time = 0;
  let nextTimer;
  const queue = createInferenceQueue(61000, { now: () => time, setTimer: (fn) => { nextTimer = fn; return 1; }, clearTimer: () => {} });
  await queue.run(() => 'first');
  await new Promise(setImmediate);
  queue.defer(120000);
  const starts = [];
  const second = queue.run(() => starts.push(time));
  time = 119999;
  nextTimer();
  assert.deepEqual(starts, []);
  time = 120000;
  nextTimer();
  await second;
  assert.deepEqual(starts, [120000]);
  queue.stop();
});

test('evaluation reports per-team precision/recall, review rate, urgency and severity metrics', () => {
  const rows = [
    { example: { expected: 'billing', urgent: false, severity: 0 }, decision: { team: 'billing', selectedProbability: 0.9, urgentProbability: 0, severityScore: 0.5 } },
    { example: { expected: 'technical', urgent: true, severity: 3 }, decision: { team: 'billing', selectedProbability: 0.5, urgentProbability: 1, severityScore: 2 } },
    { example: { expected: 'account', urgent: false, severity: 2 }, decision: { team: 'account', selectedProbability: 0.5, urgentProbability: 0, severityScore: 2 } },
  ];
  const summary = summarizeEvaluation(rows, 0.8, 0.8);
  assert.equal(summary.accuracy, 2 / 3);
  assert.equal(summary.humanReviewRate, 1 / 3);
  assert.equal(summary.urgencyAccuracy, 1);
  assert.equal(summary.severityMeanAbsoluteError, 0.5);
  assert.deepEqual(summary.perTeam.billing, { precision: 0.5, recall: 1, support: 1 });
  assert.equal(summary.perTeam.technical.precision, null);
  assert.equal(summary.confusion.technical.billing, 1);
  assert.equal(summarizeEvaluation([], 0.8, 0.8).accuracy, null);
  assert.equal(EVALUATION_SET.length, 18);
  for (const team of ['billing', 'technical', 'account']) assert.equal(EVALUATION_SET.filter((row) => row.expected === team).length, 6);
});

test('health endpoint is public, minimal, and does not evaluate a ticket', async (t) => {
  const config = { port: 0, auth: { username: 'test', passwordHash: '0'.repeat(64) } };
  const app = createApp(config, () => { throw new Error('Unexpected inference'); });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  config.port = app.address().port;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${config.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
  assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  const status = await fetch(`http://127.0.0.1:${config.port}/api/queue`);
  assert.equal(status.status, 401);
  await status.text();
});

test('preserves numeric throttling metadata without exposing arbitrary upstream headers', async () => {
  await assert.rejects(evaluate({ text: 'synthetic' }, {
    endpoint: 'https://example.cognitiveservices.azure.com', deployment: 'decision-1',
  }, async () => 'fixture', async () => ({
    ok: false, status: 429, headers: new Headers({ 'retry-after': '60', 'x-ratelimit-limit-requests': '1', 'x-secret': 'not-for-browser' }),
  })), (error) => {
    assert.deepEqual(error.throttling, { 'retry-after': 60, 'x-ratelimit-limit-requests': 1 });
    return error.status === 429;
  });
});
