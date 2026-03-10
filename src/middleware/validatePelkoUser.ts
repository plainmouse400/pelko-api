import { Request, Response, NextFunction } from 'express';
import { verifyPelkoToken } from '../services/tokenService';

export async function validatePelkoUser(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const payload = verifyPelkoToken(token);

    // Must be a pelko-platform token, not a micro app token
    if (payload.appId !== 'pelko-platform') {
      return res.status(403).json({ error: 'Invalid token — must be a Pelko platform token' });
    }

    // Attach user info to request
    (req as any).pelkoUser = {
      userId: payload.userId,
      appId: payload.appId,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
