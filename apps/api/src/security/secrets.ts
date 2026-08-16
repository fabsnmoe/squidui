import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Secret storage for provider credentials (LDAP bind passwords).
 *
 * AES-256-GCM with a random 12 byte nonce. The key comes from
 * SECRET_ENCRYPTION_KEY and lives outside the database, so a database dump
 * alone does not disclose bind credentials (threat model T5).
 *
 * Encoded form: `v1.<nonce base64>.<tag base64>.<ciphertext base64>`
 */

const VERSION = 'v1';
const NONCE_BYTES = 12;

export class SecretDecryptionError extends Error {}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretDecryptionError('Stored secret has an unsupported format.');
  }
  const [, nonceText, tagText, ciphertextText] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceText ?? '', 'base64'));
    decipher.setAuthTag(Buffer.from(tagText ?? '', 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextText ?? '', 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext - never expose the underlying detail.
    throw new SecretDecryptionError(
      'Stored secret could not be decrypted. SECRET_ENCRYPTION_KEY may have changed.',
    );
  }
}
