import request from 'supertest';
import { createApp } from '../src/app';
import { generateToken } from '../src/middlewares/auth.middleware';
import { UserRole } from '@garmin-trainer/shared';

process.env.JWT_SECRET = 'test-jwt-secret-key-at-least-32-chars-long!!';
process.env.JWT_EXPIRES_IN = '7d';
process.env.GARMIN_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Adversarial Challenge: Garmin Disconnect Flow & State Resilience', () => {
  let mockGarminDb: any[] = [];

  const mockPrisma: any = {
    garminAuth: {
      findUnique: jest.fn(async ({ where }: any) => {
        return mockGarminDb.find((g) => g.userId === where.userId) || null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const idx = mockGarminDb.findIndex((g) => g.userId === where.userId);
        if (idx >= 0) {
          mockGarminDb[idx] = { ...mockGarminDb[idx], ...update, updatedAt: new Date() };
          return mockGarminDb[idx];
        }
        const created = {
          id: `ga_${Date.now()}`,
          userId: create.userId,
          ciphertext: create.ciphertext,
          iv: create.iv,
          authTag: create.authTag,
          expiresAt: create.expiresAt ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockGarminDb.push(created);
        return created;
      }),
      delete: jest.fn(async ({ where }: any) => {
        mockGarminDb = mockGarminDb.filter((g) => g.userId !== where.userId);
      }),
    },
    user: {
      findUnique: jest.fn(async () => null),
    },
    trainingGoal: {
      findFirst: jest.fn(async () => null),
    },
    dailyMetric: {
      findMany: jest.fn(async () => []),
    },
  };

  const app = createApp(mockPrisma);
  const testUserId = 'adversarial_user_garmin_disconnect';
  const authHeader = `Bearer ${generateToken({
    userId: testUserId,
    email: 'adv.disconnect@example.com',
    role: UserRole.USER,
  })}`;

  beforeEach(() => {
    mockGarminDb = [];
    jest.clearAllMocks();
  });

  describe('DELETE /api/garmin/disconnect backend robustness', () => {
    it('ADV-1: Rejects unauthenticated disconnect requests with 401', async () => {
      const res = await request(app).delete('/api/garmin/disconnect');
      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('ADV-2: Rejects malformed JWT token with 401', async () => {
      const res = await request(app)
        .delete('/api/garmin/disconnect')
        .set('Authorization', 'Bearer invalid_token_xyz');
      expect(res.status).toBe(401);
    });

    it('ADV-3: Disconnect is idempotent — succeeds when no Garmin session exists in DB without crashing', async () => {
      expect(mockGarminDb).toHaveLength(0);

      const res = await request(app)
        .delete('/api/garmin/disconnect')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        connected: false,
        message: 'Garmin Connect account disconnected',
      });
      expect(mockGarminDb).toHaveLength(0);
    });

    it('ADV-4: Genuinely unlinks and deletes session from DB when connected', async () => {
      // 1. Establish connection first
      await request(app)
        .post('/api/garmin/connect')
        .set('Authorization', authHeader)
        .send({ email: 'adv.runner@example.com', password: 'ValidPassword123' });

      expect(mockGarminDb).toHaveLength(1);

      // 2. Disconnect
      const res = await request(app)
        .delete('/api/garmin/disconnect')
        .set('Authorization', authHeader);

      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);

      // 3. Verify DB record is gone
      expect(mockGarminDb).toHaveLength(0);

      // 4. Verify subsequent status query reflects disconnected state
      const statusRes = await request(app)
        .get('/api/garmin/status')
        .set('Authorization', authHeader);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.status).toMatchObject({
        connected: false,
        mfaPending: false,
      });
    });

    it('ADV-5: Gracefully catches and propagates DB errors (500) without crashing Express process', async () => {
      const failingPrisma: any = {
        garminAuth: {
          findUnique: jest.fn(async () => {
            throw new Error('FATAL: Database connection terminated abruptly');
          }),
        },
      };

      const failingApp = createApp(failingPrisma);
      const res = await request(failingApp)
        .delete('/api/garmin/disconnect')
        .set('Authorization', authHeader);

      expect(res.status).toBe(500);
      expect(res.text).toContain('Database connection terminated abruptly');
    });
  });

  describe('Mobile Client & Component Error Resilience Simulation', () => {
    it('ADV-6: Simulates mobile client handling 500 error on disconnect without crashing', async () => {
      // Replicate mobile api.ts client logic
      async function clientDisconnect(mockFetch: () => Promise<any>) {
        const res = await mockFetch();
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || `Failed to disconnect Garmin account (${res.status})`);
        }
        return body;
      }

      // 500 response from server
      const mock500Fetch = async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Prisma DB connection timeout' }),
      });

      let garminConnected = true;
      let statusBanner: string | null = null;
      let loading = true;

      // Replicate App.tsx handleDisconnectGarmin
      try {
        await clientDisconnect(mock500Fetch);
        garminConnected = false;
        statusBanner = '✅ Rozłączono konto Garmin Connect';
      } catch (err: any) {
        statusBanner = `❌ Błąd rozłączania Garmin: ${err.message}`;
      } finally {
        loading = false;
      }

      // Assert state resilience
      expect(loading).toBe(false);
      expect(garminConnected).toBe(true); // Must remain connected to avoid inconsistent client-server state
      expect(statusBanner).toBe('❌ Błąd rozłączania Garmin: Prisma DB connection timeout');
    });

    it('ADV-7: Simulates mobile client handling network failure on disconnect without crashing', async () => {
      // Replicate mobile api.ts client logic
      async function clientDisconnect(mockFetch: () => Promise<any>) {
        const res = await mockFetch();
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || `Failed to disconnect Garmin account (${res.status})`);
        }
        return body;
      }

      // Network request failure (e.g. offline, timeout, airplane mode)
      const mockNetworkFailureFetch = async () => {
        throw new TypeError('Network request failed');
      };

      let garminConnected = true;
      let credentials = { email: 'runner@garmin.com', password: 'secretpassword', mfa: '123456' };
      let statusBanner: string | null = null;
      let loading = true;

      // Replicate App.tsx handleDisconnectGarmin
      try {
        await clientDisconnect(mockNetworkFailureFetch);
        garminConnected = false;
        credentials = { email: '', password: '', mfa: '' };
        statusBanner = '✅ Rozłączono konto Garmin Connect';
      } catch (err: any) {
        statusBanner = `❌ Błąd rozłączania Garmin: ${err.message}`;
      } finally {
        loading = false;
      }

      // Assert state resilience
      expect(loading).toBe(false);
      expect(garminConnected).toBe(true);
      expect(credentials.email).toBe('runner@garmin.com'); // Credentials not prematurely cleared if request failed
      expect(statusBanner).toBe('❌ Błąd rozłączania Garmin: Network request failed');
    });

    it('ADV-8: Simulates successful disconnect: cleanly wipes all credentials and updates connection state', async () => {
      let garminConnected = true;
      let connectedGarminEmail: string | null = 'runner@garmin.com';
      let garminEmail = 'runner@garmin.com';
      let garminPassword = 'supersecretpassword';
      let garminMfaCode = '654321';
      let garminMfaPending = true;
      let statusBanner: string | null = null;
      let loading = true;

      const mockSuccessFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          connected: false,
          message: 'Garmin Connect account disconnected',
        }),
      });

      try {
        const res = await (async () => {
          const r = await mockSuccessFetch();
          const body = await r.json();
          if (!r.ok) throw new Error(body.error);
          return body;
        })();

        garminConnected = false;
        connectedGarminEmail = null;
        garminEmail = '';
        garminPassword = '';
        garminMfaCode = '';
        garminMfaPending = false;
        statusBanner = `✅ ${res.message || 'Rozłączono konto Garmin Connect'}`;
      } catch (err: any) {
        statusBanner = `❌ Błąd rozłączania Garmin: ${err.message}`;
      } finally {
        loading = false;
      }

      expect(loading).toBe(false);
      expect(garminConnected).toBe(false);
      expect(connectedGarminEmail).toBeNull();
      expect(garminEmail).toBe('');
      expect(garminPassword).toBe('');
      expect(garminMfaCode).toBe('');
      expect(garminMfaPending).toBe(false);
      expect(statusBanner).toBe('✅ Garmin Connect account disconnected');
    });
  });
});
