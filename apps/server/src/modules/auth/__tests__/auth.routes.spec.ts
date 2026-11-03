import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createApp } from '../../../app';

// Set test environment configuration
process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.JWT_EXPIRES_IN = '7d';
process.env.GARMIN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// In-memory mock store for Prisma User model
interface MockUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  createdAt: Date;
  updatedAt: Date;
}

let mockUsers: MockUserRecord[] = [];

// Intercept apps/server/src/db.ts
jest.mock('../../../db', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) {
          return (
            mockUsers.find((u) => u.email.toLowerCase() === where.email?.toLowerCase()) || null
          );
        }
        if (where.id) {
          return mockUsers.find((u) => u.id === where.id) || null;
        }
        return null;
      }),
      create: jest.fn(async ({ data }: { data: any }) => {
        const existing = mockUsers.find(
          (u) => u.email.toLowerCase() === data.email.toLowerCase()
        );
        if (existing) {
          const err: any = new Error('Unique constraint failed on the fields: (`email`)');
          err.code = 'P2002';
          throw err;
        }
        const record: MockUserRecord = {
          id: `cuid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          email: data.email.toLowerCase().trim(),
          passwordHash: data.passwordHash,
          name: data.name ?? null,
          role: data.role ?? 'USER',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockUsers.push(record);
        return record;
      }),
      findFirst: jest.fn(async () => null),
    },
  },
  default: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

describe('Authentication & JWT Middleware Integration Suite (/api/auth)', () => {
  const app = createApp();

  beforeEach(() => {
    mockUsers = [];
    jest.clearAllMocks();
  });

  // A-1
  it('A-1: registers a new user with valid credentials, returning 201, user profile, and JWT', async () => {
    const payload = {
      email: 'runner@example.com',
      password: 'StrongPassword123!',
      name: 'Jan Kowalski',
    };

    const res = await request(app).post('/api/auth/register').send(payload);

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user).toMatchObject({
      email: 'runner@example.com',
      name: 'Jan Kowalski',
      role: 'USER',
    });
    expect(res.body.user.id).toBeDefined();
    expect(res.body.user.passwordHash).toBeUndefined(); // Never leak passwordHash
    expect(res.body).toHaveProperty('token');
    expect(typeof res.body.token).toBe('string');
  });

  // A-2
  it('A-2: securely hashes user password with bcrypt before database persistence', async () => {
    const rawPassword = 'SecretRunnerPassword99!';
    const payload = {
      email: 'bcrypt_check@example.com',
      password: rawPassword,
      name: 'Security Athlete',
    };

    const res = await request(app).post('/api/auth/register').send(payload);
    expect(res.status).toBe(201);

    const storedUser = mockUsers.find((u) => u.email === 'bcrypt_check@example.com');
    expect(storedUser).toBeDefined();
    expect(storedUser!.passwordHash).not.toBe(rawPassword);
    expect(storedUser!.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);

    const isMatch = await bcrypt.compare(rawPassword, storedUser!.passwordHash);
    expect(isMatch).toBe(true);

    const isMismatch = await bcrypt.compare('WrongPassword123!', storedUser!.passwordHash);
    expect(isMismatch).toBe(false);
  });

  // A-3
  it('A-3: rejects duplicate email registration with 409 Conflict', async () => {
    mockUsers.push({
      id: 'existing-cuid-1',
      email: 'existing@example.com',
      passwordHash: await bcrypt.hash('ExistingPassword123!', 10),
      name: 'Existing Runner',
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).post('/api/auth/register').send({
      email: 'Existing@Example.com', // Casing variation
      password: 'NewPassword123!',
    });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/already registered|already in use/i);
  });

  // A-4
  it('A-4: rejects registration with invalid email format with 400 Bad Request', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'invalid-email-address',
      password: 'StrongPassword123!',
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/email/i);
  });

  // A-5
  it('A-5: rejects registration with short password (< 8 chars) with 400 Bad Request', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'runner@example.com',
      password: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/password.*8.*character/i);
  });

  // A-6
  it('A-6: logs in user with valid credentials, returning 200, profile, and JWT', async () => {
    const rawPassword = 'ValidPassword123!';
    const passwordHash = await bcrypt.hash(rawPassword, 10);
    mockUsers.push({
      id: 'login-user-cuid',
      email: 'login@example.com',
      passwordHash,
      name: 'Login Athlete',
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'login@example.com',
      password: rawPassword,
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.id).toBe('login-user-cuid');
    expect(res.body.user.email).toBe('login@example.com');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  // A-7
  it('A-7: rejects login attempt with incorrect password with 401 Unauthorized', async () => {
    mockUsers.push({
      id: 'login-user-cuid',
      email: 'login@example.com',
      passwordHash: await bcrypt.hash('CorrectPassword123!', 10),
      name: 'Login Athlete',
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'login@example.com',
      password: 'IncorrectPassword999!',
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid email or password' });
  });

  // A-8
  it('A-8: rejects login attempt with non-existent email with 401 Unauthorized', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'nonexistent@example.com',
      password: 'AnyPassword123!',
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid email or password' });
  });

  // A-9
  it('A-9: verifies issued JWT token claims (userId, email, role) and future expiration', async () => {
    const rawPassword = 'VerifyJwtPassword123!';
    const userRecord: MockUserRecord = {
      id: 'jwt-user-cuid-99',
      email: 'jwt_verify@example.com',
      passwordHash: await bcrypt.hash(rawPassword, 10),
      name: 'JWT Verifier',
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockUsers.push(userRecord);

    const res = await request(app).post('/api/auth/login').send({
      email: 'jwt_verify@example.com',
      password: rawPassword,
    });

    expect(res.status).toBe(200);
    const token = res.body.token;

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    expect(decoded.userId).toBe(userRecord.id);
    expect(decoded.email).toBe(userRecord.email);
    expect(decoded.role).toBe('USER');
    expect(typeof decoded.exp).toBe('number');
    const nowInSeconds = Math.floor(Date.now() / 1000);
    expect(decoded.exp).toBeGreaterThan(nowInSeconds);
  });

  // A-10
  it('A-10: returns authenticated user profile on GET /api/auth/me with valid Bearer token', async () => {
    const userRecord: MockUserRecord = {
      id: 'me-user-cuid',
      email: 'me@example.com',
      passwordHash: await bcrypt.hash('Password123!', 10),
      name: 'Me Athlete',
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockUsers.push(userRecord);

    const token = jwt.sign(
      { userId: userRecord.id, email: userRecord.email, role: userRecord.role },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('user');
    expect(res.body.user.id).toBe(userRecord.id);
    expect(res.body.user.email).toBe(userRecord.email);
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  // A-11
  it('A-11: rejects GET /api/auth/me without Authorization header with 401 Unauthorized', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/Missing or malformed Authorization header/i);
  });

  // A-12
  it('A-12: rejects GET /api/auth/me with malformed Authorization header with 401 Unauthorized', async () => {
    const resBasic = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(resBasic.status).toBe(401);

    const resEmptyBearer = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer');
    expect(resEmptyBearer.status).toBe(401);
  });

  // A-13
  it('A-13: rejects GET /api/auth/me with tampered JWT signature with 401 Unauthorized', async () => {
    const validToken = jwt.sign(
      { userId: 'u-1', email: 'tamper@example.com', role: 'USER' },
      process.env.JWT_SECRET!
    );
    const tamperedToken = validToken.slice(0, -6) + 'xxxxxx';

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tamperedToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/invalid|tampered/i);
  });

  // A-14
  it('A-14: rejects GET /api/auth/me with expired JWT token with 401 Unauthorized', async () => {
    const expiredToken = jwt.sign(
      { userId: 'u-1', email: 'expired@example.com', role: 'USER' },
      process.env.JWT_SECRET!,
      { expiresIn: '-1s' }
    );

    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toMatch(/expired/i);
  });
});
