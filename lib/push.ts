import { createECDH, createHmac, createPrivateKey, createCipheriv, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import type { webcrypto } from 'node:crypto';
import { writeFileAtomic } from './fs-utils.ts';

/** The keys a browser hands out with its push subscription (base64url). */
export interface PushKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: PushKeys;
}

/** What is stored in the push file: the VAPID private key and the subscribers. */
export interface PushState {
  privateKey: webcrypto.JsonWebKey;
  subscriptions: PushSubscriptionRecord[];
}

export interface PushMessage {
  title: string;
  body: string;
}

/** The part of `fetch` that Push uses; tests pass a fake. */
export type PushSend = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer },
) => Promise<{ status: number; ok: boolean }>;

const b64url = (buffer: string | Buffer) => Buffer.from(buffer).toString('base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();
const CONTACT = 'https://github.com/mRgAmEwAtCh/media-renamer';

/** Encrypt a payload for one subscription (RFC 8291, aes128gcm). `fixed` is for the RFC's test vector only. */
export function encryptPayload(payload: string, { p256dh, auth }: PushKeys, fixed: { privateKey?: string; salt?: string } = {}): Buffer {
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

export { actionNeeded } from './job-attention.ts';

/**
 * Web push to the browsers that subscribed. Keys and subscriptions live in
 * one JSON file in the config folder.
 */
export class Push {
  file: string;
  send: PushSend;
  state: PushState | null;

  constructor(file: string, { send = fetch }: { send?: PushSend } = {}) {
    this.file = file;
    this.send = send;
    this.state = null;
  }

  async load(): Promise<PushState> {
    if (this.state) return this.state;
    try {
      // Written by save(); trusted to have the PushState shape.
      this.state = JSON.parse(await fs.readFile(this.file, 'utf8')) as PushState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`Ignoring unreadable ${this.file}: ${(error as Error).message}`);
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.state = { privateKey: privateKey.export({ format: 'jwk' }), subscriptions: [] };
      await this.save();
    }
    return this.state;
  }

  async save(): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify(this.state), { mkdir: true, mode: 0o600 });
  }

  async publicKey(): Promise<string> {
    const { privateKey: { x, y } } = await this.load();
    return b64url(Buffer.concat([Buffer.from([4]), Buffer.from(x!, 'base64url'), Buffer.from(y!, 'base64url')]));
  }

  /** `subscription` comes straight from a request body and is validated here. */
  async subscribe(subscription: unknown): Promise<void> {
    const { endpoint, keys } = (subscription ?? {}) as { endpoint?: string; keys?: Partial<PushKeys> };
    if (!/^https:\/\//.test(endpoint ?? '') || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
      throw new Error('Invalid push subscription');
    }
    const state = await this.load();
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint).concat({ endpoint: endpoint!, keys: { p256dh: keys.p256dh, auth: keys.auth } });
    await this.save();
  }

  async unsubscribe(endpoint: string): Promise<void> {
    const state = await this.load();
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== endpoint);
    await this.save();
  }

  /** Send to every subscriber; subscriptions the push service no longer knows are removed. */
  async notify(message: PushMessage & { url?: string }): Promise<void> {
    const state = await this.load();
    if (!state.subscriptions.length) return;
    const key = createPrivateKey({ key: state.privateKey, format: 'jwk' });
    const publicKey = await this.publicKey();
    const payload = JSON.stringify(message);
    const gone: string[] = [];
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
          console.error(`Push to ${audience} failed: ${(error as Error).message}`);
        }
      }),
    );
    if (gone.length) {
      state.subscriptions = state.subscriptions.filter((s) => !gone.includes(s.endpoint));
      await this.save();
    }
  }
}
