import http from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AzureCliCredential, ManagedIdentityCredential } from '@azure/identity';
import { AppError, EXAMPLES, TEAMS, LEVELS, evaluate, validateInput } from './decision.js';
import { EVALUATION_SET } from './public/dataset.js';
import { createInferenceQueue } from './queue.js';

export function readConfig(env) {
  const endpoint = env.AZURE_ENDPOINT;
  const deployment = env.DEPLOYMENT_NAME;
  if (!endpoint || !deployment) throw new Error('Set AZURE_ENDPOINT and DEPLOYMENT_NAME in .env.');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port || !['', '/'].includes(url.pathname) ||
      !/\.(cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname)) {
    throw new Error('AZURE_ENDPOINT must be a public Azure Foundry resource root HTTPS URL.');
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1 through 65535.');
  const requestIntervalMs = Number(env.REQUEST_INTERVAL_MS ?? 61000);
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 120000) {
    throw new Error('REQUEST_INTERVAL_MS must be 0 through 120000.');
  }
  const hosted = Boolean(env.WEBSITE_HOSTNAME);
  if (hosted && !/^[a-z0-9-]+\.azurewebsites\.net$/.test(env.WEBSITE_HOSTNAME)) {
    throw new Error('WEBSITE_HOSTNAME must be an Azure App Service hostname.');
  }
  const username = env.APP_AUTH_USERNAME;
  const passwordHash = env.APP_AUTH_PASSWORD_HASH;
  if (hosted || username || passwordHash) {
    if (!username || !/^[a-zA-Z0-9_-]{1,64}$/.test(username) || !/^[a-f0-9]{64}$/.test(passwordHash ?? '')) {
      throw new Error('Configure APP_AUTH_USERNAME and APP_AUTH_PASSWORD_HASH using npm run setup-auth.');
    }
  }
  return { endpoint: url.origin, deployment, port, requestIntervalMs, hosted,
    auth: username ? { username, passwordHash } : undefined,
    publicOrigin: hosted ? `https://${env.WEBSITE_HOSTNAME}` : undefined };
}

const digest = (value) => createHash('sha256').update(value).digest();

function authenticated(username, password, auth) {
  const validUsername = timingSafeEqual(digest(username), digest(auth.username));
  const validPassword = timingSafeEqual(digest(password), Buffer.from(auth.passwordHash, 'hex'));
  return validUsername && validPassword;
}

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function createCredential(config, env) {
  return config.hosted
    ? new ManagedIdentityCredential()
    : new AzureCliCredential({ subscription: env.AZURE_SUBSCRIPTION_ID });
}

const staticFiles = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/login.js': ['public/login.js', 'text/javascript; charset=utf-8'],
  '/contract.js': ['public/contract.js', 'text/javascript; charset=utf-8'],
  '/dataset.js': ['public/dataset.js', 'text/javascript; charset=utf-8'],
};

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

