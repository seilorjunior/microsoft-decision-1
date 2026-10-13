const $ = (id) => document.getElementById(id);
let config;
let latest;
let busy = false;
let operation;
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const thresholds = () => ({
  reviewThreshold: Number($('review-threshold').value) / 100,
  urgencyThreshold: Number($('urgency-threshold').value) / 100,
});

function setBusy(value) {
  busy = value;
  $('decide-button').disabled = value || !config;
  $('benchmark-button').disabled = value || !config;
  $('comparison-button').disabled = value || !config;
  $('cancel-button').hidden = !value;
  if (value) operation = new AbortController();
  else $('queue-status').textContent = '';
  $('decide-button').textContent = value ? 'Scoring...' : 'Run decision \u2192';
  $('ticket-form').setAttribute('aria-busy', String(value));
}

function showError(error) {
  $('error').textContent = error.message;
  $('error').hidden = false;
}

function renderPolicy() {
  if (!latest) return;
  const { decision } = latest;
  const { reviewThreshold, urgencyThreshold } = thresholds();
  const policy = applyPolicy(decision, reviewThreshold, urgencyThreshold);
  const { urgent, needsReview: review } = policy;
  $('policy-result').className = `policy-result${urgent ? ' urgent' : review ? ' review' : ''}`;
  $('action').textContent = policy.action;
  $('action-reason').textContent = policy.reason;
}

function bars(container, values, labels, selected) {
  container.replaceChildren();
  for (const [key, value] of Object.entries(values)) {
    const row = document.createElement('div');
    row.className = `bar-row${key === selected ? ' selected' : ''}`;
    const label = document.createElement('span');
    label.textContent = labels[key] ?? key;
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = value;
    bar.setAttribute('aria-label', `${label.textContent} probability`);
    const number = document.createElement('span');
    number.textContent = percent(value);
    row.append(label, bar, number);
    container.append(row);
  }
}

function render(result) {
  latest = result;
  const { decision, timing, response } = result;
  $('empty-state').hidden = true;
  $('results').hidden = false;
  $('result-status').textContent = 'LIVE RESPONSE';
  $('latency').textContent = `${timing.inferenceHttpMs} ms`;
  $('tokens').textContent = response.usage?.input_tokens ?? 'Not reported';
  $('chosen-team').textContent = decision.team;
  $('chosen-probability').textContent = percent(decision.selectedProbability);
  $('api-confidence').textContent = `API confidence: ${percent(decision.apiConfidence)}. Routing uses selected-option probability. Queue wait: ${timing.queueWaitMs ?? 0} ms. Total inference time including authentication: ${timing.totalMs} ms. Request reference: ${result.requestId ?? 'not reported'}.`;
  bars($('team-bars'), decision.probabilities, {}, decision.team);
  $('urgency').textContent = percent(decision.urgentProbability);
  $('severity').textContent = `${decision.severityScore.toFixed(2)} / 3`;
  bars($('severity-bars'), decision.severityProbabilities, { 0: 'Low', 1: 'Moderate', 2: 'High', 3: 'Critical' });
  $('request-json').textContent = JSON.stringify(result.request, null, 2);
  $('response-json').textContent = JSON.stringify(response, null, 2);
  renderPolicy();
}

function previewRequest() {
  if (!config) return;
  $('request-json').textContent = JSON.stringify(buildRequest(config.deployment, $('ticket').value.trim(), $('reverse-options').checked), null, 2);
}

function invalidate() {
  latest = undefined;
  $('results').hidden = true;
  $('empty-state').hidden = false;
  $('result-status').textContent = 'AWAITING INPUT';
  $('response-json').textContent = 'Input changed. Run again to get a new model response.';
  $('error').hidden = true;
  $('character-count').textContent = `${$('ticket').value.length.toLocaleString()} / 12,000`;
  previewRequest();
}

async function readApiResponse(response) {
  const result = await response.json();
  if (response.status === 401 && result.code === 'AUTH_REQUIRED') {
    window.location.assign('/login');
  }
  if (!response.ok) {
    const retry = result.throttling?.['retry-after'];
    throw new Error(`${result.error ?? `Request failed with HTTP ${response.status}.`}${retry ? ` Retry after ${retry}s.` : ''}${result.requestId ? ` Reference: ${result.requestId}.` : ''}`);
  }
  return result;
}

async function request(text, options = {}) {
  const signal = operation?.signal;
  const updateQueue = async () => {
    try {
      const status = await readApiResponse(await fetch('/api/queue', { signal }));
      $('queue-status').textContent = `Shared queue: ${status.pending} waiting. Next start in about ${Math.ceil(status.nextStartInMs / 1000)}s${status.active ? '; inference active' : ''}.`;
    } catch (error) {
      if (!signal?.aborted) $('queue-status').textContent = `Queue status unavailable: ${error.message}`;
    }
  };
  const timer = setInterval(updateQueue, 1000);
  try {
  const response = await fetch('/api/decide', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...thresholds(), reverseOptions: $('reverse-options').checked, ...options }),
    signal,
  });
  return await readApiResponse(response);
  } finally {
    clearInterval(timer);
    $('queue-status').textContent = '';
  }
}

