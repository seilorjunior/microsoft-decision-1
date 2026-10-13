import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, buildRequest, validateInput, readDecision, evaluate, TEAMS, LEVELS } from '../decision.js';
import { applyPolicy, summarizeEvaluation } from '../public/contract.js';
import { createInferenceQueue } from '../queue.js';
import { readConfig } from '../server.js';

const config = { endpoint: 'https://fixture.cognitiveservices.azure.com', deployment: 'decision-1' };
const payload = () => ({
  model: 'microsoft-decision-1',
  answers: {
    team: { type: 'choice', choice: 'billing', confidence: 0, probabilities: { billing: 1, technical: 0, account: 0 } },
    urgent: { type: 'noul', noul: 0 },
    severity: { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0 } },
  },
});
const success = (raw = payload(), headers = new Headers()) => ({ ok: true, headers, json: async () => raw });

test('accepts maximum ticket length and preserves exact default input shape', () => {
  assert.deepEqual(validateInput({ text: '  synthetic  ' }), {
    text: 'synthetic', reviewThreshold: 0.8, urgencyThreshold: 0.8, reverseOptions: false,
  });
  assert.equal(validateInput({ text: 'a'.repeat(12000) }).text.length, 12000);
  assert.throws(() => validateInput({ text: 'a'.repeat(12001) }), (error) => error.status === 400);
  assert.throws(() => validateInput({ text: '\n\t ' }), (error) => error.status === 400);
});

test('rejects nonfinite and nonnumeric thresholds for both policy fields', () => {
  for (const field of ['reviewThreshold', 'urgencyThreshold']) {
    for (const value of [Infinity, -Infinity, NaN, null, true, '1', [], {}]) {
      assert.throws(() => validateInput({ text: 'synthetic', [field]: value }), (error) => error instanceof AppError && error.status === 400);
    }
  }
});

test('request construction copies mutable criteria and does not mutate shared definitions', () => {
  const first = buildRequest('first', 'one', true);
  first.questions.team.criteria.billing = 'modified';
  first.questions.severity.criteria[0] = 'modified';
  const second = buildRequest('second', 'two');
  assert.equal(second.questions.team.criteria.billing, TEAMS.billing);
  assert.equal(second.questions.severity.criteria[0], LEVELS[0]);
  assert.deepEqual(Object.keys(second.questions.team.criteria), ['billing', 'technical', 'account']);
  assert.equal(second.model, 'second');
  assert.equal(second.state, 'two');
});

test('accepts zero and one probability boundaries and both severity endpoints', () => {
  const low = readDecision(payload());
  assert.equal(low.apiConfidence, 0);
  assert.equal(low.selectedProbability, 1);
  assert.equal(low.urgentProbability, 0);
  assert.equal(low.severityScore, 0);
  const high = payload();
  high.answers.urgent.noul = 1;
  high.answers.severity.score = 3;
  high.answers.severity.confidence = 0;
  high.answers.severity.probabilities = { 0: 0, 1: 0, 2: 0, 3: 1 };
  assert.equal(readDecision(high).severityScore, 3);
  assert.equal(readDecision(high).urgentProbability, 1);
});

test('enforces the documented probability-sum tolerance on both sides of one', () => {
  for (const sum of [0.971, 1.029]) {
    const raw = payload();
    raw.answers.team.probabilities = { billing: 0.5, technical: 0.25, account: sum - 0.75 };
    assert.doesNotThrow(() => readDecision(raw));
  }
  for (const sum of [0.969, 1.031]) {
    const raw = payload();
    raw.answers.team.probabilities = { billing: 0.5, technical: 0.25, account: sum - 0.75 };
    assert.throws(() => readDecision(raw), /sum approximately/);
  }
});

test('rejects extra probability keys, incorrect answer types, and nonnumeric severity', () => {
  for (const mutate of [
    (raw) => { raw.answers.team.probabilities.extra = 0; },
    (raw) => { raw.answers.severity.probabilities.extra = 0; },
    (raw) => { raw.answers.team.type = 'score'; },
    (raw) => { raw.answers.urgent.type = 'choice'; },
    (raw) => { raw.answers.severity.type = 'noul'; },
    (raw) => { raw.answers.severity.score = '2'; },
    (raw) => { raw.answers.team.confidence = Infinity; },
    (raw) => { raw.model = null; },
    (raw) => { raw.answers = []; },
  ]) {
    const raw = payload();
    mutate(raw);
    assert.throws(() => readDecision(raw), (error) => error instanceof AppError && error.status === 502);
  }
});

