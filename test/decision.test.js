import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { buildRequest, validateInput, readDecision, applyPolicy, evaluate } from '../decision.js';
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity';
import { createApp, createCredential, readConfig, SESSION_TTL_MS } from '../server.js';

const authUsername = 'test-user';
const authPassword = 'test-only-random-password-not-a-real-secret';
const auth = { username: authUsername, passwordHash: createHash('sha256').update(authPassword).digest('hex') };
const loginBody = () => new URLSearchParams({ username: authUsername, password: authPassword });

const payload = () => ({
  model: 'microsoft-decision-1',
  answers: {
    team: { type: 'choice', choice: 'technical', confidence: 0.88, probabilities: { billing: 0.1, technical: 0.8, account: 0.1 } },
    urgent: { type: 'noul', noul: 0.7 },
    severity: { type: 'score', score: 2.3, confidence: 0.8, probabilities: { 0: 0, 1: 0.1, 2: 0.5, 3: 0.4 } },
  },
  usage: { input_tokens: 174, output_tokens: 3 },
});

test('builds bounded questions and reverses only the choice order', () => {
  const normal = buildRequest('decision-1', 'example');
  const reversed = buildRequest('decision-1', 'example', true);
  assert.equal(normal.questions.team.type, 'choice');
  assert.equal(normal.questions.urgent.type, 'noul');
  assert.equal(normal.questions.severity.type, 'score');
  assert.deepEqual(Object.keys(reversed.questions.team.criteria), ['account', 'technical', 'billing']);
  assert.deepEqual(normal.questions.severity, reversed.questions.severity);
  assert.equal(reversed.state, normal.state);
});

test('validates input and threshold boundaries without coercion', () => {
  assert.equal(validateInput({ text: ' hi ', reviewThreshold: 0, urgencyThreshold: 1 }).text, 'hi');
  for (const input of [
    null, [], { text: '' }, { text: 'a'.repeat(12001) },
    { text: 'hi', reviewThreshold: '0.8' }, { text: 'hi', urgencyThreshold: NaN },
    { text: 'hi', reviewThreshold: -0.1 }, { text: 'hi', urgencyThreshold: 1.1 },
    { text: 'hi', reverseOptions: 'true' },
  ]) assert.throws(() => validateInput(input));
});

test('parses all three answers and distinguishes API confidence from selected probability', () => {
  const result = readDecision(payload());
  assert.equal(result.selectedProbability, 0.8);
  assert.equal(result.apiConfidence, 0.88);
  assert.equal(result.urgentProbability, 0.7);
  assert.equal(result.severityScore, 2.3);
});

test('fails explicitly for missing, unsupported, or malformed model answers', () => {
  assert.throws(() => readDecision({}));
  for (const mutate of [
    (p) => { p.answers.team.choice = '__proto__'; },
    (p) => { p.answers.team.probabilities.technical = NaN; },
    (p) => { p.answers.team.probabilities.account = 0.9; },
    (p) => { delete p.answers.urgent; },
    (p) => { p.answers.urgent.noul = 1.1; },
    (p) => { p.answers.severity.score = 4; },
    (p) => { delete p.answers.severity.probabilities['0']; },
    (p) => { p.answers.severity.confidence = null; },
  ]) {
    const p = payload();
    mutate(p);
    assert.throws(() => readDecision(p));
  }
});

test('routing equality passes, escalation equality passes, and urgency overrides routing', () => {
  const decision = readDecision(payload());
  assert.equal(applyPolicy(decision, 0.8, 0.8).action, 'Route to technical');
  assert.equal(applyPolicy(decision, 0.81, 0.8).action, 'Human review');
  assert.equal(applyPolicy(decision, 0.81, 0.7).action, 'Urgent human escalation');
});

test('calls the decision endpoint with server-side credentials and preserves raw output', async () => {
  const config = { endpoint: 'https://example.cognitiveservices.azure.com', deployment: 'decision-1' };
  const raw = payload();
  const result = await evaluate({ text: 'test' }, config, async () => 'test-token', async (url, options) => {
    assert.equal(url, `${config.endpoint}/providers/microsoft/v1/systemone`);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(JSON.parse(options.body).model, 'decision-1');
    return { ok: true, json: async () => raw };
  });
  assert.deepEqual(result.response, raw);
  assert.ok(result.timing.inferenceHttpMs >= 0);
  assert.equal(JSON.stringify(result).includes('test-token'), false);
});

