import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogin, runSmokeTest, waitForHealth } from '../scripts/smoke.js';
import { evaluateQuota, requestedCapacity } from '../scripts/check-quota.js';

const cookie = `__Host-decision-session=${'a'.repeat(64)}`;
const decisionResult = {
  decision: { team: 'billing', selectedProbability: 0.9, urgentProbability: 0.1, severityScore: 1.2 },
  policy: { action: 'Route to team' },
  timing: { totalMs: 900, inferenceHttpMs: 700, queueWaitMs: 0 },
};

function fakeFetch({ loginStatus = 303, decideStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) return { ok: true, status: 200 };
    if (url.endsWith('/auth/login')) return { ok: loginStatus === 303, status: loginStatus, headers: { getSetCookie: () => [`${cookie}; Path=/; HttpOnly`] } };
    return { ok: decideStatus === 200, status: decideStatus, json: async () => (decideStatus === 200 ? decisionResult : { error: 'Quota reached.' }) };
  };
  return { impl, calls };
}

test('smoke test signs in with the private login and reports one inference result', async () => {
  const { impl, calls } = fakeFetch();
  const result = await runSmokeTest({ endpoint: 'https://app.azurewebsites.net/', loginText: 'Username: lab\nPassword: secret-value\n', fetchImpl: impl });
  assert.equal(result.team, 'billing');
  assert.equal(result.tokenAndOverheadMs, 200);
  assert.equal(calls.filter((call) => call.url.endsWith('/api/decide')).length, 1);
  assert.equal(calls.find((call) => call.url.endsWith('/api/decide')).options.headers.Cookie, cookie);
});

test('smoke test fails clearly for rejected logins, inference errors, and malformed login files', async () => {
  const loginText = 'Username: lab\nPassword: secret-value\n';
  await assert.rejects(runSmokeTest({ endpoint: 'https://app.azurewebsites.net', loginText, fetchImpl: fakeFetch({ loginStatus: 401 }).impl }), /Login returned HTTP 401/);
  await assert.rejects(runSmokeTest({ endpoint: 'https://app.azurewebsites.net', loginText, fetchImpl: fakeFetch({ decideStatus: 429 }).impl }), /HTTP 429: Quota reached/);
  assert.throws(() => parseLogin('Username: lab\n'), /Password/);
});

test('smoke test waits for a starting app to become healthy and stops after a bounded number of checks', async () => {
  const statuses = [503, 503, 200];
  const sleeps = [];
  const fetchImpl = async () => ({ ok: statuses[0] === 200, status: statuses.shift() });
  await waitForHealth('https://app.azurewebsites.net', { fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, delayMs: 5 });
  assert.deepEqual(sleeps, [5, 5]);
  await assert.rejects(waitForHealth('https://app.azurewebsites.net', { fetchImpl: async () => ({ ok: false, status: 503 }), sleep: async () => {}, attempts: 3 }), /not become healthy after 3 checks \(last result: HTTP 503\)/);
});

test('quota check compares available Decision-1 quota with the Bicep default capacity', () => {
  assert.equal(requestedCapacity('@minValue(1)\nparam modelCapacity int = 60\n'), 60);
  const usage = (currentValue) => [{ name: { value: 'AIServices.DataZoneStandard.Microsoft-Decision-1' }, currentValue, limit: 60 }];
  assert.equal(evaluateQuota(usage(0), 60).ok, true);
  assert.equal(evaluateQuota(usage(60), 60).ok, false);
  assert.equal(evaluateQuota([], 60).ok, false);
});
