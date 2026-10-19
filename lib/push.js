import { createECDH, createHmac, createPrivateKey, createCipheriv, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const CONTACT = 'https://github.com/mRgAmEwAtCh/media-renamer';

/** Encrypt a payload for one subscription (RFC 8291, aes128gcm). `fixed` is for the RFC's test vector only. */
export function encryptPayload(payload, { p256dh, auth }, fixed = {}) {
  const userPublic = Buffer.from(p256dh, 'base64url');
  const local = createECDH('prime256v1');
  if (fixed.privateKey) local.setPrivateKey(Buffer.from(fixed.privateKey, 'base64url'));
  const localPublic = fixed.privateKey ? local.getPublicKey() : local.generateKeys();
  const ikm = hmac(
    hmac(Buffer.from(auth, 'base64url'), local.computeSecret(userPublic)),
    Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, localPublic, Buffer.from([1])]),
  );
  const salt = fixed.salt ? Buffer.from(fixed.salt, 'base64url') : randomBytes(16);
  const prk = hmac(salt, ikm);
  const key = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = localPublic.length;
  return Buffer.concat([header, localPublic, body]);
}

/** The message for a finished job that needs the user, or null. */
export function actionNeeded(job) {
  const name = job.label ?? (job.kind === 'import' ? 'Import' : 'Rename');
  if (job.state === 'failed') return { title: `Failed: ${name}`, body: job.error ?? 'The job failed.' };
  const result = job.result ?? {};
  const failed = Array.isArray(result.failed) ? result.failed.length : (result.failed ?? 0);
  const parts = [
    result.review ? `${result.review} file${result.review === 1 ? ' needs' : 's need'} review` : '',
    failed ? `${failed} file${failed === 1 ? '' : 's'} failed` : '',
  ].filter(Boolean);
  return parts.length ? { title: `Action needed: ${name}`, body: parts.join(' · ') } : null;
}

/**
 * Web push to the browsers that subscribed. Keys and subscriptions live in
 * one JSON file in the config folder.
 */
export class Push {
  constructor(file, { send = fetch } = {}) {
    this.file = file;
    this.send = send;
    this.state = null;
  }

  async load() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Ignoring unreadable ${this.file}: ${error.message}`);
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.state = { privateKey: privateKey.export({ format: 'jwk' }), subscriptions: [] };
      await this.save();
    }
    return this.state;
  }

  async save() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  async publicKey() {
    const { privateKey: { x, y } } = await this.load();
    return b64url(Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]));
  }

  async subscribe(subscription) {
    const { endpoint, keys } = subscription ?? {};
    if (!/^https:\/\//.test(endpoint ?? '') || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
      throw new Error('Invalid push subscription');
    }
    const state = await this.load();
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint).concat({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    await this.save();
  }

  async unsubscribe(endpoint) {
    const state = await this.load();
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
    await this.save();
  }

  /** Send to every subscriber; subscriptions the push service no longer knows are removed. */
  async notify(message) {
    const state = await this.load();
    if (!state.subscriptions.length) return;
    const key = createPrivateKey({ key: state.privateKey, format: 'jwk' });
    const publicKey = await this.publicKey();
    const payload = JSON.stringify(message);
    const gone = [];
    await Promise.all(
      state.subscriptions.map(async (subscription) => {
        const audience = new URL(subscription.endpoint).origin;
        const unsigned = `${b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64url(
          JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT }),
        )}`;
        const jwt = `${unsigned}.${b64url(sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }))}`;
        try {
          const response = await this.send(subscription.endpoint, {
            method: 'POST',
            headers: {
              Authorization: `vapid t=${jwt}, k=${publicKey}`,
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: '86400',
              Urgency: 'high',
            },
            body: encryptPayload(payload, subscription.keys),
          });
          if (response.status === 404 || response.status === 410) gone.push(subscription.endpoint);
          else if (!response.ok) console.error(`Push to ${audience} failed: ${response.status}`);
        } catch (error) {
          console.error(`Push to ${audience} failed: ${error.message}`);
        }
      }),
    );
    if (gone.length) {
      state.subscriptions = state.subscriptions.filter((s) => !gone.includes(s.endpoint));
      await this.save();
    }
  }
}