test('policy extremes preserve urgency precedence and routing equality', () => {
  const decision = readDecision(payload());
  assert.equal(applyPolicy(decision, 1, 1).action, 'Route to billing');
  assert.equal(applyPolicy(decision, 1, 0).action, 'Urgent human escalation');
  const uncertain = { ...decision, selectedProbability: 0, urgentProbability: 1 };
  const policy = applyPolicy(uncertain, 1, 1);
  assert.equal(policy.needsReview, true);
  assert.equal(policy.urgent, true);
  assert.equal(policy.action, 'Urgent human escalation');
});

test('empty evaluation reports all undefined metrics as null with zero support', () => {
  const result = summarizeEvaluation([], 0.8, 0.8);
  for (const key of ['accuracy', 'humanReviewRate', 'urgencyAccuracy', 'severityMeanAbsoluteError']) assert.equal(result[key], null);
  assert.equal(result.completed, 0);
  for (const team of Object.keys(TEAMS)) {
    assert.deepEqual(result.perTeam[team], { precision: null, recall: null, support: 0 });
    assert.deepEqual(result.confusion[team], { billing: 0, technical: 0, account: 0 });
  }
});

test('evaluation uses only labeled urgency/severity rows and preserves zero severity labels', () => {
  const decision = readDecision(payload());
  const rows = [
    { example: { expected: 'billing', urgent: false, severity: 0 }, decision: { ...decision, severityScore: 1 } },
    { example: { expected: 'billing' }, decision: { ...decision, urgentProbability: 1, severityScore: 3 } },
    { example: { expected: 'billing', urgent: 'false', severity: NaN }, decision },
  ];
  const result = summarizeEvaluation(rows, 0.8, 0.8);
  assert.equal(result.completed, 3);
  assert.equal(result.urgencyAccuracy, 1);
  assert.equal(result.severityMeanAbsoluteError, 1);
  assert.equal(result.perTeam.billing.support, 3);
});

test('evaluation counts human review only when urgency does not override it', () => {
  const decision = readDecision(payload());
  const rows = [
    { example: { expected: 'billing' }, decision: { ...decision, selectedProbability: 0.79 } },
    { example: { expected: 'billing' }, decision: { ...decision, selectedProbability: 0.79, urgentProbability: 0.8 } },
    { example: { expected: 'billing' }, decision: { ...decision, selectedProbability: 0.8 } },
  ];
  assert.equal(summarizeEvaluation(rows, 0.8, 0.8).humanReviewRate, 1 / 3);
});

test('invalid input and invalid access tokens never reach upstream inference', async () => {
  let tokenCalls = 0;
  let fetchCalls = 0;
  const fetchFixture = async () => { fetchCalls++; return success(); };
  await assert.rejects(evaluate({ text: '' }, config, async () => { tokenCalls++; return 'fixture'; }, fetchFixture));
  assert.equal(tokenCalls, 0);
  for (const token of [undefined, null, '', 123, {}]) {
    await assert.rejects(evaluate({ text: 'synthetic' }, config, async () => token, fetchFixture), (error) => error.status === 401);
  }
  assert.equal(fetchCalls, 0);
});

test('auth errors preserve the cause without exposing its message in the public error', async () => {
  const cause = new Error('private credential detail');
  await assert.rejects(evaluate({ text: 'synthetic' }, config, async () => { throw cause; }), (error) => {
    assert.equal(error.cause, cause);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(cause.message), false);
    return true;
  });
});

test('explicit cancellation returns 499 instead of treating it as an upstream timeout', async () => {
  const controller = new AbortController();
  await assert.rejects(evaluate({ text: 'synthetic' }, config, async () => 'fixture', async (url, options) => {
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new DOMException('cancelled', 'AbortError');
  }, controller.signal), (error) => error.status === 499 && /may still incur charges/.test(error.message));
});

test('network failures and standalone AbortErrors have distinct public status codes', async () => {
  for (const [cause, status, pattern] of [
    [new TypeError('private network detail'), 502, /Could not reach Foundry/],
    [new DOMException('aborted', 'AbortError'), 504, /60 seconds/],
    [new DOMException('timeout', 'TimeoutError'), 504, /60 seconds/],
  ]) {
    await assert.rejects(evaluate({ text: 'synthetic' }, config, async () => 'fixture', async () => { throw cause; }),
      (error) => error.status === status && pattern.test(error.message) && !error.message.includes('private network detail'));
  }
});

