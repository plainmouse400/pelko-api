import { Router, Request, Response } from 'express';
import { validatePelkoUser } from '../middleware/validatePelkoUser';
import { runBuilderPipeline } from '../builder/pipeline';
import { getOrCreateSession, getSessionMessages } from '../services/sessionService';
import { getUserUsageToday } from '../services/usageService';
import { supabase } from '../config/supabase';

const router = Router();
router.use(validatePelkoUser);

// POST /builder/message — The frontend just sends { appId, message }
router.post('/message', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const { appId, message } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (!appId) return res.status(400).json({ error: 'appId is required' });

    const result = await runBuilderPipeline(userId, appId, message);
    return res.json({
      conversationText: result.conversationText,
      codeUpdate: result.codeUpdate,
      usage: result.usage,
      sessionId: result.sessionId,
    });
  } catch (err: any) {
    console.error('Builder message error:', err);
    return res.status(500).json({ error: 'Failed to process message' });
  }
});

// GET /builder/session/:appId — Load persisted session for display
router.get('/session/:appId', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const { appId } = req.params;
    const session = await getOrCreateSession(userId, appId);
    const messages = await getSessionMessages(session.id);

    return res.json({
      sessionId: session.id,
      messages,
      currentCode: session.currentCode,
      fileIndex: session.fileIndex,
      messageCount: session.messageCount,
    });
  } catch (err: any) {
    console.error('Session load error:', err);
    return res.status(500).json({ error: 'Failed to load session' });
  }
});

// GET /builder/usage
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    return res.json(await getUserUsageToday(userId));
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// GET /builder/apps
router.get('/apps', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const { data: sessions } = await supabase
      .from('builder_sessions')
      .select('app_id, message_count, started_at, last_active_at')
      .eq('user_id', userId)
      .order('last_active_at', { ascending: false });

    return res.json({
      apps: (sessions || []).map(s => ({
        appId: s.app_id, messageCount: s.message_count,
        startedAt: s.started_at, lastActiveAt: s.last_active_at,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

export default router;
