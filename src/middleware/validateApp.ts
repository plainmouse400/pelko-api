import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';

// Validates that the request comes from a registered micro app
// Expects headers: x-app-id and x-app-secret
export async function validateApp(req: Request, res: Response, next: NextFunction) {
  const appId = req.headers['x-app-id'] as string;
  const appSecret = req.headers['x-app-secret'] as string;

  if (!appId || !appSecret) {
    return res.status(401).json({ error: 'Missing app credentials' });
  }

  const { data: app, error } = await supabase
    .from('app_registry')
    .select('*')
    .eq('app_id', appId)
    .eq('app_secret', appSecret)
    .single();

  if (error || !app) {
    return res.status(401).json({ error: 'Invalid app credentials' });
  }

  // Attach app info to request for downstream use
  (req as any).app = app;
  next();
}
