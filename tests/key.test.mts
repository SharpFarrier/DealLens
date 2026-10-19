// Every way the private key has been seen pasted into Vercel must produce a working key.
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createVerify } from 'node:crypto';
const { normalizePrivateKey, serviceAccount } = await import('../lib/google.ts');

const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pkcs1 = kp.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const inside = JSON.stringify(pem).slice(1, -1);
const file = JSON.stringify({ type: 'service_account', client_email: 'deallens-sync@p.iam.gserviceaccount.com', private_key: pem }, null, 2);
const variants: Record<string, string> = {
  'inside quotes (correct)': inside,
  'with surrounding quotes': '"' + inside + '"',
  'with quotes and comma': '"' + inside + '",',
  'single quotes': "'" + inside + "'",
  'double-escaped \\\\n': inside.replace(/\\n/g, '\\\\n'),
  'real line breaks': pem,
  'line breaks became spaces': pem.replace(/\n/g, ' '),
  'no line breaks at all': pem.replace(/\n/g, ''),
  'escaped \\r\\n': inside.replace(/\\n/g, '\\r\\n'),
  'windows line endings': pem.replace(/\n/g, '\r\n'),
  'whole JSON file': file,
  'base64 body only': pem.split('\n').slice(1, -2).join(''),
  'leading/trailing spaces': '  ' + inside + '  \n',
  'pkcs1 RSA key': pkcs1,
};
for (const [name, v] of Object.entries(variants)) {
  const key = normalizePrivateKey(v);
  const s = createSign('RSA-SHA256'); s.update('x'); const sig = s.sign(key);
  const ver = createVerify('RSA-SHA256'); ver.update('x');
  assert.ok(ver.verify(kp.publicKey, sig), name);
}
assert.throws(() => normalizePrivateKey(''), /empty or cut short/);
assert.throws(() => normalizePrivateKey(inside.slice(0, 300)), /not a valid key/);

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = file;
const sa = serviceAccount();
assert.equal(sa.email, 'deallens-sync@p.iam.gserviceaccount.com');
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
console.log(`key tests passed: ${Object.keys(variants).length} paste forms`);
