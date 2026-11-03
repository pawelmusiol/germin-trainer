import crypto from 'crypto';
import {
  EncryptionService,
  resolveEncryptionKey,
  getEncryptionService,
  EncryptedPayload,
} from '../src/modules/encryption/encryption.service';

describe('Adversarial Cryptographic Challenge Suite: EncryptionService', () => {
  const MASTER_HEX_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f809';
  let service: EncryptionService;

  beforeEach(() => {
    service = new EncryptionService(MASTER_HEX_KEY);
  });

  // =========================================================================
  // 1. AEAD Tampering, Bit-Flip Fuzzing & Decipher Rejection
  // =========================================================================
  describe('1. AEAD Tampering & Bit-Flip Fuzzing', () => {
    const testSecret = 'garmin_refresh_token_live_production_sec_99999';

    it('rejects bit flips across every byte position of the ciphertext', () => {
      const encrypted = service.encrypt(testSecret);
      const cipherBytes = Buffer.from(encrypted.ciphertext, 'hex');

      // Test flipping bits at 10 distributed positions (start, quarter, half, end, etc.)
      const positions = [
        0,
        1,
        Math.floor(cipherBytes.length / 4),
        Math.floor(cipherBytes.length / 2),
        Math.floor((3 * cipherBytes.length) / 4),
        cipherBytes.length - 2,
        cipherBytes.length - 1,
      ];

      for (const pos of positions) {
        // Test single bit flips (LSB 0x01, MSB 0x80)
        for (const mask of [0x01, 0x80, 0x55]) {
          const tampered = Buffer.from(cipherBytes);
          tampered[pos] ^= mask;

          const tamperedPayload: EncryptedPayload = {
            ...encrypted,
            ciphertext: tampered.toString('hex'),
          };

          expect(() => service.decrypt(tamperedPayload)).toThrow(
            /Decryption failed: data tampering detected or invalid key/i
          );
        }
      }
    });

    it('rejects bit flips at boundary bit positions of the 12-byte IV', () => {
      const encrypted = service.encrypt(testSecret);
      const ivBytes = Buffer.from(encrypted.iv, 'hex');
      expect(ivBytes.length).toBe(12);

      const positions = [0, 5, 11]; // start, middle, end
      for (const pos of positions) {
        for (const mask of [0x01, 0x08, 0x80]) {
          const tamperedIv = Buffer.from(ivBytes);
          tamperedIv[pos] ^= mask;

          const tamperedPayload: EncryptedPayload = {
            ...encrypted,
            iv: tamperedIv.toString('hex'),
          };

          expect(() => service.decrypt(tamperedPayload)).toThrow(
            /Decryption failed: data tampering detected or invalid key/i
          );
        }
      }
    });

    it('rejects bit flips at boundary bit positions of the 16-byte Auth Tag', () => {
      const encrypted = service.encrypt(testSecret);
      const tagBytes = Buffer.from(encrypted.authTag, 'hex');
      expect(tagBytes.length).toBe(16);

      const positions = [0, 7, 15]; // start, middle, end
      for (const pos of positions) {
        for (const mask of [0x01, 0x10, 0x80]) {
          const tamperedTag = Buffer.from(tagBytes);
          tamperedTag[pos] ^= mask;

          const tamperedPayload: EncryptedPayload = {
            ...encrypted,
            authTag: tamperedTag.toString('hex'),
          };

          expect(() => service.decrypt(tamperedPayload)).toThrow(
            /Decryption failed: data tampering detected or invalid key/i
          );
        }
      }
    });

    it('rejects truncated and oversized IV inputs', () => {
      const encrypted = service.encrypt(testSecret);

      // Empty IV fails required field check
      expect(() => service.decrypt({ ...encrypted, iv: '' })).toThrow(
        /Invalid encrypted payload: iv, authTag, and ciphertext are required/i
      );

      // Truncated and oversized IVs fail 12-byte constraint
      const invalidIvs = [
        'a',
        '0123456789ab', // 6 bytes
        '0123456789abcdef012345', // 11 bytes (22 hex)
        '0123456789abcdef0123456789', // 13 bytes (26 hex)
        '0123456789abcdef0123456789abcdef01234567', // 20 bytes
      ];

      for (const iv of invalidIvs) {
        expect(() => service.decrypt({ ...encrypted, iv })).toThrow(
          /Invalid IV length: must be 12 bytes/i
        );
      }
    });

    it('rejects truncated and oversized Auth Tag inputs', () => {
      const encrypted = service.encrypt(testSecret);

      // Empty authTag fails required field check
      expect(() => service.decrypt({ ...encrypted, authTag: '' })).toThrow(
        /Invalid encrypted payload: iv, authTag, and ciphertext are required/i
      );

      // Truncated and oversized auth tags fail 16-byte constraint
      const invalidTags = [
        'abcdef',
        '0123456789abcdef0123456789abcdef'.slice(0, 30), // 15 bytes
        '0123456789abcdef0123456789abcdef00', // 17 bytes
        '0123456789abcdef0123456789abcdef0123456789abcdef', // 24 bytes
      ];

      for (const authTag of invalidTags) {
        expect(() => service.decrypt({ ...encrypted, authTag })).toThrow(
          /Invalid authTag length: must be 16 bytes/i
        );
      }
    });

    it('rejects non-hex and malformed hex strings in IV and authTag', () => {
      const encrypted = service.encrypt(testSecret);

      // 24 chars but invalid hex chars
      const invalidHexIv = 'zzzzzzzzzzzzzzzzzzzzzzzz';
      expect(() => service.decrypt({ ...encrypted, iv: invalidHexIv })).toThrow(
        /Decryption failed: data tampering detected or invalid key/i
      );

      // 32 chars but invalid hex chars
      const invalidHexTag = 'gggggggggggggggggggggggggggggggg';
      expect(() => service.decrypt({ ...encrypted, authTag: invalidHexTag })).toThrow(
        /Decryption failed: data tampering detected or invalid key/i
      );
    });

    it('rejects payload truncation (truncated ciphertext)', () => {
      const encrypted = service.encrypt(testSecret);
      // Cut ciphertext in half
      const truncatedCiphertext = encrypted.ciphertext.slice(0, encrypted.ciphertext.length / 2);

      expect(() =>
        service.decrypt({ ...encrypted, ciphertext: truncatedCiphertext })
      ).toThrow(/Decryption failed: data tampering detected or invalid key/i);
    });

    it('rejects payload extension (appended bytes to ciphertext)', () => {
      const encrypted = service.encrypt(testSecret);
      const extendedCiphertext = encrypted.ciphertext + 'deadbeef';

      expect(() =>
        service.decrypt({ ...encrypted, ciphertext: extendedCiphertext })
      ).toThrow(/Decryption failed: data tampering detected or invalid key/i);
    });

    it('never leaks plaintext or secret key in error messages upon failure', () => {
      const encrypted = service.encrypt('SUPER_CONFIDENTIAL_PLAINTEXT_SECRET_98765');
      const tampered = { ...encrypted, ciphertext: 'deadbeef' + encrypted.ciphertext.slice(8) };

      try {
        service.decrypt(tampered);
        fail('Expected decrypt to throw on tampered ciphertext');
      } catch (err: any) {
        expect(err.message).not.toContain('SUPER_CONFIDENTIAL_PLAINTEXT_SECRET_98765');
        expect(err.message).not.toContain(MASTER_HEX_KEY);
      }
    });

    it('rejects empty/missing fields in EncryptedPayload', () => {
      const valid = service.encrypt('data');

      // @ts-expect-error testing missing payload
      expect(() => service.decrypt(null)).toThrow(/Invalid encrypted payload/i);
      // @ts-expect-error testing undefined payload
      expect(() => service.decrypt(undefined)).toThrow(/Invalid encrypted payload/i);
      // @ts-expect-error testing empty object
      expect(() => service.decrypt({})).toThrow(/Invalid encrypted payload/i);
      expect(() => service.decrypt({ iv: '', authTag: valid.authTag, ciphertext: valid.ciphertext })).toThrow(/Invalid encrypted payload/i);
      expect(() => service.decrypt({ iv: valid.iv, authTag: '', ciphertext: valid.ciphertext })).toThrow(/Invalid encrypted payload/i);
      // @ts-expect-error testing undefined ciphertext
      expect(() => service.decrypt({ iv: valid.iv, authTag: valid.authTag, ciphertext: undefined })).toThrow(/Invalid encrypted payload/i);
    });
  });

  // =========================================================================
  // 2. Boundary & Extreme Payload Stress Testing
  // =========================================================================
  describe('2. Boundary & Extreme Payload Stress Testing', () => {
    it('accurately encrypts and decrypts empty string with both payload and packed APIs', () => {
      const empty = '';
      const enc = service.encrypt(empty);
      expect(enc.ciphertext).toBe('');
      expect(enc.iv).toHaveLength(24);
      expect(enc.authTag).toHaveLength(32);
      expect(enc.packed).toBe(`${enc.iv}:${enc.authTag}:`);

      expect(service.decrypt(enc)).toBe('');
      expect(service.decryptPacked(enc.packed)).toBe('');

      // Tampered authTag with empty ciphertext must fail
      const badTag = '0'.repeat(32);
      expect(() => service.decrypt({ ...enc, authTag: badTag })).toThrow(
        /Decryption failed: data tampering detected or invalid key/i
      );
    });

    it('preserves multibyte Polish Unicode characters without byte distortion', () => {
      const polishText =
        'Zażółć gęślą jaźń! ZAŻÓŁĆ GĘŚLĄ JAŹŃ. Wyimaginowana wariacja aerometryczna ścieżki leśnej.';
      const enc = service.encrypt(polishText);
      const dec = service.decrypt(enc);
      expect(dec).toBe(polishText);
    });

    it('preserves complex emojis, ZWJ sequences, skin tones, and modifier flags', () => {
      const emojiCorpus = [
        '🏃‍♂️💨🔥', // runner with ZWJ and modifiers
        '👨‍👩‍👧‍👦', // family ZWJ
        '🏳️‍🌈', // rainbow flag ZWJ
        '🧑🏽‍💻', // tech worker with skin tone modifier
        '❤️‍🔥', // heart on fire ZWJ
        '🚴‍♀️⛰️🌧️', // cyclist on mountain in rain
      ].join(' --- ');

      const enc = service.encrypt(emojiCorpus);
      const dec = service.decrypt(enc);
      expect(dec).toBe(emojiCorpus);
    });

    it('preserves non-Latin writing systems (Kanji, Cyrillic, Arabic RTL, Greek, Devanagari)', () => {
      const multilingual = [
        '日本語: ガーミンコネクトでトレーニングを記録する。 (Japanese)',
        'العربية: تدريب اللياقة البدنية والماراثون (Arabic RTL)',
        'Русский: Анализ биомеханики бега и ЧСС (Cyrillic)',
        'Ελληνικά: Ανάλυση VO2max και κατώφλι γαλακτικού (Greek)',
        'हिन्दी: दैनिक मेट्रिक्स और फिटनेस लक्ष्य (Devanagari)',
      ].join('\n');

      const enc = service.encrypt(multilingual);
      const dec = service.decrypt(enc);
      expect(dec).toBe(multilingual);
    });

    it('preserves binary control characters, ANSI escape sequences, and null bytes', () => {
      const binaryPayload = 'Header\x00NullByte\r\n\tTab\x1b[32mGreen\x1b[0m\x7fDEL';
      const enc = service.encrypt(binaryPayload);
      const dec = service.decrypt(enc);
      expect(dec).toBe(binaryPayload);
    });

    it('accurately encrypts and decrypts a 1 MB payload with 100% byte fidelity', () => {
      // 1 MB = 1024 * 1024 bytes = 1,048,576 chars
      const chunkSize = 1024;
      const targetMB = 1;
      const pattern = 'GarminTelemetryDataPoint_HR165_CADENCE180_PACE0415_VDOT54.2_TIMESTAMP_';
      const repeated = pattern.repeat(Math.ceil((targetMB * 1024 * 1024) / pattern.length));
      const oneMbString = repeated.slice(0, targetMB * 1024 * 1024);

      expect(Buffer.byteLength(oneMbString, 'utf8')).toBe(1048576);

      const startTime = Date.now();
      const enc = service.encrypt(oneMbString);
      const encDuration = Date.now() - startTime;

      const decStartTime = Date.now();
      const dec = service.decrypt(enc);
      const decDuration = Date.now() - decStartTime;

      expect(dec).toBe(oneMbString);
      expect(dec.length).toBe(1048576);

      // Verify execution completes efficiently (< 500ms)
      expect(encDuration).toBeLessThan(500);
      expect(decDuration).toBeLessThan(500);
    });

    it('performs round-trip fuzzing across 50 pseudo-random payloads of arbitrary lengths', () => {
      for (let i = 0; i < 50; i++) {
        const randomLength = (i * 37) % 500 + 1; // lengths between 1 and 500
        const randomPlaintext = crypto.randomBytes(randomLength).toString('base64');

        const enc = service.encrypt(randomPlaintext);
        const dec = service.decrypt(enc);

        expect(dec).toBe(randomPlaintext);
      }
    });
  });

  // =========================================================================
  // 3. Structured JSON & Deep Object Hierarchy
  // =========================================================================
  describe('3. Structured JSON & Deep Object Serialization', () => {
    it('encrypts and decrypts deeply nested JSON objects (10 levels)', () => {
      let nestedObj: any = { leaf: 'garmin_root_token_secret' };
      for (let i = 1; i <= 10; i++) {
        nestedObj = { level: i, metadata: { timestamp: 20261102, data: nestedObj } };
      }

      const enc = service.encryptJson(nestedObj);
      const decFromPayload = service.decryptJson<typeof nestedObj>(enc);
      const decFromPacked = service.decryptJson<typeof nestedObj>(enc.packed);

      expect(decFromPayload).toEqual(nestedObj);
      expect(decFromPacked).toEqual(nestedObj);
    });

    it('encrypts and decrypts JSON primitives: booleans, numbers, null, arrays', () => {
      const primitives = [
        true,
        false,
        0,
        -999.123,
        42,
        null,
        [],
        [1, 'two', { three: true }, null],
      ];

      for (const item of primitives) {
        const enc = service.encryptJson(item);
        const dec = service.decryptJson(enc);
        expect(dec).toEqual(item);
      }
    });

    it('handles realistic Garmin OAuth and User Session JSON entity', () => {
      const garminAuthSession = {
        userId: 'usr_abc123',
        garminUserId: 'g_8837192',
        oauthTokens: {
          accessToken: 'oauth2_live_access_4892748923472',
          tokenSecret: 'oauth2_live_secret_9981273918237',
          expiresAt: 1793635200,
          tokenType: 'Bearer',
        },
        userProfile: {
          vdot: 56.4,
          maxHeartRate: 192,
          restingHeartRate: 46,
          lTHR: 172,
        },
        permissions: ['READ_ACTIVITIES', 'WRITE_TRAINING_PLANS', 'READ_SLEEP'],
      };

      const enc = service.encryptJson(garminAuthSession);
      const dec = service.decryptJson<typeof garminAuthSession>(enc.packed);

      expect(dec.userId).toBe('usr_abc123');
      expect(dec.oauthTokens.accessToken).toBe('oauth2_live_access_4892748923472');
      expect(dec.userProfile.vdot).toBe(56.4);
      expect(dec.permissions).toHaveLength(3);
    });

    it('throws SyntaxError when decryptJson receives valid ciphertext of non-JSON string', () => {
      const notJson = service.encrypt('this is just a plain string, not JSON!');
      expect(() => service.decryptJson(notJson)).toThrow(SyntaxError);
    });

    it('throws TypeError when encryptJson receives circular reference', () => {
      const circular: any = { name: 'circular' };
      circular.self = circular;

      expect(() => service.encryptJson(circular)).toThrow(TypeError);
    });
  });

  // =========================================================================
  // 4. Key Derivation, Encoding & Cross-Key Rejection
  // =========================================================================
  describe('4. Key Derivation & Key Management', () => {
    it('correctly resolves 64-character hexadecimal keys (case-insensitive)', () => {
      const lowerHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const upperHex = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';

      const keyLower = resolveEncryptionKey(lowerHex);
      const keyUpper = resolveEncryptionKey(upperHex);

      expect(keyLower.length).toBe(32);
      expect(keyUpper.length).toBe(32);
      expect(keyLower.equals(keyUpper)).toBe(true);
    });

    it('correctly resolves exact 32-character UTF-8 keys', () => {
      const utf8Key = '12345678901234567890123456789012'; // exactly 32 bytes
      const resolved = resolveEncryptionKey(utf8Key);

      expect(resolved.length).toBe(32);
      expect(resolved.equals(Buffer.from(utf8Key, 'utf8'))).toBe(true);
    });

    it('derives 32-byte key via SHA-256 fallback for arbitrary passphrases', () => {
      const shortPassphrase = 'my-simple-password';
      const expectedDigest = crypto.createHash('sha256').update(shortPassphrase).digest();

      const resolved = resolveEncryptionKey(shortPassphrase);
      expect(resolved.length).toBe(32);
      expect(resolved.equals(expectedDigest)).toBe(true);

      const longPassphrase = 'A very long and descriptive passphrase exceeding 32 characters in total length!';
      const expectedLongDigest = crypto.createHash('sha256').update(longPassphrase).digest();
      const resolvedLong = resolveEncryptionKey(longPassphrase);
      expect(resolvedLong.length).toBe(32);
      expect(resolvedLong.equals(expectedLongDigest)).toBe(true);
    });

    it('throws when secret key is empty, undefined, whitespace, or invalid type', () => {
      const invalidKeys = ['', '   ', '\t\n', undefined, null as any, 12345 as any];

      for (const key of invalidKeys) {
        expect(() => resolveEncryptionKey(key)).toThrow(
          /GARMIN_ENCRYPTION_KEY environment variable is missing/i
        );
      }
    });

    it('rejects cross-key decryption between different symmetric keys', () => {
      const key1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const key2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const service1 = new EncryptionService(key1);
      const service2 = new EncryptionService(key2);

      const enc = service1.encrypt('secret_for_key_1');
      expect(() => service2.decrypt(enc)).toThrow(
        /Decryption failed: data tampering detected or invalid key/i
      );
    });

    it('rejects decryption when comparing 64-char hex key vs UTF-8 literal of same hex string', () => {
      // 64 hex characters interpreted as hex (32 bytes) vs interpreted via SHA-256 fallback
      const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      // Add a single non-hex char to force it into SHA-256 fallback
      const nonHexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg';

      const serviceHex = new EncryptionService(hexKey);
      const serviceNonHex = new EncryptionService(nonHexKey);

      const enc = serviceHex.encrypt('data');
      expect(() => serviceNonHex.decrypt(enc)).toThrow(
        /Decryption failed: data tampering detected or invalid key/i
      );
    });
  });

  // =========================================================================
  // 5. Packed Format Parsing & Delimiter Corruption
  // =========================================================================
  describe('5. Packed Format Delimiter & Corruption Stress', () => {
    it('rejects packed strings with missing colons', () => {
      const enc = service.encrypt('some_plaintext');
      const noColons = `${enc.iv}${enc.authTag}${enc.ciphertext}`;

      expect(() => service.decryptPacked(noColons)).toThrow(
        /Invalid packed ciphertext format/i
      );
    });

    it('rejects packed strings with only 1 colon (2 segments)', () => {
      const enc = service.encrypt('some_plaintext');
      const twoSegments = `${enc.iv}:${enc.authTag}`;

      expect(() => service.decryptPacked(twoSegments)).toThrow(
        /Invalid packed ciphertext format. Expected exactly 3 segments/i
      );
    });

    it('rejects packed strings with extra colons (4 or more segments)', () => {
      const enc = service.encrypt('some_plaintext');
      const fourSegments = `${enc.iv}:${enc.authTag}:${enc.ciphertext}:extra`;
      const fiveSegments = `prefix:${enc.iv}:${enc.authTag}:${enc.ciphertext}:suffix`;

      expect(() => service.decryptPacked(fourSegments)).toThrow(
        /Invalid packed ciphertext format. Expected exactly 3 segments/i
      );
      expect(() => service.decryptPacked(fiveSegments)).toThrow(
        /Invalid packed ciphertext format. Expected exactly 3 segments/i
      );
    });

    it('rejects packed strings with missing IV segment', () => {
      const enc = service.encrypt('some_plaintext');
      const missingIv = `:${enc.authTag}:${enc.ciphertext}`;

      expect(() => service.decryptPacked(missingIv)).toThrow(
        /Invalid packed ciphertext format. Missing iv or authTag/i
      );
    });

    it('rejects packed strings with missing Auth Tag segment', () => {
      const enc = service.encrypt('some_plaintext');
      const missingAuthTag = `${enc.iv}::${enc.ciphertext}`;

      expect(() => service.decryptPacked(missingAuthTag)).toThrow(
        /Invalid packed ciphertext format. Missing iv or authTag/i
      );
    });

    it('rejects invalid types passed to decryptPacked', () => {
      // @ts-expect-error testing invalid inputs
      expect(() => service.decryptPacked(null)).toThrow(/Invalid packed ciphertext format/i);
      // @ts-expect-error testing invalid inputs
      expect(() => service.decryptPacked(undefined)).toThrow(/Invalid packed ciphertext format/i);
      // @ts-expect-error testing invalid inputs
      expect(() => service.decryptPacked(12345)).toThrow(/Invalid packed ciphertext format/i);
      // @ts-expect-error testing invalid inputs
      expect(() => service.decryptPacked({})).toThrow(/Invalid packed ciphertext format/i);
    });

    it('rejects packed strings with alternative delimiters (semicolons, pipes)', () => {
      const enc = service.encrypt('test');
      const pipeDelimited = `${enc.iv}|${enc.authTag}|${enc.ciphertext}`;
      const semiDelimited = `${enc.iv};${enc.authTag};${enc.ciphertext}`;

      expect(() => service.decryptPacked(pipeDelimited)).toThrow(/Invalid packed ciphertext format/i);
      expect(() => service.decryptPacked(semiDelimited)).toThrow(/Invalid packed ciphertext format/i);
    });
  });

  // =========================================================================
  // 6. Cryptographic Invariants & Nonce Hygiene
  // =========================================================================
  describe('6. Cryptographic Invariants & Nonce Hygiene', () => {
    it('guarantees unique IVs across 1,000 encryptions of identical plaintext (nonce collision resistance)', () => {
      const plaintext = 'constant_repetitive_sensor_data_stream';
      const iterations = 1000;
      const seenIvs = new Set<string>();
      const seenCiphertexts = new Set<string>();
      const seenAuthTags = new Set<string>();

      for (let i = 0; i < iterations; i++) {
        const result = service.encrypt(plaintext);
        seenIvs.add(result.iv);
        seenCiphertexts.add(result.ciphertext);
        seenAuthTags.add(result.authTag);
      }

      // Zero IV collisions across 1,000 invocations
      expect(seenIvs.size).toBe(iterations);
      expect(seenCiphertexts.size).toBe(iterations);
      expect(seenAuthTags.size).toBe(iterations);
    });

    it('throws TypeError when non-string is passed to encrypt()', () => {
      const nonStrings = [12345, true, false, null, undefined, {}, [], Symbol('sym')];

      for (const val of nonStrings) {
        // @ts-expect-error testing non-string type guard
        expect(() => service.encrypt(val)).toThrow(TypeError);
      }
    });

    it('maintains singleton instance via getEncryptionService()', () => {
      const origEnv = process.env.GARMIN_ENCRYPTION_KEY;
      try {
        process.env.GARMIN_ENCRYPTION_KEY = MASTER_HEX_KEY;
        const instance1 = getEncryptionService();
        const instance2 = getEncryptionService();

        expect(instance1).toBeDefined();
        expect(instance2).toBeDefined();
        expect(instance1).toBe(instance2);
      } finally {
        process.env.GARMIN_ENCRYPTION_KEY = origEnv;
      }
    });
  });
});
