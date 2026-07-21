import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * AES-256-GCM encryption for Twitch OAuth tokens at rest (TZ-A §1.2).
 * Key material comes from TWITCH_TOKEN_KEY env (any string — hashed to 32B).
 * Wire format: base64(iv).base64(tag).base64(ciphertext)
 */
function keyFromEnv(): Buffer {
  const raw = process.env.TWITCH_TOKEN_KEY;
  if (!raw) throw new Error('TWITCH_TOKEN_KEY is not set — cannot encrypt Twitch tokens');
  return createHash('sha256').update(raw).digest();
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromEnv(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function decryptToken(wire: string): string {
  const [ivB64, tagB64, dataB64] = wire.split('.');
  const decipher = createDecipheriv('aes-256-gcm', keyFromEnv(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
