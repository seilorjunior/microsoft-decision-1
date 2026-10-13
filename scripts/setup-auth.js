import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const username = 'decisionlab';
const password = randomBytes(32).toString('base64url');
const passwordHash = createHash('sha256').update(password).digest('hex');
const loginFile = new URL('.azure/app-login.txt', root);
await mkdir(new URL('.azure/', root), { recursive: true });
await writeFile(loginFile, `Username: ${username}\nPassword: ${password}\n\nPrivate shared PoC login. Do not commit or share this file.\n`, { mode: 0o600 });

for (const [key, value] of [['APP_AUTH_USERNAME', username], ['APP_AUTH_PASSWORD_HASH', passwordHash]]) {
  execFileSync('azd', ['env', 'set', key, value], { cwd: fileURLToPath(root), stdio: ['ignore', 'ignore', 'inherit'] });
}

let localEnv;
try {
  localEnv = await readFile(new URL('.env', root), 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (localEnv !== undefined) {
  localEnv = localEnv.replace(/^APP_AUTH_(?:USERNAME|PASSWORD_HASH)=.*(?:\r?\n|$)/gm, '');
  await writeFile(new URL('.env', root), `${localEnv.trimEnd()}\nAPP_AUTH_USERNAME=${username}\nAPP_AUTH_PASSWORD_HASH=${passwordHash}\n`, { mode: 0o600 });
}
console.log(`Shared login created for ${username}. Open ${fileURLToPath(loginFile)} to read the password.`);
console.log('azd is configured with the password hash only. Restart the local app or reprovision and deploy to apply it.');
