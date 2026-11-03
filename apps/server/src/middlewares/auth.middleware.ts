import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload, UserRole } from '@garmin-trainer/shared';

/**
 * Resolves the JWT secret key.
 * In production, throws if JWT_SECRET is not configured.
 * In development or test environments, falls back to a development secret.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is missing');
    }
    return 'garmin-trainer-dev-jwt-secret-replace-in-production-min32chars';
  }
  return secret;
}

/**
 * Generates an HMAC SHA-256 signed JWT token for the authenticated user.
 */
export function generateToken(
  payload: { userId: string; email: string; role: UserRole | string },
  expiresIn?: string
): string {
  const secret = getJwtSecret();
  const expiry = (expiresIn || process.env.JWT_EXPIRES_IN || '7d') as any;
  return jwt.sign(payload, secret, {
    expiresIn: expiry,
    algorithm: 'HS256',
  });
}

/**
 * Express middleware to authenticate incoming requests via Bearer JWT token.
 * Extracts Bearer token from Authorization header, validates signature and expiration,
 * and attaches decoded claims to req.user.
 */
export function authenticateJwt(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.substring(7).trim();
  if (!token) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  try {
    const secret = getJwtSecret();
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;

    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role as UserRole,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Token has expired' });
      return;
    }
    res.status(401).json({ error: 'Invalid or tampered authentication token' });
  }
}
