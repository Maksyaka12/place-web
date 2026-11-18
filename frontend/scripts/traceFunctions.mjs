// Traces every serverless function in api/ the way Vercel does when it packages them (@vercel/nft), so a
// deployment-only failure shows up in CI. The tracer pre-evaluates some expressions: for example
// `const x = y + 1n` with an unknown `y` throws "Cannot mix BigInt and other types" and fails the deploy,
// although the code itself is fine and `vite build` passes.
//   node scripts/traceFunctions.mjs
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nodeFileTrace } from '@vercel/nft';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const functions = readdirSync(path.join(base, 'api')).filter((f) => f.endsWith('.js'));
let failed = 0;
for (const f of functions) {
  try {
    const { fileList } = await nodeFileTrace([path.join(base, 'api', f)], { base });
    console.log(`ok    api/${f} (${fileList.size} files)`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL  api/${f}: ${e.message}`);
  }
}
if (failed) {
  console.error(`${failed} function(s) would fail the Vercel build`);
  process.exit(1);
}
