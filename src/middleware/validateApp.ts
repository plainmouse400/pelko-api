import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';

export async function validateApp(req: Request, res: Response, next: NextFunction) {
  const appId = req.headers['x-app-id'] as string;
  const appSecret = req.headers['x-app-secret'] as string;

  console.log('validateApp received:', { 
    appId, 
    appSecret: appSecret ? appSecret.substring(0, 25) + '...' : 'MISSING',
    hasAppId: !!appId,
    hasAppSecret: !!appSecret
  });

  if (!appId || !appSecret) {
    console.log('validateApp: missing credentials');
    return res.status(401).json({ error: 'Missing app credentials' });
  }

  const { data: app, error } = await supabase
    .from('app_registry')
    .select('*')
    .eq('app_id', appId)
    .eq('app_secret', appSecret)
    .single();

  console.log('validateApp query result:', { 
    found: !!app, 
    error: error?.message || null,
    errorCode: error?.code || null,
    queriedAppId: appId 
  });

  if (error || !app) {
    return res.status(401).json({ error: 'Invalid app credentials' });
  }

  (req as any).app = app;
  next();
}
