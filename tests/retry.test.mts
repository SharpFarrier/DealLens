// 429s from Scrapingdog are retried with waits; a persistent 429 gives up before the deadline.
import assert from 'node:assert/strict';
const { sdFetch } = await import('../lib/checks.ts');
let n = 0;
globalThis.fetch = (async () => { n++; return n < 3 ? new Response('busy', { status: 429, headers: { 'retry-after': '1' } }) : new Response('{}', { status: 200 }); }) as typeof fetch;
const t0 = Date.now();
const r = await sdFetch('https://api.scrapingdog.com/x', Date.now() + 40_000);
assert.equal(r.status, 200); assert.equal(n, 3);
assert.ok(Date.now() - t0 >= 2000, 'waited between retries');
n = 0;
globalThis.fetch = (async () => { n++; return new Response('busy', { status: 429 }); }) as typeof fetch;
const r2 = await sdFetch('https://api.scrapingdog.com/x', Date.now() + 9_000);
assert.equal(r2.status, 429); assert.equal(n, 1, 'no retry when the deadline is too close');
globalThis.fetch = (async () => new Response('nf', { status: 404 })) as typeof fetch;
assert.equal((await sdFetch('https://api.scrapingdog.com/x', Date.now() + 40_000)).status, 404);
console.log('retry tests passed');
