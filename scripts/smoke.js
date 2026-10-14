import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const SMOKE_TICKET = 'Synthetic smoke test: customer cannot sign in after a password reset and asks for help.';

export function parseLogin(text) {
  const username = text.match(/^Username: (.+)$/m)?.[1]?.trim();
  const password = text.match(/^Password: (.+)$/m)?.[1]?.trim();
  if (!username || !password) throw new Error('Login file must contain "Username:" and "Password:" lines. Run npm run setup-auth.');
  return { username, password };
}

export function sessionCookie(headers) {
  const cookies = headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((value) => value.split(';')[0]).find((value) => /^(__Host-)?decision-session=[a-f0-9]{64}$/.test(value));
  if (!cookie) throw new Error('Login did not return a session cookie.');
  return cookie;
}

export function summarize(result) {
  const { decision, timing } = result;
  if (!decision?.team || typeof decision.selectedProbability !== 'number' || typeof decision.urgentProbability !== 'number' ||
      typeof decision.severityScore !== 'number' || !result.policy?.action || typeof timing?.inferenceHttpMs !== 'number') {
    throw new Error('Inference response is missing the decision, policy, or timing fields.');
  }
  return {
    team: decision.team,
    selectedProbability: decision.selectedProbability,
    urgentProbability: decision.urgentProbability,
    severityScore: decision.severityScore,
    action: result.policy.action,
    queueWaitMs: timing.queueWaitMs ?? 0,
    inferenceHttpMs: timing.inferenceHttpMs,
    tokenAndOverheadMs: Math.max(0, timing.totalMs - timing.inferenceHttpMs),
  };
}

export async function waitForHealth(origin, { fetchImpl = fetch, attempts = 18, delayMs = 10000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let last = 'no response';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(`${origin}/health`, { signal: AbortSignal.timeout(15000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.name === 'TimeoutError' ? 'timeout' : error.message;
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`The app did not become healthy after ${attempts} checks (last result: ${last}). Check the App Service startup logs.`);
}

export async function runSmokeTest({ endpoint, loginText, fetchImpl = fetch, health = {} }) {
  const origin = new URL(endpoint).origin;
  const { username, password } = parseLogin(loginText);
  await waitForHealth(origin, { fetchImpl, ...health });
  const login = await fetchImpl(`${origin}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({ username, password }),
  });
  if (login.status !== 303) throw new Error(`Login returned HTTP ${login.status}. Check the private login file against the deployed hash (npm run setup-auth, then azd provision).`);
  const cookie = sessionCookie(login.headers);
  const decide = await fetchImpl(`${origin}/api/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ text: SMOKE_TICKET }),
    signal: AbortSignal.timeout(180000),
  });
  const body = await decide.json().catch(() => ({}));
  if (!decide.ok) throw new Error(`Inference returned HTTP ${decide.status}: ${body.error ?? 'no error message'}`);
  return summarize(body);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.SKIP_SMOKE_TEST === 'true') {
    console.log('Smoke test skipped because SKIP_SMOKE_TEST=true.');
  } else {
    try {
      const endpoint = process.env.SERVICE_WEB_ENDPOINT;
      if (!endpoint) throw new Error('SERVICE_WEB_ENDPOINT is not set. Run through azd or export it first.');
      const { SMOKE_USERNAME: username, SMOKE_PASSWORD: password } = process.env;
      const loginText = username && password
        ? `Username: ${username}\nPassword: ${password}\n`
        : await readFile(new URL('../.azure/app-login.txt', import.meta.url), 'utf8').catch((error) => {
          if (error.code === 'ENOENT') throw new Error('.azure/app-login.txt is missing. Run npm run setup-auth, then azd provision.');
          throw error;
        });
      console.log('Running one billable inference call against the deployed app...');
      console.log(JSON.stringify(await runSmokeTest({ endpoint, loginText }), null, 2));
      console.log('Smoke test passed.');
    } catch (error) {
      console.error(`Smoke test failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
