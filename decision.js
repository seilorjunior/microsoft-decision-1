import { TEAMS, LEVELS, buildRequest, applyPolicy } from './public/contract.js';
export { TEAMS, LEVELS, buildRequest, applyPolicy };

export const EXAMPLES = Object.freeze([
  { id: 'duplicate', title: 'Double charge', text: 'My monthly subscription was charged twice. Please help me get the duplicate payment refunded.', expected: 'billing' },
  { id: 'outage', title: 'Checkout outage', text: 'Checkout is down for all customers. Every request returns HTTP 500. Nobody can place orders.', expected: 'technical' },
  { id: 'login', title: 'Locked out', text: 'I cannot sign in after resetting my password. The verification link has expired.', expected: 'account' },
  { id: 'invoice', title: 'Invoice request', text: 'Where can I download the invoice for my latest subscription payment?', expected: 'billing' },
  { id: 'integration', title: 'Broken integration', text: 'The SDK crashes with a null reference exception every time our app uploads a file.', expected: 'technical' },
  { id: 'password', title: 'Password help', text: 'How do I change my password and enable two-factor authentication on my account?', expected: 'account' },
]);

export class AppError extends Error {
  constructor(message, status = 502, options) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
  }
}

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('Send a JSON object containing ticket text.', 400);
  }
  const { text, reviewThreshold = 0.8, urgencyThreshold = 0.8, reverseOptions = false } = input;
  if (typeof text !== 'string' || !text.trim() || text.length > 12000) {
    throw new AppError('Ticket text must contain 1 to 12,000 characters.', 400);
  }
  for (const [name, value] of Object.entries({ reviewThreshold, urgencyThreshold })) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new AppError(`${name} must be a number between 0 and 1.`, 400);
    }
  }
  if (typeof reverseOptions !== 'boolean') {
    throw new AppError('reverseOptions must be true or false.', 400);
  }
  return { text: text.trim(), reviewThreshold, urgencyThreshold, reverseOptions };
}


function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function distribution(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length ||
      !keys.every((key) => probability(value[key]))) {
    throw new AppError('Foundry returned an invalid probability distribution.');
  }
  const sum = keys.reduce((total, key) => total + value[key], 0);
  if (Math.abs(sum - 1) > 0.03) {
    throw new AppError('Foundry returned probabilities that do not sum approximately to one.');
  }
  return value;
}

export function readDecision(payload) {
  if (!object(payload) || !object(payload.answers) || typeof payload.model !== 'string') {
    throw new AppError('Foundry returned an invalid decision response.');
  }
  const { team, urgent, severity } = payload.answers;
  if (!object(team) || team.type !== 'choice' || !Object.hasOwn(TEAMS, team.choice) ||
      !probability(team.confidence)) {
    throw new AppError('Foundry returned an invalid team answer.');
  }
  const probabilities = distribution(team.probabilities, Object.keys(TEAMS));
  if (!object(urgent) || urgent.type !== 'noul' || !probability(urgent.noul)) {
    throw new AppError('Foundry returned an invalid escalation answer.');
  }
  if (!object(severity) || severity.type !== 'score' || !Number.isFinite(severity.score) ||
      severity.score < 0 || severity.score > 3 || !probability(severity.confidence)) {
    throw new AppError('Foundry returned an invalid severity answer.');
  }
  const severityProbabilities = distribution(severity.probabilities, ['0', '1', '2', '3']);
  return {
    team: team.choice,
    selectedProbability: probabilities[team.choice],
    apiConfidence: team.confidence,
    probabilities,
    urgentProbability: urgent.noul,
    severityScore: severity.score,
    severityProbabilities,
    model: payload.model,
  };
}


export async function evaluate(input, config, getToken, fetchImpl = fetch, signal) {
  const validated = validateInput(input);
  const request = buildRequest(config.deployment, validated.text, validated.reverseOptions);
  let accessToken;
  const start = performance.now();
  try {
    accessToken = await getToken();
  } catch (error) {
    throw new AppError('Azure authentication failed. Sign in with az login and check your Foundry inference permissions.', 401, { cause: error });
  }
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new AppError('Azure authentication did not return an access token.', 401);
  }
  let response;
  const inferenceStart = performance.now();
  try {
    response = await fetchImpl(`${config.endpoint}/providers/microsoft/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError('Inference cancelled. A request already sent to Azure may still incur charges.', 499);
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new AppError('Foundry did not respond within 60 seconds. Retry manually.', 504);
    }
    throw new AppError('Could not reach Foundry. Check the endpoint and your network connection.', 502);
  }
  const throttling = {};
  for (const name of ['retry-after', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests', 'x-ratelimit-renewalperiod-requests']) {
    const value = response.headers?.get(name);
    if (value && /^-?\d{1,9}$/.test(value)) throttling[name] = Number(value);
  }
  if (!response.ok) {
    const hints = {
      401: 'Check your Azure sign-in and token audience.',
      403: 'Check Foundry inference RBAC and resource network access.',
      404: 'Check the resource endpoint and deployment name.',
      429: 'Quota or rate limit reached. Wait before retrying.',
    };
    const error = new AppError(`Foundry returned HTTP ${response.status}. ${hints[response.status] ?? 'Check the deployment in Foundry before retrying.'}`, response.status === 429 ? 429 : 502);
    error.throttling = throttling;
    throw error;
  }
  let raw;
  try {
    raw = await response.json();
  } catch {
    throw new AppError('Foundry returned invalid JSON.');
  }
  const decision = readDecision(raw);
  return {
    throttling,
    decision,
    policy: applyPolicy(decision, validated.reviewThreshold, validated.urgencyThreshold),
    timing: {
      totalMs: Math.round(performance.now() - start),
      inferenceHttpMs: Math.round(performance.now() - inferenceStart),
    },
    request,
    response: raw,
  };
}
