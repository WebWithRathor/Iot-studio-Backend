import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { loadEnv } from '../../config/env.config';

/**
 * Authenticated encryption (AES-256-GCM, Node's built-in crypto) for small
 * pieces of personal data that must be recoverable — currently the IP
 * address and user agent stored with each login session.
 *
 * Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
 * Key rotation: bump the version prefix, keep the old key available for
 * decryption (ENCRYPTION_KEY_PREVIOUS) and re-encrypt lazily. Passwords are
 * NOT encrypted — they are hashed (see auth.service).
 */
const VERSION = 'v1';

function key(): Buffer {
  return Buffer.from(loadEnv().ENCRYPTION_KEY, 'base64');
}

export const encryptionService = {
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  },

  /** Returns null when the value was tampered with or encrypted with an unknown key. */
  decrypt(token: string): string | null {
    try {
      const [v, ivB, tagB, ctB] = token.split('.');
      if (v !== VERSION || !ivB || !tagB || ctB === undefined) return null;
      const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64url'));
      decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  },

  encryptJson: (v: unknown) => encryptionService.encrypt(JSON.stringify(v)),
  decryptJson<T>(token: string | null): T | null {
    if (!token) return null;
    const s = encryptionService.decrypt(token);
    if (!s) return null;
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  },

  /** Keyed hash for values we only need to correlate, never read (IPs in the audit log). */
  pseudonymise(value: string): string {
    return createHmac('sha256', key()).update(value).digest('hex').slice(0, 32);
  },
};
