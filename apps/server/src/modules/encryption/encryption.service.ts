import crypto from 'crypto';
import type { EncryptedPayload, EncryptedResult } from '@garmin-trainer/shared';

export type { EncryptedPayload, EncryptedResult };

export interface IEncryptionService {
  encrypt(plaintext: string): EncryptedResult;
  decrypt(payload: EncryptedPayload): string;
  encryptPacked(plaintext: string): string;
  decryptPacked(packed: string): string;
  encryptJson<T>(data: T): EncryptedResult;
  decryptJson<T>(payload: EncryptedPayload | string): T;
}

/**
 * Resolves a 256-bit (32-byte) binary symmetric key from a raw input string.
 * Supports:
 * - 64-character hexadecimal string (standard 256-bit hex encoding)
 * - 32-byte UTF-8 string
 * - Fallback: SHA-256 digest of arbitrary passphrase
 */
export function resolveEncryptionKey(rawKey?: string): Buffer {
  if (!rawKey || typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new Error('GARMIN_ENCRYPTION_KEY environment variable is missing');
  }

  // 64-character hexadecimal string (256 bits)
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  const utf8Buf = Buffer.from(rawKey, 'utf8');
  if (utf8Buf.length === 32) {
    return utf8Buf;
  }

  // Fallback: derive 32-byte key via SHA-256 hash of provided passphrase
  return crypto.createHash('sha256').update(rawKey).digest();
}

/**
 * AES-256-GCM Authenticated Encryption Service.
 * Implements AEAD (Authenticated Encryption with Associated Data) with:
 * - Algorithm: aes-256-gcm
 * - 12-byte (96-bit) cryptographically random IV generated per operation
 * - 16-byte (128-bit) GCM authentication tag for tamper detection
 * - 256-bit symmetric key derived from GARMIN_ENCRYPTION_KEY
 */
export class EncryptionService implements IEncryptionService {
  private readonly key: Buffer;
  private readonly algorithm = 'aes-256-gcm';

  constructor(secretKey: string = process.env.GARMIN_ENCRYPTION_KEY || '') {
    this.key = resolveEncryptionKey(secretKey);
  }

  /**
   * Encrypts a plaintext string using AES-256-GCM.
   * Generates a fresh 12-byte random IV for each invocation.
   * Returns an EncryptedResult with hex-encoded ciphertext, iv, authTag, and packed string.
   */
  public encrypt(plaintext: string): EncryptedResult {
    if (typeof plaintext !== 'string') {
      throw new TypeError('Plaintext must be a string');
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

    let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
    ciphertext += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');
    const ivHex = iv.toString('hex');

    return {
      ciphertext,
      iv: ivHex,
      authTag,
      packed: `${ivHex}:${authTag}:${ciphertext}`,
    };
  }

  /**
   * Decrypts an EncryptedPayload and verifies the cryptographic authentication tag.
   * Throws an error if any bit of ciphertext, IV, or authTag was tampered with, or if the key is invalid.
   */
  public decrypt(payload: EncryptedPayload): string {
    if (
      !payload ||
      !payload.iv ||
      !payload.authTag ||
      payload.ciphertext === undefined ||
      payload.ciphertext === null
    ) {
      throw new Error('Invalid encrypted payload: iv, authTag, and ciphertext are required');
    }

    try {
      const iv = Buffer.from(payload.iv, 'hex');
      const tag = Buffer.from(payload.authTag, 'hex');

      if (iv.length !== 12) {
        throw new Error('Invalid IV length: must be 12 bytes');
      }
      if (tag.length !== 16) {
        throw new Error('Invalid authTag length: must be 16 bytes');
      }

      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (err: any) {
      throw new Error(`Decryption failed: data tampering detected or invalid key (${err.message})`);
    }
  }

  /**
   * Encrypts plaintext string into a single packed string: "iv:authTag:ciphertext".
   */
  public encryptPacked(plaintext: string): string {
    return this.encrypt(plaintext).packed;
  }

  /**
   * Decrypts a packed string formatted as "iv:authTag:ciphertext".
   */
  public decryptPacked(packed: string): string {
    if (typeof packed !== 'string' || !packed.includes(':')) {
      throw new Error('Invalid packed ciphertext format. Expected iv:authTag:ciphertext');
    }

    const parts = packed.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid packed ciphertext format. Expected exactly 3 segments');
    }

    const [iv, authTag, ciphertext] = parts;
    if (!iv || !authTag) {
      throw new Error('Invalid packed ciphertext format. Missing iv or authTag');
    }

    return this.decrypt({ iv, authTag, ciphertext });
  }

  /**
   * Serializes a generic object to JSON and encrypts it using AES-256-GCM.
   */
  public encryptJson<T>(data: T): EncryptedResult {
    const jsonString = JSON.stringify(data);
    return this.encrypt(jsonString);
  }

  /**
   * Decrypts an EncryptedPayload or packed string and parses the resulting UTF-8 string as JSON.
   */
  public decryptJson<T>(payload: EncryptedPayload | string): T {
    const jsonString =
      typeof payload === 'string' ? this.decryptPacked(payload) : this.decrypt(payload);
    return JSON.parse(jsonString) as T;
  }
}

/**
 * Default singleton instance factory for lazy initialization.
 */
let defaultEncryptionServiceInstance: EncryptionService | null = null;

export function getEncryptionService(): EncryptionService {
  if (!defaultEncryptionServiceInstance) {
    defaultEncryptionServiceInstance = new EncryptionService();
  }
  return defaultEncryptionServiceInstance;
}
