import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const outfile = 'extension/app.js';

await build({
  entryPoints: ['src/extension/app.mjs'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome114'],
  outfile,
  legalComments: 'none',
  logLevel: 'info'
});

const source = await readFile('src/extension/app.mjs', 'utf8');
const protocol = await readFile('src/protocol.mjs', 'utf8');
if (/exportPassphrase\s*\(/.test(source) || /exportPassphrase\s*\(/.test(protocol)) {
  throw new Error('extension source calls exportPassphrase');
}
if (source.includes('keeta.com/wallet/seed/v1') && !source.includes('FORBIDDEN_SALT_LABEL')) {
  throw new Error('wallet salt used without a refusal');
}

console.log('built', outfile);