test('successful inference returns exactly the allowlisted numeric rate-limit metadata', async () => {
  const result = await evaluate({ text: 'synthetic' }, config, async () => 'fixture', async () => success(payload(), new Headers({
    'retry-after': '0',
    'x-ratelimit-limit-requests': '1',
    'x-ratelimit-remaining-requests': '-1',
    'x-ratelimit-reset-requests': '113',
    'x-ratelimit-renewalperiod-requests': '60',
    'x-secret': 'excluded',
  })));
  assert.deepEqual(result.throttling, {
    'retry-after': 0, 'x-ratelimit-limit-requests': 1, 'x-ratelimit-remaining-requests': -1,
    'x-ratelimit-reset-requests': 113, 'x-ratelimit-renewalperiod-requests': 60,
  });
  assert.equal(result.policy.action, 'Route to billing');
  assert.ok(result.timing.totalMs >= result.timing.inferenceHttpMs);
});

test('ignores malformed rate-limit header values rather than coercing them', async () => {
  for (const value of ['1.5', 'tomorrow', '1000000000', '+1', '1e2']) {
    const result = await evaluate({ text: 'synthetic' }, config, async () => 'fixture', async () => success(payload(), new Headers({ 'retry-after': value })));
    assert.deepEqual(result.throttling, {});
  }
});

test('upstream errors are not retried and error responses are not parsed as decisions', async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    let calls = 0;
    await assert.rejects(evaluate({ text: 'synthetic' }, config, async () => 'fixture', async () => {
      calls++;
      return { ok: false, status, json: () => { throw new Error('Must not parse error body'); } };
    }), (error) => error.status === (status === 429 ? 429 : 502) && error.message.includes(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
});

test('configuration accepts documented port/interval endpoints and rejects unsupported URL components', () => {
  for (const port of ['1', '65535']) {
    for (const interval of ['0', '120000']) {
      const result = readConfig({ AZURE_ENDPOINT: 'https://fixture.services.ai.azure.com/', DEPLOYMENT_NAME: 'decision-1', PORT: port, REQUEST_INTERVAL_MS: interval });
      assert.equal(result.port, Number(port));
      assert.equal(result.requestIntervalMs, Number(interval));
      assert.equal(result.endpoint, 'https://fixture.services.ai.azure.com');
    }
  }
  for (const endpoint of ['https://user:password@fixture.cognitiveservices.azure.com', 'https://fixture.cognitiveservices.azure.com:8443', 'https://fixture.cognitiveservices.azure.com/#fragment']) {
    assert.throws(() => readConfig({ AZURE_ENDPOINT: endpoint, DEPLOYMENT_NAME: 'decision-1' }));
  }
  for (const value of ['1.5', 'NaN', 'Infinity', '65536']) assert.throws(() => readConfig({ AZURE_ENDPOINT: config.endpoint, DEPLOYMENT_NAME: config.deployment, PORT: value }));
});

test('pre-aborted and synchronously cancelled queue entries never execute', async () => {
  const queue = createInferenceQueue(0);
  let calls = 0;
  const firstController = new AbortController();
  firstController.abort(new Error('already cancelled'));
  await assert.rejects(queue.run(() => { calls++; }, firstController.signal), /already cancelled/);
  const controller = new AbortController();
  const result = queue.run(() => { calls++; }, controller.signal);
  controller.abort(new Error('cancel before microtask'));
  await assert.rejects(result, /cancel before microtask/);
  await new Promise(setImmediate);
  assert.equal(calls, 0);
  assert.equal(queue.status().active, false);
  queue.stop();
});

test('queue recovers from rejected work and maintains FIFO order', async () => {
  const queue = createInferenceQueue(0);
  const order = [];
  const first = queue.run(() => { order.push(1); throw new Error('fixture failure'); });
  const second = queue.run(() => { order.push(2); return 'second'; });
  const third = queue.run(() => { order.push(3); return 'third'; });
  await assert.rejects(first, /fixture failure/);
  assert.equal(await second, 'second');
  assert.equal(await third, 'third');
  await new Promise(setImmediate);
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(queue.status(), { active: false, pending: 0, nextStartInMs: 0, intervalMs: 0, limit: 2 });
  queue.stop();
});

test('queue shutdown rejects waiting work without interrupting already-running work', async () => {
  const queue = createInferenceQueue(0);
  let finish;
  const active = queue.run(() => new Promise((resolve) => { finish = resolve; }));
  await new Promise(setImmediate);
  let called = false;
  const pending = queue.run(() => { called = true; });
  const rejected = assert.rejects(pending, (error) => error.status === 503 && /shutting down/.test(error.message));
  queue.stop();
  queue.stop();
  await rejected;
  finish('completed');
  assert.equal(await active, 'completed');
  await new Promise(setImmediate);
  assert.equal(called, false);
  assert.equal(queue.status().pending, 0);
});
