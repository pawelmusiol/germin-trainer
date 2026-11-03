import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { getJwtSecret, generateToken, authenticateJwt } from '../src/middlewares/auth.middleware';
import { UserRole } from '@garmin-trainer/shared';

// Setup test secret environment
const TEST_JWT_SECRET = 'test-challenge-jwt-secret-key-min-32-chars-long!';
process.env.JWT_SECRET = TEST_JWT_SECRET;
process.env.JWT_EXPIRES_IN = '7d';

interface MockUser {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  createdAt: Date;
  updatedAt: Date;
}

function createMockPrismaClient() {
  const users: MockUser[] = [];

  return {
    _users: users,
    user: {
      findUnique: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) {
          return users.find((u) => u.email.toLowerCase() === where.email?.toLowerCase()) || null;
        }
        if (where.id) {
          return users.find((u) => u.id === where.id) || null;
        }
        return null;
      }),
      create: jest.fn(async ({ data }: { data: any }) => {
        const normalized = data.email.toLowerCase().trim();
        const existing = users.find((u) => u.email === normalized);
        if (existing) {
          const err: any = new Error('Unique constraint failed on the fields: (`email`)');
          err.code = 'P2002';
          throw err;
        }
        const record: MockUser = {
          id: `cuid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          email: normalized,
          passwordHash: data.passwordHash,
          name: data.name ?? null,
          role: data.role ?? 'USER',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.push(record);
        return record;
      }),
      findFirst: jest.fn(async () => null),
    },
  };
}

describe('Challenger M3-2: Adversarial Authentication & JWT Security Suite', () => {
  let mockPrisma: ReturnType<typeof createMockPrismaClient>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    mockPrisma = createMockPrismaClient();
    app = createApp(mockPrisma as any);
  });

  // ===========================================================================
  // 1. Registration Input Validation & Adversarial Payloads
  // ===========================================================================
  describe('1. Registration Adversarial Validation', () => {
    it('SEC-REG-1: rejects empty request body or missing email/password with 400', async () => {
      const resEmpty = await request(app).post('/api/auth/register').send({});
      expect(resEmpty.status).toBe(400);
      expect(resEmpty.body).toHaveProperty('error');

      const resNoPassword = await request(app)
        .post('/api/auth/register')
        .send({ email: 'runner@example.com' });
      expect(resNoPassword.status).toBe(400);
      expect(resNoPassword.body.error).toMatch(/password.*required/i);

      const resNoEmail = await request(app)
        .post('/api/auth/register')
        .send({ password: 'ValidPassword123!' });
      expect(resNoEmail.status).toBe(400);
      expect(resNoEmail.body.error).toMatch(/email.*required/i);
    });

    it('SEC-REG-2: rejects non-string and injection email payloads with 400', async () => {
      const invalidEmailTypes = [
        12345,
        true,
        false,
        { email: 'injected' },
        ['email@example.com'],
        null,
      ];

      for (const badEmail of invalidEmailTypes) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ email: badEmail, password: 'ValidPassword123!' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/email/i);
      }
    });

    it('SEC-REG-3: rejects RFC-noncompliant and malformed email patterns', async () => {
      const malformedEmails = [
        'plainaddress',
        '@missing-local.com',
        'missing-tld@domain',
        'spaces in@domain.com',
        'two@@domain.com',
      ];

      for (const badEmail of malformedEmails) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ email: badEmail, password: 'ValidPassword123!' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid email format/i);
      }
    });

    it('SEC-REG-4: defends against SQL/NoSQL injection fragments in email input', async () => {
      const injectionEmails = [
        "' OR '1'='1",
        "admin'--",
        "test@example.com'; DROP TABLE \"User\";--",
        '{"$gt": ""}',
      ];

      for (const injection of injectionEmails) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ email: injection, password: 'ValidPassword123!' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/email/i);
      }
    });

    it('SEC-REG-5: normalizes email casing and trims leading/trailing whitespace', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: '  Marathon.Runner+Test@Example.COM  ',
          password: 'ValidPassword123!',
          name: 'Paced Athlete',
        });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('marathon.runner+test@example.com');

      const savedUser = mockPrisma._users.find(
        (u) => u.email === 'marathon.runner+test@example.com'
      );
      expect(savedUser).toBeDefined();
      expect(savedUser?.email).toBe('marathon.runner+test@example.com');
    });

    it('SEC-REG-6: rejects duplicate registration across casing variations with 409', async () => {
      const firstRes = await request(app)
        .post('/api/auth/register')
        .send({ email: 'ironman@triathlon.org', password: 'FirstPassword123!' });
      expect(firstRes.status).toBe(201);

      // Attempt duplicate with uppercase domain and localpart
      const dupRes = await request(app)
        .post('/api/auth/register')
        .send({ email: 'IronMan@TRIATHLON.ORG', password: 'SecondPassword123!' });
      expect(dupRes.status).toBe(409);
      expect(dupRes.body.error).toMatch(/already registered/i);
    });

    it('SEC-REG-7: enforces strict password length boundary (min 8 chars, max 128 chars)', async () => {
      // 7 characters: boundary fail
      const res7 = await request(app)
        .post('/api/auth/register')
        .send({ email: 'pass7@example.com', password: '1234567' });
      expect(res7.status).toBe(400);
      expect(res7.body.error).toMatch(/at least 8 characters/i);

      // 8 characters: boundary pass
      const res8 = await request(app)
        .post('/api/auth/register')
        .send({ email: 'pass8@example.com', password: '12345678' });
      expect(res8.status).toBe(201);

      // 128 characters: boundary pass
      const pass128 = 'a'.repeat(128);
      const res128 = await request(app)
        .post('/api/auth/register')
        .send({ email: 'pass128@example.com', password: pass128 });
      expect(res128.status).toBe(201);

      // 129 characters: boundary fail
      const pass129 = 'a'.repeat(129);
      const res129 = await request(app)
        .post('/api/auth/register')
        .send({ email: 'pass129@example.com', password: pass129 });
      expect(res129.status).toBe(400);
      expect(res129.body.error).toMatch(/cannot exceed 128 characters/i);
    });

    it('SEC-REG-8: rejects non-string password inputs (numbers, booleans, objects, arrays)', async () => {
      const badPasswords = [12345678, true, false, { pass: '12345678' }, ['password123']];

      for (const badPass of badPasswords) {
        const res = await request(app)
          .post('/api/auth/register')
          .send({ email: 'nonstring@example.com', password: badPass });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/password/i);
      }
    });

    it('SEC-REG-9: rejects unauthorized or unrecognized role assignment attempts', async () => {
      const unauthorizedRoles = ['SUPERADMIN', 'MODERATOR', 'ROOT', 'HACKER', 1, false];

      for (const badRole of unauthorizedRoles) {
        const res = await request(app).post('/api/auth/register').send({
          email: `role_${Math.random().toString(36).slice(2, 6)}@example.com`,
          password: 'ValidPassword123!',
          role: badRole,
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid role/i);
      }
    });

    it('SEC-REG-10: correctly assigns valid roles (USER default, ADMIN explicitly)', async () => {
      const resDefault = await request(app)
        .post('/api/auth/register')
        .send({ email: 'defaultrole@example.com', password: 'ValidPassword123!' });
      expect(resDefault.status).toBe(201);
      expect(resDefault.body.user.role).toBe('USER');

      const resAdmin = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'adminrole@example.com',
          password: 'ValidPassword123!',
          role: UserRole.ADMIN,
        });
      expect(resAdmin.status).toBe(201);
      expect(resAdmin.body.user.role).toBe('ADMIN');
    });

    it('SEC-REG-11: guarantees passwordHash is NEVER leaked in registration response', async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'leak_check_reg@example.com',
        password: 'TopSecretPassword99!',
        name: 'Leak Test Runner',
      });

      expect(res.status).toBe(201);
      const resString = JSON.stringify(res.body);
      expect(resString).not.toContain('passwordHash');
      expect(resString).not.toContain('TopSecretPassword99!');
      expect(res.body.user.passwordHash).toBeUndefined();
    });
  });

  // ===========================================================================
  // 2. Bcrypt Cryptographic Hashing Verification
  // ===========================================================================
  describe('2. Bcrypt Hash Format & Strength Verification', () => {
    it('SEC-BCRYPT-1: verifies bcrypt hash format ($2a$ or $2b$) and cost factor 10', async () => {
      const rawPassword = 'CryptographicCheck123!';
      const res = await request(app).post('/api/auth/register').send({
        email: 'bcrypt_audit@example.com',
        password: rawPassword,
      });
      expect(res.status).toBe(201);

      const record = mockPrisma._users.find((u) => u.email === 'bcrypt_audit@example.com');
      expect(record).toBeDefined();

      // Standard modular crypt format for bcrypt: $2[abxy]$[cost]$[22 salt chars][31 hash chars] = 60 chars
      const bcryptRegex = /^\$2[abxy]\$10\$[./A-Za-z0-9]{53}$/;
      expect(record!.passwordHash).toMatch(bcryptRegex);
      expect(record!.passwordHash.length).toBe(60);

      // Verify cost factor is exactly 10
      const costSegment = record!.passwordHash.split('$')[2];
      expect(costSegment).toBe('10');
    });

    it('SEC-BCRYPT-2: verifies independent registrations with identical passwords yield distinct hashes', async () => {
      const sharedPassword = 'IdenticalPassword123!';

      await request(app).post('/api/auth/register').send({
        email: 'twin1@example.com',
        password: sharedPassword,
      });

      await request(app).post('/api/auth/register').send({
        email: 'twin2@example.com',
        password: sharedPassword,
      });

      const user1 = mockPrisma._users.find((u) => u.email === 'twin1@example.com');
      const user2 = mockPrisma._users.find((u) => u.email === 'twin2@example.com');

      expect(user1).toBeDefined();
      expect(user2).toBeDefined();
      expect(user1!.passwordHash).not.toBe(user2!.passwordHash);

      // Both should verify against the same plaintext password
      expect(await bcrypt.compare(sharedPassword, user1!.passwordHash)).toBe(true);
      expect(await bcrypt.compare(sharedPassword, user2!.passwordHash)).toBe(true);
    });

    it('SEC-BCRYPT-3: rejects verification of incorrect or single-bit altered password', async () => {
      const truePassword = 'StrictPasswordVerification99!';
      await request(app).post('/api/auth/register').send({
        email: 'bitcheck@example.com',
        password: truePassword,
      });

      const user = mockPrisma._users.find((u) => u.email === 'bitcheck@example.com');
      expect(user).toBeDefined();

      expect(await bcrypt.compare(truePassword, user!.passwordHash)).toBe(true);
      expect(await bcrypt.compare(truePassword + 'x', user!.passwordHash)).toBe(false);
      expect(await bcrypt.compare('strictpasswordverification99!', user!.passwordHash)).toBe(false);
    });
  });

  // ===========================================================================
  // 3. Login Credential Defense & Enumeration Prevention
  // ===========================================================================
  describe('3. Login Credential Defense & Timing-Safe Responses', () => {
    const registeredEmail = 'existing.athlete@runner.com';
    const registeredPass = 'CorrectPassword123!';

    beforeEach(async () => {
      await request(app).post('/api/auth/register').send({
        email: registeredEmail,
        password: registeredPass,
        name: 'Existing Athlete',
      });
    });

    it('SEC-LOGIN-1: rejects missing or non-string credentials with 400', async () => {
      const badLogins = [
        {},
        { email: registeredEmail },
        { password: registeredPass },
        { email: 12345, password: registeredPass },
        { email: registeredEmail, password: true },
        { email: '', password: '' },
      ];

      for (const payload of badLogins) {
        const res = await request(app).post('/api/auth/login').send(payload);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/email and password are required/i);
      }
    });

    it('SEC-LOGIN-2: produces identical timing-safe error message for non-existent email and wrong password', async () => {
      // 1. Non-existent email
      const resNonExistent = await request(app).post('/api/auth/login').send({
        email: 'ghost.user.never.exists@runner.com',
        password: 'AnyPassword123!',
      });
      expect(resNonExistent.status).toBe(401);
      expect(resNonExistent.body).toEqual({ error: 'Invalid email or password' });

      // 2. Existing email with incorrect password
      const resWrongPassword = await request(app).post('/api/auth/login').send({
        email: registeredEmail,
        password: 'CompletelyWrongPassword123!',
      });
      expect(resWrongPassword.status).toBe(401);
      expect(resWrongPassword.body).toEqual({ error: 'Invalid email or password' });

      // Crucial: The error response MUST be strictly indistinguishable to prevent user enumeration
      expect(resNonExistent.body.error).toBe(resWrongPassword.body.error);
    });

    it('SEC-LOGIN-3: supports case-insensitive login email matching', async () => {
      const uppercaseRes = await request(app).post('/api/auth/login').send({
        email: 'EXISTING.ATHLETE@RUNNER.COM',
        password: registeredPass,
      });
      expect(uppercaseRes.status).toBe(200);
      expect(uppercaseRes.body).toHaveProperty('token');
      expect(uppercaseRes.body.user.email).toBe(registeredEmail);

      const mixedCaseRes = await request(app).post('/api/auth/login').send({
        email: 'Existing.Athlete@Runner.Com',
        password: registeredPass,
      });
      expect(mixedCaseRes.status).toBe(200);
      expect(mixedCaseRes.body).toHaveProperty('token');
    });

    it('SEC-LOGIN-4: guarantees passwordHash is NEVER leaked in login response', async () => {
      const res = await request(app).post('/api/auth/login').send({
        email: registeredEmail,
        password: registeredPass,
      });

      expect(res.status).toBe(200);
      const resString = JSON.stringify(res.body);
      expect(resString).not.toContain('passwordHash');
      expect(resString).not.toContain(registeredPass);
      expect(res.body.user.passwordHash).toBeUndefined();
    });
  });

  // ===========================================================================
  // 4. JWT Middleware Adversarial Stress & Token Tampering
  // ===========================================================================
  describe('4. JWT Middleware Adversarial Stress & Token Tampering', () => {
    let validToken: string;
    let registeredUser: MockUser;

    beforeEach(async () => {
      const res = await request(app).post('/api/auth/register').send({
        email: 'jwt.target@challenge.com',
        password: 'ValidJwtPassword123!',
        name: 'JWT Challenge Runner',
        role: UserRole.USER,
      });
      expect(res.status).toBe(201);
      validToken = res.body.token;
      registeredUser = mockPrisma._users.find((u) => u.email === 'jwt.target@challenge.com')!;
    });

    it('SEC-JWT-1: validates and accepts authentic Bearer token on GET /api/auth/me', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(registeredUser.id);
      expect(res.body.user.email).toBe(registeredUser.email);
      expect(res.body.user.passwordHash).toBeUndefined();
    });

    it('SEC-JWT-2: rejects signature tampering (flipped signature bits) with 401', async () => {
      const parts = validToken.split('.');
      expect(parts.length).toBe(3);

      // Flip characters in the signature (3rd segment)
      const tamperedSignature =
        parts[2].slice(0, -4) + (parts[2].endsWith('a') ? 'b' : 'a') + 'xyz';
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tamperedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid or tampered authentication token/i);
    });

    it('SEC-JWT-3: rejects payload tampering (e.g. elevating role to ADMIN without resign) with 401', async () => {
      const parts = validToken.split('.');
      const decodedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));

      // Privilege escalation attempt: tamper payload to ADMIN
      decodedPayload.role = 'ADMIN';
      const tamperedPayloadB64 = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
      const tamperedToken = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${tamperedToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid or tampered authentication token/i);
    });

    it('SEC-JWT-4: rejects token signed with an unauthorized external secret with 401', async () => {
      const attackerSecret = 'malicious-attacker-secret-key-1234567890!';
      const rogueToken = jwt.sign(
        { userId: registeredUser.id, email: registeredUser.email, role: 'ADMIN' },
        attackerSecret,
        { algorithm: 'HS256', expiresIn: '1h' }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${rogueToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid or tampered authentication token/i);
    });

    it('SEC-JWT-5: rejects "alg": "none" token attack with 401', async () => {
      // Forge an unsigned token with alg: none
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ userId: registeredUser.id, email: registeredUser.email, role: 'ADMIN' })
      ).toString('base64url');
      const unsignedNoneToken = `${header}.${payload}.`;

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${unsignedNoneToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid or tampered authentication token/i);
    });

    it('SEC-JWT-6: rejects expired tokens with explicit 401 "Token has expired"', async () => {
      const expiredToken = jwt.sign(
        { userId: registeredUser.id, email: registeredUser.email, role: 'USER' },
        process.env.JWT_SECRET!,
        { expiresIn: '-10s', algorithm: 'HS256' }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Token has expired' });
    });

    it('SEC-JWT-7: rejects missing Authorization header with 401', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Missing or malformed Authorization header' });
    });

    it('SEC-JWT-8: rejects malformed Authorization headers and non-Bearer schemes', async () => {
      const malformedHeaders = [
        '',
        '   ',
        'Bearer',
        'Bearer ',
        'Bearer   ',
        `Token ${validToken}`,
        `Basic ${Buffer.from('user:pass').toString('base64')}`,
        validToken, // Raw token without Bearer prefix
        'Bearer null',
        'Bearer undefined',
        'Bearer not-a-jwt',
      ];

      for (const authHeader of malformedHeaders) {
        const reqBuilder = request(app).get('/api/auth/me');
        if (authHeader !== '') {
          reqBuilder.set('Authorization', authHeader);
        }
        const res = await reqBuilder;
        expect(res.status).toBe(401);
      }
    });

    it('SEC-JWT-9: handles user deleted from database (valid token, missing DB record) with 404', async () => {
      const ghostUserId = 'deleted-cuid-999';
      const ghostToken = jwt.sign(
        { userId: ghostUserId, email: 'ghost@challenge.com', role: 'USER' },
        process.env.JWT_SECRET!,
        { algorithm: 'HS256', expiresIn: '1h' }
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${ghostToken}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'User not found' });
    });

    it('SEC-JWT-10: enforces getJwtSecret production security check', () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.JWT_SECRET;

      try {
        process.env.NODE_ENV = 'production';
        delete process.env.JWT_SECRET;

        expect(() => getJwtSecret()).toThrow(/JWT_SECRET environment variable is missing/i);
      } finally {
        process.env.NODE_ENV = originalEnv;
        process.env.JWT_SECRET = originalSecret;
      }
    });
  });
});
