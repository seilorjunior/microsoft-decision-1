import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function requestedCapacity(bicepText) {
  const match = bicepText.match(/^param modelCapacity int = (\d+)/m);
  if (!match) throw new Error('Could not read the modelCapacity default from infra/main.bicep.');
  return Number(match[1]);
}

export function findQuota(usage) {
  return usage.find((item) => /Decision-1/i.test(item.name?.value ?? '') && /DataZoneStandard/i.test(item.name?.value ?? ''));
}

export function evaluateQuota(usage, requested) {
  const quota = findQuota(usage);
  if (!quota) return { ok: false, message: 'No Microsoft-Decision-1 DataZoneStandard quota was reported for this region and subscription.' };
  const available = quota.limit - quota.currentValue;
  return {
    ok: available >= requested,
    available,
    message: `Requested ${requested}, available ${available} (limit ${quota.limit}, used ${quota.currentValue}).`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = process.env;
  if (env.USE_EXISTING_FOUNDRY === 'true') {
    console.log('Quota check skipped: reusing an existing Foundry deployment.');
  } else {
    try {
      const location = env.FOUNDRY_LOCATION || 'swedencentral';
      const requested = requestedCapacity(readFileSync(new URL('../infra/main.bicep', import.meta.url), 'utf8'));
      const args = ['cognitiveservices', 'usage', 'list', '--location', location, '--output', 'json'];
      if (env.AZURE_SUBSCRIPTION_ID) args.push('--subscription', env.AZURE_SUBSCRIPTION_ID);
      const usage = JSON.parse(execFileSync('az', args, { encoding: 'utf8', shell: process.platform === 'win32' }));
      const result = evaluateQuota(usage, requested);
      console.log(`Decision-1 quota in ${location}: ${result.message}`);
      if (!result.ok) {
        console.error('Insufficient quota. Request more quota, choose another FOUNDRY_LOCATION, or set USE_EXISTING_FOUNDRY=true.');
        process.exitCode = 1;
      }
    } catch (error) {
      // An unreadable quota is not proof of a shortfall, so provisioning proceeds and Azure validates it.
      console.warn(`Quota check could not run and was skipped: ${error.message.split('\n')[0]}`);
    }
  }
}
