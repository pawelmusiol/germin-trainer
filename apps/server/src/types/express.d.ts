import { JwtPayload } from '@garmin-trainer/shared';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