test('reports upstream, timeout, JSON and auth errors without success-shaped fallbacks', async () => {
  const config = { endpoint: 'https://example.cognitiveservices.azure.com', deployment: 'decision-1' };
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(evaluate({ text: 'test' }, config, async () => 'token', async () => ({ ok: false, status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(evaluate({ text: 'test' }, config, async () => { throw new Error('secret'); }), /authentication failed/);
  await assert.rejects(evaluate({ text: 'test' }, config, async () => 'token', async () => { throw new DOMException('timeout', 'TimeoutError'); }), /60 seconds/);
  await assert.rejects(evaluate({ text: 'test' }, config, async () => 'token', async () => ({ ok: true, json: async () => { throw new SyntaxError(); } })), /invalid JSON/);
});

test('validates resource root configuration', () => {
  const config = readConfig({ AZURE_ENDPOINT: 'https://example.cognitiveservices.azure.com/', DEPLOYMENT_NAME: 'decision-1' });
  assert.equal(config.port, 3000);
  assert.equal(config.requestIntervalMs, 2000);
  for (const endpoint of ['http://example.cognitiveservices.azure.com', 'https://example.com', 'https://x.cognitiveservices.azure.com/other', 'https://x.cognitiveservices.azure.com/?key=secret']) {
    assert.throws(() => readConfig({ AZURE_ENDPOINT: endpoint, DEPLOYMENT_NAME: 'decision-1' }));
  }
  assert.throws(() => readConfig({ AZURE_ENDPOINT: 'https://x.cognitiveservices.azure.com', DEPLOYMENT_NAME: 'decision-1', PORT: '0' }));
  assert.throws(() => readConfig({ AZURE_ENDPOINT: 'https://x.cognitiveservices.azure.com', DEPLOYMENT_NAME: 'decision-1', REQUEST_INTERVAL_MS: '-1' }));
});

test('uses managed identity and strict HTTPS origin only when hosted on App Service', () => {
  const env = {
    AZURE_ENDPOINT: 'https://example.cognitiveservices.azure.com',
    DEPLOYMENT_NAME: 'decision-1',
    WEBSITE_HOSTNAME: 'app-decision-example.azurewebsites.net',
    APP_AUTH_USERNAME: authUsername,
    APP_AUTH_PASSWORD_HASH: auth.passwordHash,
  };
  const hosted = readConfig(env);
  assert.equal(hosted.hosted, true);
  assert.equal(hosted.publicOrigin, 'https://app-decision-example.azurewebsites.net');
  assert.ok(createCredential(hosted, env) instanceof ManagedIdentityCredential);
  const local = readConfig({ ...env, WEBSITE_HOSTNAME: undefined });
  assert.equal(local.hosted, false);
  assert.ok(createCredential(local, env) instanceof AzureCliCredential);
  for (const hostname of ['evil.example', 'user@app.azurewebsites.net', 'app.azurewebsites.net/path', 'app.azurewebsites.net:443']) {
    assert.throws(() => readConfig({ ...env, WEBSITE_HOSTNAME: hostname }));
  }
});

test('fails closed for missing or malformed hosted credentials and partial local configuration', () => {
  const env = {
    AZURE_ENDPOINT: 'https://example.cognitiveservices.azure.com',
    DEPLOYMENT_NAME: 'decision-1',
    WEBSITE_HOSTNAME: 'app-decision-example.azurewebsites.net',
  };
  assert.throws(() => readConfig(env), /setup-auth/);
  assert.throws(() => createApp({ hosted: true }, async () => ({})), /requires authentication/);
  for (const credentials of [
    { APP_AUTH_USERNAME: authUsername },
    { APP_AUTH_PASSWORD_HASH: auth.passwordHash },
    { APP_AUTH_USERNAME: 'invalid:user', APP_AUTH_PASSWORD_HASH: auth.passwordHash },
    { APP_AUTH_USERNAME: authUsername, APP_AUTH_PASSWORD_HASH: 'not-a-hash' },
  ]) {
    assert.throws(() => readConfig({ ...env, ...credentials }), /setup-auth/);
    assert.throws(() => readConfig({ ...env, WEBSITE_HOSTNAME: undefined, ...credentials }), /setup-auth/);
  }
  const local = readConfig({ ...env, WEBSITE_HOSTNAME: undefined });
  assert.equal(local.auth, undefined);
});

test('protects all app routes and never invokes inference before successful authentication', async (t) => {
  const config = { endpoint: 'https://example.cognitiveservices.azure.com', deployment: 'decision-1', port: 0, auth };
  let evaluations = 0;
  const app = createApp(config, async () => { evaluations++; return { success: true }; });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  config.port = app.address().port;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const url = `http://127.0.0.1:${config.port}`;
  const landing = await fetch(url, { redirect: 'manual' });
  assert.equal(landing.status, 303);
  assert.equal(landing.headers.get('location'), '/login');
  assert.equal(landing.headers.get('www-authenticate'), null);
  const page = await fetch(`${url}/login`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.match(await page.text(), /autocomplete="current-password"/);
  for (const path of ['/style.css', '/login.js']) {
    const asset = await fetch(`${url}${path}`);
    assert.equal(asset.status, 200);
    await asset.text();
  }
  for (const path of ['/app.js', '/api/config', '/api/decide']) {
    const options = path === '/api/decide' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {};
    const response = await fetch(`${url}${path}`, options);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), null);
    assert.equal((await response.json()).code, 'AUTH_REQUIRED');
  }
  for (const header of [
    'Bearer token', 'Basic !!!!', 'Basic YQ==',
    `Basic ${Buffer.from(`${authUsername}:wrong`).toString('base64')}`,
    `Basic ${Buffer.from(`wrong:${authPassword}`).toString('base64')}`,
    `Basic ${Buffer.from([255, 58, 255]).toString('base64')}`,
    `Basic ${'a'.repeat(2050)}`,
  ]) {
    const response = await fetch(`${url}/api/decide`, {
      method: 'POST', headers: { Authorization: header, 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.equal(evaluations, 0);
  const wrong = await fetch(`${url}/auth/login`, {
    method: 'POST', headers: { Origin: url }, body: new URLSearchParams({ username: authUsername, password: 'wrong' }), redirect: 'manual',
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  assert.match(await wrong.text(), /Invalid username or password/);
  const login = await fetch(`${url}/auth/login`, { method: 'POST', headers: { Origin: url }, body: loginBody(), redirect: 'manual' });
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');
  const session = login.headers.get('set-cookie');
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Strict/);
  assert.match(session, /Max-Age=28800/);
  assert.doesNotMatch(session, /Secure/);
  const cookie = session.split(';')[0];
  const loggedIn = await fetch(`${url}/login`, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(loggedIn.status, 303);
  assert.equal(loggedIn.headers.get('location'), '/');
  for (const path of ['/', '/app.js', '/style.css', '/api/config']) {
    const response = await fetch(`${url}${path}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(authPassword), false);
    assert.equal(text.includes(auth.passwordHash), false);
  }
  const result = await fetch(`${url}/api/decide`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"text":"synthetic"}',
  });
  assert.equal(result.status, 200);
  const evaluated = await result.json();
  assert.equal(evaluated.success, true);
  assert.equal(evaluated.requestId, result.headers.get('x-request-id'));
  assert.equal(evaluations, 1);
  const tampered = await fetch(`${url}/api/config`, { headers: { Cookie: `${cookie}a` } });
  assert.equal(tampered.status, 401);
  await tampered.text();
  const logout = await fetch(`${url}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: url }, redirect: 'manual' });
  assert.equal(logout.status, 303);
  assert.equal(logout.headers.get('location'), '/login');
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const revoked = await fetch(`${url}/api/config`, { headers: { Cookie: cookie } });
  assert.equal(revoked.status, 401);
  await revoked.text();
});

test('expires sessions after eight hours, rotates sessions, and bounds failed login attempts', async (t) => {
  let time = 1000;
  const config = { port: 0, auth };
  const app = createApp(config, async () => ({}), { now: () => time });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  config.port = app.address().port;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const url = `http://127.0.0.1:${config.port}`;
  const login = (body = loginBody(), cookie = '') => fetch(`${url}/auth/login`, {
    method: 'POST', headers: { Origin: url, Cookie: cookie }, body, redirect: 'manual',
  });
  const first = await login();
  const firstCookie = first.headers.get('set-cookie').split(';')[0];
  const second = await login(loginBody(), firstCookie);
  const secondCookie = second.headers.get('set-cookie').split(';')[0];
  assert.notEqual(firstCookie, secondCookie);
  const old = await fetch(`${url}/api/config`, { headers: { Cookie: firstCookie } });
  assert.equal(old.status, 401);
  await old.text();
  time += SESSION_TTL_MS - 1;
  const beforeExpiry = await fetch(`${url}/api/config`, { headers: { Cookie: secondCookie } });
  assert.equal(beforeExpiry.status, 200);
  await beforeExpiry.text();
  time++;
  const expired = await fetch(`${url}/api/config`, { headers: { Cookie: secondCookie } });
  assert.equal(expired.status, 401);
  await expired.text();
  for (let attempt = 0; attempt < 20; attempt++) {
    const rejected = await login(new URLSearchParams({ username: 'wrong', password: 'wrong' }));
    assert.equal(rejected.status, 401);
    await rejected.text();
  }
  const limited = await login();
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.match(await limited.text(), /Too many login attempts/);
  time += 60000;
  assert.equal((await login()).status, 303);
});

test('rejects cross-origin, missing-origin, oversized, and ambiguous login forms', async (t) => {
  const config = { port: 0, auth };
  const app = createApp(config, async () => ({}));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  config.port = app.address().port;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const url = `http://127.0.0.1:${config.port}`;
  for (const path of ['/auth/login', '/auth/logout']) {
    for (const headers of [{}, { Origin: 'https://evil.example' }]) {
      const rejected = await fetch(`${url}${path}`, { method: 'POST', headers, body: loginBody(), redirect: 'manual' });
      assert.equal(rejected.status, 403);
      await rejected.text();
    }
  }
  for (const [body, status] of [
    [new URLSearchParams({ username: 'test-user' }), 400],
    [new URLSearchParams({ username: 'a'.repeat(65), password: 'wrong' }), 400],
    [new URLSearchParams('username=a&username=b&password=wrong'), 400],
    [new URLSearchParams({ username: 'a', password: 'a'.repeat(5000) }), 413],
    ['{}', 415],
  ]) {
    const rejected = await fetch(`${url}/auth/login`, { method: 'POST', headers: { Origin: url }, body, redirect: 'manual' });
    assert.equal(rejected.status, status);
    await rejected.text();
  }
});

test('accepts the configured hosted origin and rejects foreign hosts and HTTP origins', async (t) => {
  const config = {
    port: 0,
    publicOrigin: 'https://app-decision-example.azurewebsites.net',
    hosted: true,
    auth,
  };
  const app = createApp(config, async () => ({ success: true }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  config.port = app.address().port;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const login = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: config.port, path: '/auth/login', method: 'POST',
      headers: { Host: 'app-decision-example.azurewebsites.net', Origin: config.publicOrigin, 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => { res.resume(); resolve(res); });
    req.on('error', reject);
    req.end(loginBody().toString());
  });
  assert.equal(login.statusCode, 303);
  const session = login.headers['set-cookie'][0];
  assert.match(session, /^__Host-decision-session=/);
  assert.match(session, /; Secure/);
  const request = (host, origin) => new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: config.port, path: '/api/decide', method: 'POST',
      headers: { Host: host, Origin: origin, Cookie: session.split(';')[0], 'Content-Type': 'application/json' },
    }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('{"text":"synthetic"}');
  });
  assert.equal(await request('app-decision-example.azurewebsites.net', config.publicOrigin), 200);
  assert.equal(await request('evil.example', config.publicOrigin), 403);
  assert.equal(await request('app-decision-example.azurewebsites.net', 'http://app-decision-example.azurewebsites.net'), 403);
});

test('serves UI and validates HTTP requests, hosts, and origins', async (t) => {
  const config = { endpoint: 'https://example.cognitiveservices.azure.com', deployment: 'decision-1', port: 0 };
  const app = createApp(config, async (input) => ({ text: validateInput(input).text }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  config.port = app.address().port;
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const url = `http://127.0.0.1:${config.port}`;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Decision Lab/i);
  const settings = await fetch(`${url}/api/config`);
  assert.equal((await settings.json()).examples.length, 6);
  const valid = await fetch(`${url}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ' hi ' }) });
  const evaluated = await valid.json();
  assert.equal(evaluated.text, 'hi');
  assert.equal(evaluated.requestId, valid.headers.get('x-request-id'));
  const crossOrigin = await fetch(`${url}/api/decide`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: 'evil.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  const invalidJson = await fetch(`${url}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  const wrongType = await fetch(`${url}/api/decide`, { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  const oversized = await fetch(`${url}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'a'.repeat(66000) }) });
  assert.equal(oversized.status, 413);
});
