import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { UserRole } from '@garmin-trainer/shared';
import { prisma as defaultPrisma } from '../../db';
import { authenticateJwt, generateToken } from '../../middlewares/auth.middleware';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_SALT_ROUNDS = 10;

export interface SanitizedUser {
  id: string;
  email: string;
  name?: string;
  role: string;
  createdAt: string;
}

/**
 * Sanitizes user record for API responses, guaranteeing passwordHash is never returned.
 */
function sanitizeUser(user: {
  id: string;
  email: string;
  name?: string | null;
  role: string;
  createdAt: Date | string;
}): SanitizedUser {
  return {
    id: user.id,
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    role: user.role,
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
  };
}

/**
 * Factory creating the Auth Router with injectable PrismaClient.
 */
export function createAuthRouter(prismaClient: PrismaClient = defaultPrisma): Router {
  const router = Router();

  /**
   * POST /api/auth/register
   * Registers a new user account, validates fields, hashes password with bcrypt (10 rounds),
   * persists to DB, and returns user profile + JWT.
   */
  router.post('/register', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password, name, role } = req.body || {};

      // 1. Email validation
      if (!email || typeof email !== 'string') {
        res.status(400).json({ error: 'Valid email is required' });
        return;
      }
      const normalizedEmail = email.trim().toLowerCase();
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        res.status(400).json({ error: 'Invalid email format' });
        return;
      }

      // 2. Password validation
      if (!password || typeof password !== 'string') {
        res.status(400).json({ error: 'Password is required' });
        return;
      }
      if (password.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters long' });
        return;
      }
      if (password.length > 128) {
        res.status(400).json({ error: 'Password cannot exceed 128 characters' });
        return;
      }

      // 3. Role validation (optional, defaults to USER)
      let userRole: UserRole = UserRole.USER;
      if (role !== undefined) {
        if (role === UserRole.USER || role === UserRole.ADMIN) {
          userRole = role;
        } else {
          res.status(400).json({ error: 'Invalid role. Allowed values: USER, ADMIN' });
          return;
        }
      }

      // 4. Duplicate check
      const existingUser = await prismaClient.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (existingUser) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }

      // 5. Password hashing with bcrypt
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

      // 6. Persistence with defensive unique constraint race handling
      let createdUser;
      try {
        createdUser = await prismaClient.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : null,
            role: userRole as any,
          },
        });
      } catch (dbErr: any) {
        if (dbErr.code === 'P2002') {
          res.status(409).json({ error: 'Email already registered' });
          return;
        }
        throw dbErr;
      }

      // 7. JWT generation
      const token = generateToken({
        userId: createdUser.id,
        email: createdUser.email,
        role: createdUser.role as UserRole,
      });

      res.status(201).json({
        user: sanitizeUser(createdUser),
        token,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * POST /api/auth/login
   * Authenticates user credentials, compares bcrypt hash, and returns user profile + JWT.
   */
  router.post('/login', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { email, password } = req.body || {};

      if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'Email and password are required' });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();
      const user = await prismaClient.user.findUnique({
        where: { email: normalizedEmail },
      });

      if (!user) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const isMatch = await bcrypt.compare(password, user.passwordHash);
      if (!isMatch) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }

      const token = generateToken({
        userId: user.id,
        email: user.email,
        role: user.role as UserRole,
      });

      res.status(200).json({
        user: sanitizeUser(user),
        token,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/auth/me
   * Protected route returning the current authenticated user's profile.
   */
  router.get('/me', authenticateJwt, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ error: 'Invalid or missing user context' });
        return;
      }

      const user = await prismaClient.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.status(200).json({
        user: sanitizeUser(user),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export const authRouter = createAuthRouter();
export default authRouter;
