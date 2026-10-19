import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { JobManager } from '../lib/jobs.js';
import { actionNeeded, encryptPayload, Push } from '../lib/push.js';

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

/** What the browser does with a push message (RFC 8291). */
function browserDecrypt(body, userKeys, auth) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const serverPublic = body.subarray(21, 21 + idLength);
  const ikm = hmac(
    hmac(auth, userKeys.computeSecret(serverPublic)),
    Buffer.concat([Buffer.from('WebPush: info\0'), userKeys.getPublicKey(), serverPublic, Buffer.from([1])]),
  );
  const prk = hmac(salt, ikm);
  const key = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const encrypted = body.subarray(21 + idLength);
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  return plain.subarray(0, -1).toString('utf8');
}

function browserSubscription(endpoint) {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  const auth = randomBytes(16);
  return { keys, auth, subscription: { endpoint, keys: { p256dh: keys.getPublicKey('base64url'), auth: auth.toString('base64url') } } };
}

test('encryption matches the example in RFC 8291 byte for byte', () => {
  const body = encryptPayload(
    'When I grow up, I want to be a watermelon',
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' },
  );
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});

test('push payloads decrypt the way a browser decrypts them', () => {
  const { keys, auth, subscription } = browserSubscription('https://push.example/abc');
  const body = encryptPayload('{"title":"Hällo"}', subscription.keys);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(browserDecrypt(body, keys, auth), '{"title":"Hällo"}');
});

test('only jobs that need the user produce a notification', () => {
  assert.equal(actionNeeded({ kind: 'import', state: 'finished', label: 'X', result: { imported: 2, review: 0, failed: 0 } }), null);
  assert.deepEqual(actionNeeded({ kind: 'import', state: 'finished', label: 'Dune', result: { imported: 0, review: 2, failed: 1 } }), {
    title: 'Action needed: Dune',
    body: '2 files need review · 1 file failed',
  });
  assert.deepEqual(actionNeeded({ kind: 'apply', state: 'failed', label: 'Rename 3 file(s)', error: 'disk full' }), {
    title: 'Failed: Rename 3 file(s)',
    body: 'disk full',
  });
  assert.match(actionNeeded({ kind: 'apply', state: 'finished', label: 'R', result: { renamed: 1, failed: [{}] } }).body, /1 file failed/);
  assert.equal(actionNeeded({ kind: 'apply', state: 'cancelled', label: 'R', result: { cancelled: true, renamed: 0, failed: [] } }), null);
});

test('sends signed, encrypted pushes and forgets subscriptions the push service dropped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mr-push-'));
  const sent = [];
  const push = new Push(path.join(dir, 'push.json'), {
    send: async (url, request) => {
      sent.push({ url, request });
      return { ok: !url.endsWith('/gone'), status: url.endsWith('/gone') ? 410 : 201 };
    },
  });
  const alive = browserSubscription('https://push.example/alive');
  await push.subscribe(alive.subscription);
  await push.subscribe(browserSubscription('https://push.example/gone').subscription);
  await push.subscribe(alive.subscription);
  await assert.rejects(push.subscribe({ endpoint: 'http://insecure', keys: {} }));

  await push.notify({ title: 'Action needed: X', body: '1 file needs review', url: '/' });
  assert.equal(sent.length, 2);
  const { request } = sent.find((s) => s.url.endsWith('/alive'));
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.deepEqual(JSON.parse(browserDecrypt(request.body, alive.keys, alive.auth)), { title: 'Action needed: X', body: '1 file needs review', url: '/' });

  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.Authorization);
  assert.equal(k, await push.publicKey());
  const [header, claims, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).aud, 'https://push.example');
  const raw = Buffer.from(k, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));

  const reloaded = new Push(path.join(dir, 'push.json'));
  assert.deepEqual((await reloaded.load()).subscriptions.map((s) => s.endpoint), ['https://push.example/alive']);
  assert.equal(await reloaded.publicKey(), k, 'keys survive a restart');
  await fs.rm(dir, { recursive: true, force: true });
});

test('the job queue reports every finished job', async () => {
  const finished = [];
  const manager = new JobManager();
  manager.onFinish = (job) => finished.push([job.label, job.state]);
  manager.start({ kind: 'import', root: '/a', label: 'ok', run: async () => ({ review: 1 }) });
  manager.start({ kind: 'apply', root: '/a', label: 'boom', run: async () => { throw new Error('x'); } });
  for (let i = 0; i < 100 && finished.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(finished, [['ok', 'finished'], ['boom', 'failed']]);
});
