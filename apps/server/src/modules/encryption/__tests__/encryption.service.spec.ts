import { EncryptionService } from '../encryption.service';

describe('EncryptionService (AES-256-GCM AEAD)', () => {
  const TEST_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  let service: EncryptionService;

  beforeEach(() => {
    service = new EncryptionService(TEST_KEY_HEX);
  });

  // E-1
  it('E-1: encrypts and decrypts with 100% round-trip fidelity and valid payload structure', () => {
    const plaintext = 'garmin_oauth_access_token_super_secret_12345';
    const encrypted = service.encrypt(plaintext);

    expect(encrypted).toHaveProperty('ciphertext');
    expect(encrypted).toHaveProperty('iv');
    expect(encrypted).toHaveProperty('authTag');
    expect(encrypted).toHaveProperty('packed');

    // 12-byte IV = 24 hex characters
    expect(encrypted.iv).toHaveLength(24);
    expect(encrypted.iv).toMatch(/^[0-9a-fA-F]{24}$/);

    // 16-byte Auth Tag = 32 hex characters
    expect(encrypted.authTag).toHaveLength(32);
    expect(encrypted.authTag).toMatch(/^[0-9a-fA-F]{32}$/);

    expect(encrypted.ciphertext.length).toBeGreaterThan(0);
    expect(encrypted.packed).toBe(`${encrypted.iv}:${encrypted.authTag}:${encrypted.ciphertext}`);

    const decrypted = service.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  // E-2
  it('E-2: generates cryptographically unique IV and distinct ciphertext for identical plaintext', () => {
    const plaintext = 'identical_plaintext_payload';
    const enc1 = service.encrypt(plaintext);
    const enc2 = service.encrypt(plaintext);

    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.authTag).not.toBe(enc2.authTag);
    expect(enc1.packed).not.toBe(enc2.packed);

    expect(service.decrypt(enc1)).toBe(plaintext);
    expect(service.decrypt(enc2)).toBe(plaintext);
  });

  // E-3
  it('E-3: serializes, encrypts, and decrypts structured JSON objects with deep equality', () => {
    const complexPayload = {
      garminUserId: 'g-user-45678',
      tokens: {
        accessToken: 'oauth2_token_xyz',
        refreshToken: 'refresh_token_uvw',
        expiresIn: 3600,
      },
      scopes: ['activity:read', 'sleep:read', 'metrics:write'],
      connectedAt: '2026-11-02T15:00:00.000Z',
      active: true,
    };

    const encrypted = service.encryptJson(complexPayload);
    const decryptedFromObj = service.decryptJson<typeof complexPayload>(encrypted);
    const decryptedFromPacked = service.decryptJson<typeof complexPayload>(encrypted.packed);

    expect(decryptedFromObj).toEqual(complexPayload);
    expect(decryptedFromPacked).toEqual(complexPayload);
    expect(decryptedFromObj.tokens.accessToken).toBe('oauth2_token_xyz');
    expect(decryptedFromObj.scopes).toHaveLength(3);
  });

  // E-4
  it('E-4: handles empty string plaintext with 0-byte ciphertext and valid 16-byte auth tag', () => {
    const encrypted = service.encrypt('');

    expect(encrypted.ciphertext).toBe('');
    expect(encrypted.iv).toHaveLength(24);
    expect(encrypted.authTag).toHaveLength(32);
    expect(encrypted.packed).toBe(`${encrypted.iv}:${encrypted.authTag}:`);

    expect(service.decrypt(encrypted)).toBe('');
    expect(service.decryptPacked(encrypted.packed)).toBe('');
  });

  // E-5
  it('E-5: preserves multibyte Unicode characters and emojis without byte corruption', () => {
    const unicodeText =
      'Polski tekst: Zażółć gęślą jaźń! 🏃‍♂️💨 VO₂ max: 54.2 ml/kg/min ❤️ Heart Rate: 175 bpm 🔥 Matrix FTMS 250W';
    const encrypted = service.encrypt(unicodeText);
    const decrypted = service.decrypt(encrypted);

    expect(decrypted).toBe(unicodeText);
    expect(decrypted.length).toBe(unicodeText.length);
  });

  // E-6
  it('E-6: encodes and decodes packed format (iv:authTag:ciphertext) accurately', () => {
    const plaintext = 'matrix_ftms_console_secret_token';
    const packed = service.encryptPacked(plaintext);

    expect(typeof packed).toBe('string');
    const parts = packed.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-fA-F]{24}$/); // IV
    expect(parts[1]).toMatch(/^[0-9a-fA-F]{32}$/); // AuthTag
    expect(parts[2]).toMatch(/^[0-9a-fA-F]+$/); // Ciphertext

    const decrypted = service.decryptPacked(packed);
    expect(decrypted).toBe(plaintext);
  });

  // E-7
  it('E-7: rejects tampered ciphertext via AEAD integrity verification', () => {
    const encrypted = service.encrypt('confidential_garmin_data');
    const lastChar = encrypted.ciphertext.slice(-1);
    const replacement = lastChar === 'a' ? 'b' : 'a';
    const tamperedCiphertext = encrypted.ciphertext.slice(0, -1) + replacement;

    expect(() =>
      service.decrypt({ ...encrypted, ciphertext: tamperedCiphertext })
    ).toThrow(/Decryption failed|unable to authenticate/i);
  });

  // E-8
  it('E-8: rejects tampered authentication tag', () => {
    const encrypted = service.encrypt('confidential_garmin_data');
    const firstChar = encrypted.authTag[0];
    const tamperedTag = (firstChar === '0' ? '1' : '0') + encrypted.authTag.slice(1);

    expect(() =>
      service.decrypt({ ...encrypted, authTag: tamperedTag })
    ).toThrow(/Decryption failed|unable to authenticate/i);
  });

  // E-9
  it('E-9: rejects tampered initialization vector (IV)', () => {
    const encrypted = service.encrypt('confidential_garmin_data');
    const firstChar = encrypted.iv[0];
    const tamperedIv = (firstChar === '0' ? '1' : '0') + encrypted.iv.slice(1);

    expect(() =>
      service.decrypt({ ...encrypted, iv: tamperedIv })
    ).toThrow(/Decryption failed|unable to authenticate/i);
  });

  // E-10
  it('E-10: rejects decryption when key does not match', () => {
    const keyA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const keyB = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const serviceA = new EncryptionService(keyA);
    const serviceB = new EncryptionService(keyB);

    const encrypted = serviceA.encrypt('data_for_user_a');
    expect(() => serviceB.decrypt(encrypted)).toThrow(/Decryption failed|unable to authenticate/i);
  });

  // E-11
  it('E-11: rejects malformed packed string representations', () => {
    const malformedInputs = [
      'not-a-valid-packed-string',
      'part1:part2',
      'part1:part2:part3:part4',
      '',
      '::',
    ];

    for (const input of malformedInputs) {
      expect(() => service.decryptPacked(input)).toThrow(
        /Invalid packed ciphertext format/i
      );
    }
  });

  // E-12
  it('E-12: throws when secret key is missing or empty', () => {
    expect(() => new EncryptionService('')).toThrow(
      /GARMIN_ENCRYPTION_KEY environment variable is missing/i
    );
  });

  // E-13
  it('E-13: handles large payload (100 KB string) round-trip with byte integrity', () => {
    const largeChunk = 'GarminActivityTimeSeriesDataPoint_'.repeat(3000); // ~105 KB
    const encrypted = service.encrypt(largeChunk);
    const decrypted = service.decrypt(encrypted);

    expect(decrypted).toBe(largeChunk);
    expect(decrypted.length).toBe(largeChunk.length);
  });
});