$('cancel-button').addEventListener('click', () => operation?.abort(new Error('Cancelled. Requests already sent to Azure may still be billed.')));

$('ticket').addEventListener('input', () => {
  document.querySelectorAll('.example').forEach((button) => button.classList.remove('active'));
  invalidate();
});
$('reverse-options').addEventListener('change', invalidate);
for (const [slider, output] of [['review-threshold', 'review-value'], ['urgency-threshold', 'urgency-value']]) {
  $(slider).addEventListener('input', () => {
    $(output).textContent = `${$(slider).value}%`;
    renderPolicy();
  });
}

$('ticket-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  $('error').hidden = true;
  latest = undefined;
  $('results').hidden = true;
  $('empty-state').hidden = false;
  $('result-status').textContent = 'SCORING';
  $('response-json').textContent = 'Waiting for Foundry...';
  try {
    const text = $('ticket').value.trim();
    const reverse = $('reverse-options').checked;
    const result = await request(text);
    if (text !== $('ticket').value.trim() || reverse !== $('reverse-options').checked) {
      invalidate();
      $('result-status').textContent = 'INPUT CHANGED / RUN AGAIN';
      return;
    }
    render(result);
  } catch (error) {
    showError(error);
    $('result-status').textContent = 'REQUEST FAILED';
    $('response-json').textContent = error.message;
  } finally {
    setBusy(false);
  }
});

$('benchmark-button').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  $('error').hidden = true;
  $('benchmark-results').hidden = false;
  $('benchmark-body').replaceChildren();
  const times = [];
  let correct = 0;
  let complete = false;
  const rows = [];
  const cases = $('evaluation-mode').value === 'extended' ? config.evaluationSet : config.examples;
  const policyThresholds = thresholds();
  try {
    for (const [index, example] of cases.entries()) {
      $('benchmark-status').textContent = `Running ${index + 1} / ${cases.length}: ${example.title}...`;
      const result = await request(example.text, { ...policyThresholds });
      rows.push({ example, decision: result.decision });
      const passed = result.decision.team === example.expected;
      correct += Number(passed);
      times.push(result.timing.inferenceHttpMs);
      const row = document.createElement('tr');
      for (const value of [example.title, example.expected, result.decision.team, percent(result.decision.selectedProbability), `${result.timing.inferenceHttpMs} ms`, passed ? 'PASS' : 'FAIL']) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      row.lastChild.className = passed ? 'pass' : 'fail';
      $('benchmark-body').append(row);
    }
    complete = true;
  } catch (error) {
    showError(error);
  } finally {
    const sorted = [...times].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length
      ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
      : undefined;
    $('benchmark-status').textContent = `${complete ? 'Completed' : 'Stopped after error'}: ${times.length} / ${cases.length} tickets. ${correct} correct${times.length ? ` (${Math.round(correct / times.length * 100)}% of completed tickets). Median API request: ${Math.round(median)} ms.` : '.'} Not a production quality or calibration estimate.`;
    $('evaluation-summary').textContent = JSON.stringify(summarizeEvaluation(rows, policyThresholds.reviewThreshold, policyThresholds.urgencyThreshold), null, 2);
    setBusy(false);
  }
});

$('comparison-button').addEventListener('click', async () => {
  if (busy) return;
  const text = $('ticket').value.trim();
  const paraphrase = $('paraphrase').value.trim();
  if (!text || !paraphrase) return showError(new Error('Enter the original ticket and a manually written paraphrase.'));
  setBusy(true);
  $('error').hidden = true;
  $('comparison-body').replaceChildren();
  const options = thresholds();
  let baseline;
  try {
    for (const [label, state, reverseOptions] of [['Original', text, false], ['Reversed options', text, true], ['Paraphrase', paraphrase, false]]) {
      const result = await request(state, { ...options, reverseOptions });
      baseline ??= result;
      const row = document.createElement('tr');
      const delta = Object.keys(config.teams).map((team) => `${team}: ${((result.decision.probabilities[team] - baseline.decision.probabilities[team]) * 100).toFixed(1)} pp`).join('; ');
      for (const value of [label, result.decision.team, delta, percent(result.decision.urgentProbability), result.decision.severityScore.toFixed(2), `${result.timing.inferenceHttpMs} ms`]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      $('comparison-body').append(row);
    }
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});

try {
  const response = await fetch('/api/config');
  config = await readApiResponse(response);
  $('signout-form').hidden = !config.authenticationEnabled;
  for (const example of config.examples) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'example';
    button.textContent = example.title;
    button.addEventListener('click', () => {
      document.querySelectorAll('.example').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      $('ticket').value = example.text;
      invalidate();
    });
    $('examples').append(button);
  }
  $('ticket').value = config.examples[1].text;
  $('examples').children[1].classList.add('active');
  $('connection').textContent = 'LIVE API CONFIGURED';
  $('connection').className = 'connection ready';
  $('deployment-label').textContent = `Deployment: ${config.deployment}`;
  invalidate();
  setBusy(false);
} catch (error) {
  $('connection').textContent = 'CONFIGURATION FAILED';
  $('connection').className = 'connection failed';
  showError(error);
}
import { buildRequest, applyPolicy, summarizeEvaluation } from '/contract.js';