async function loginPage(res, status = 200, message = '') {
  const template = await readFile(new URL('public/login.html', import.meta.url), 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(template.replace('<!--LOGIN_ERROR-->', message ? `<div class="error" role="alert">${message}</div>` : ''));
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readText(req, limit = 65536) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError(`Request exceeds the ${limit / 1024} KB limit.`, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req) {
  const text = await readText(req);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('Request body is not valid JSON.', 400);
  }
}

export function createApp(config, runEvaluation, { now = Date.now } = {}) {
  if (config.hosted && !config.auth) throw new Error('Hosted app requires authentication.');
  const sessions = new Map();
  const queue = createInferenceQueue(config.requestIntervalMs ?? 0);
  const attempts = new Map();
  const cookieName = config.hosted ? '__Host-decision-session' : 'decision-session';
  const cookie = (token, maxAge) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.hosted ? '; Secure' : ''}`;
  const app = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.setHeader('X-Request-Id', requestId);
    res.once('finish', () => {
      // No URLs, client addresses, tickets, cookies, or credentials in diagnostics.
      console.info(JSON.stringify({ event: 'http', requestId, method: req.method, status: res.statusCode, durationMs: Math.round(performance.now() - startedAt) }));
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const hosts = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`]);
    const origins = new Set([`http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]);
    if (config.publicOrigin) {
      hosts.add(new URL(config.publicOrigin).host);
      origins.add(config.publicOrigin);
    }
    try {
      if (!hosts.has(req.headers.host)) throw new AppError('Invalid host.', 403);
      if (req.headers.origin && !origins.has(req.headers.origin)) {
        throw new AppError('Cross-origin requests are not allowed.', 403);
      }
      const path = new URL(req.url, `http://localhost:${config.port}`).pathname;
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
      const time = now();
      for (const [key, expires] of sessions) {
        if (expires <= time) sessions.delete(key);
      }
      const token = req.headers.cookie?.split(';').map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const sessionKey = token && /^[a-f0-9]{64}$/.test(token) ? digest(token).toString('hex') : undefined;
      const signedIn = sessionKey !== undefined && sessions.has(sessionKey);
      if (config.auth && path.startsWith('/auth/') && req.method === 'POST' && !req.headers.origin) {
        throw new AppError('Authentication requests require a same-origin Origin header.', 403);
      }
      if (config.auth && req.method === 'GET' && path === '/login') {
        if (signedIn) return redirect(res, '/');
        return await loginPage(res);
      }
      if (config.auth && req.method === 'POST' && path === '/auth/login') {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
          throw new AppError('Login must use an HTML form.', 415);
        }
        const form = new URLSearchParams(await readText(req, 4096));
        if (form.getAll('username').length !== 1 || form.getAll('password').length !== 1 ||
            form.get('username').length > 64 || form.get('password').length > 256) {
          throw new AppError('Login requires one username and one password within the field limits.', 400);
        }
        for (const [key, value] of attempts) {
          if (time >= value.ends) attempts.delete(key);
        }
        const client = req.socket.remoteAddress;
        if (!attempts.has(client)) {
          if (attempts.size >= 1000) throw new AppError('Login capacity reached. Try again later.', 429);
          attempts.set(client, { failures: 0, ends: time + 60000 });
        }
        const attempt = attempts.get(client);
        if (attempt.failures >= 20) {
          res.setHeader('Retry-After', String(Math.ceil((attempt.ends - time) / 1000)));
          console.error('[login failed] 429: Too many login attempts.');
          return await loginPage(res, 429, 'Too many login attempts. Wait a minute, then try again.');
        }
        if (!authenticated(form.get('username'), form.get('password'), config.auth)) {
          attempt.failures++;
          console.error('[login failed] 401: Invalid username or password.');
          return await loginPage(res, 401, 'Invalid username or password. Please try again.');
        }
        attempts.delete(client);
        if (sessionKey) sessions.delete(sessionKey);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const newToken = randomBytes(32).toString('hex');
        sessions.set(digest(newToken).toString('hex'), time + SESSION_TTL_MS);
        res.setHeader('Set-Cookie', cookie(newToken, SESSION_TTL_MS / 1000));
        return redirect(res, '/');
      }
      if (config.auth && req.method === 'POST' && path === '/auth/logout') {
        if (sessionKey) sessions.delete(sessionKey);
        res.setHeader('Set-Cookie', cookie('', 0));
        return redirect(res, '/login');
      }
      const publicAsset = path === '/style.css' || path === '/login.js';
      if (config.auth && !signedIn && !(req.method === 'GET' && publicAsset)) {
        if (req.method === 'GET' && path === '/') return redirect(res, '/login');
        console.error('[request failed] 401: Sign-in required.');
        return json(res, 401, { error: 'Your session is missing or expired. Sign in again.', code: 'AUTH_REQUIRED' });
      }
      if (req.method === 'GET' && path === '/api/config') {
        return json(res, 200, { deployment: config.deployment, endpoint: config.endpoint, requestIntervalMs: config.requestIntervalMs, examples: EXAMPLES, evaluationSet: EVALUATION_SET, teams: TEAMS, levels: LEVELS, authenticationEnabled: Boolean(config.auth) });
      }
      if (req.method === 'GET' && path === '/api/queue') return json(res, 200, queue.status());
      if (req.method === 'POST' && path === '/api/decide') {
        if (!req.headers['content-type']?.startsWith('application/json')) {
          throw new AppError('Content-Type must be application/json.', 415);
        }
        const input = validateInput(await readBody(req));
        const queuedAt = performance.now();
        const controller = new AbortController();
        res.once('close', () => { if (!res.writableEnded) controller.abort(); });
        const result = await queue.run(async (signal) => {
          if (config.auth && (!sessionKey || !sessions.has(sessionKey) || sessions.get(sessionKey) <= now())) {
            const error = new AppError('Your session expired while waiting. Sign in again.', 401);
            error.code = 'AUTH_REQUIRED';
            throw error;
          }
          const queueWaitMs = Math.round(performance.now() - queuedAt);
          try {
            const result = await runEvaluation(input, signal);
            console.info(JSON.stringify({ event: 'inference', requestId, queueWaitMs, durationMs: result.timing?.inferenceHttpMs, throttling: result.throttling }));
            return { ...result, timing: { ...result.timing, queueWaitMs } };
          } catch (error) {
            const retrySeconds = error.throttling?.['retry-after'];
            if (error.status === 429 && Number.isFinite(retrySeconds) && retrySeconds > 0) queue.defer(Math.min(retrySeconds, 3600) * 1000);
            console.error(JSON.stringify({ event: 'inference-failed', requestId, status: error instanceof AppError ? error.status : 500, throttling: error.throttling }));
            throw error;
          }
        }, controller.signal);
        return json(res, 200, { ...result, requestId });
      }
      if (req.method === 'GET' && Object.hasOwn(staticFiles, path)) {
        const [file, contentType] = staticFiles[path];
        const content = await readFile(new URL(file, import.meta.url));
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(content);
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const message = error instanceof AppError ? error.message : 'Unexpected server error. Check server logs.';
      // Never log tickets, request headers, tokens, or raw upstream responses.
      console.error(`[request failed] ${status}: ${error instanceof AppError ? message : error.name}`);
      if (!res.headersSent && !res.destroyed) json(res, status, {
        error: message, requestId,
        ...(error.throttling ? { throttling: error.throttling } : {}),
        ...(error.code === 'AUTH_REQUIRED' ? { code: error.code } : {}),
      });
      else res.end();
    }
  });
  app.once('close', () => queue.stop());
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const config = readConfig(process.env);
  const credential = createCredential(config, process.env);
  const getToken = async () => (await credential.getToken('https://cognitiveservices.azure.com/.default')).token;
  const app = createApp(config, (input, signal) => evaluate(input, config, getToken, fetch, signal));
  app.on('error', (error) => {
    console.error(`Server failed: ${error.message}`);
    process.exitCode = 1;
  });
  app.listen(config.port, config.hosted ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`Decision-1 Lab: http://localhost:${config.port}`);
    console.log(`Live Foundry deployment: ${config.deployment}. Requests incur inference charges.`);
  });
}
