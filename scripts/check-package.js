import { readdir } from 'node:fs/promises';
const root = new URL('../dist/', import.meta.url);
const expected = new Set(['server.js', 'decision.js', 'queue.js', 'package.json', 'package-lock.json', 'public']);
const files = await readdir(root);
if (files.length !== expected.size || files.some((file) => !expected.has(file))) throw new Error('Unexpected or missing deployment root files.');
const publicExpected = new Set(['app.js', 'index.html', 'style.css', 'login.html', 'login.js', 'contract.js', 'dataset.js']);
const publicFiles = await readdir(new URL('public/', root));
if (publicFiles.length !== publicExpected.size || publicFiles.some((file) => !publicExpected.has(file))) throw new Error('Unexpected or missing public deployment files.');
console.log('Package staging verified: required assets only; no credentials, tests, or environment files.');
