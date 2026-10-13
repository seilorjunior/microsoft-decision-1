import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
for (const file of ['server.js', 'decision.js', 'queue.js', 'package-lock.json', 'public']) {
  await cp(new URL(`../${file}`, import.meta.url), new URL(`../dist/${file}`, import.meta.url), { recursive: true });
}
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
manifest.scripts = { start: 'node server.js' };
await writeFile(new URL('../dist/package.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
