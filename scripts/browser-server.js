// Deterministic test-only server: never obtains Azure credentials or calls inference.
import { createHash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createApp } from '../server.js';
import { applyPolicy } from '../public/contract.js';
const config = {
  port: Number(process.env.BROWSER_TEST_PORT ?? 3199),
  endpoint: 'https://fixture.cognitiveservices.azure.com',
  deployment: 'fixture',
  requestIntervalMs: 20,
  auth: { username: 'test-user', passwordHash: createHash('sha256').update('test-only-high-entropy-password').digest('hex') },
};
const app = createApp(config, async (input, signal) => {
  if (input.text === 'Slow fixture') await setTimeout(30000, undefined, { signal });
  const decision = {
    team: 'technical', selectedProbability: 0.9, apiConfidence: 0.8,
    probabilities: { billing: 0.05, technical: 0.9, account: 0.05 },
    urgentProbability: 0.7, severityScore: 2,
    severityProbabilities: { 0: 0, 1: 0, 2: 1, 3: 0 },
  };
  return {
    decision, policy: applyPolicy(decision, input.reviewThreshold, input.urgencyThreshold),
    timing: { inferenceHttpMs: 10, totalMs: 11 }, request: input,
    response: { model: 'fixture', usage: { input_tokens: 12, output_tokens: 3 } },
  };
});
app.listen(config.port, '127.0.0.1', () => console.log('Browser fixture ready'));
