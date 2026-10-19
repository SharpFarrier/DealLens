// Checks the service-account sign-in and sheet read against a fake Google, with a real RSA key.
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'deallens-sync@test.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = pem.replace(/\n/g, '\\n'); // as pasted into Vercel
process.env.SHEET_ID = '11UPpzvWyFdMYOasRFevpS4-rP6e8a0pOWKdW1g5vTwU';
process.env.SHEET_RANGE = 'Sheet1';

const calls: string[] = [];
let sheetStatus = 200;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  if (url === 'https://oauth2.googleapis.com/token') {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = body.get('assertion')!.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    assert.equal(claims.iss, 'deallens-sync@test.iam.gserviceaccount.com');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
    const v = createVerify('RSA-SHA256'); v.update(`${h}.${c}`);
    assert.ok(v.verify(publicKey, Buffer.from(s, 'base64url')), 'JWT signature verifies with the public key');
    return new Response(JSON.stringify({ access_token: 'tok123', expires_in: 3600 }), { status: 200 });
  }
  if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/11UPpzvWyFdMYOasRFevpS4-rP6e8a0pOWKdW1g5vTwU/values/Sheet1?')) {
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer tok123');
    if (sheetStatus !== 200) return new Response(JSON.stringify({ error: { message: 'denied' } }), { status: sheetStatus });
    return new Response(JSON.stringify({ values: [['Product Name', 'Product Description ', 'Amazon Asin', 'New Price'], ['Nova', 'Nova-Metal-Black-4x6.25', 'B0C6F83BXZ', '₹9,499.00']] }), { status: 200 });
  }
  throw new Error('unexpected fetch ' + url);
}) as typeof fetch;

const { readCatalogueSheet } = await import('../lib/google.ts');
const { parseCatalogue } = await import('../lib/logic.ts');
const values = await readCatalogueSheet();
const items = parseCatalogue(values);
assert.equal(items[0].newPrice, 9499);
await readCatalogueSheet();
assert.equal(calls.filter(c => c.includes('oauth2')).length, 1, 'token is cached between reads');
sheetStatus = 403;
await assert.rejects(readCatalogueSheet(), /isn't shared with the service account \(deallens-sync@test/);
console.log('google tests passed');
