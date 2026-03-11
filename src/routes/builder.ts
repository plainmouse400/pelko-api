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

// POST /builder/apps — Create a new app
router.post('/apps', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const { displayName } = req.body;

    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ error: 'displayName is required' });
    }

    // Generate a URL-safe app_id from the display name
    const baseId = displayName.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);

    // Check uniqueness, add random suffix if collision
    const { data: existing } = await supabase
      .from('creator_apps')
      .select('app_id')
      .eq('app_id', baseId)
      .single();

    const appId = existing
      ? `${baseId}-${Math.random().toString(36).substring(2, 6)}`
      : baseId;

    // Create the app record
    const { data: app, error } = await supabase
      .from('creator_apps')
      .insert({
        pelko_user_id: userId,
        app_id: appId,
        display_name: displayName.trim(),
        status: 'draft',
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      appId: app.app_id,
      displayName: app.display_name,
      status: app.status,
      createdAt: app.created_at,
    });
  } catch (err: any) {
    console.error('Create app error:', err);
    return res.status(500).json({ error: 'Failed to create app' });
  }
});

// GET /builder/apps — List the creator's apps
router.get('/apps', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;

    // Get all non-archived apps for this user
    const { data: apps, error } = await supabase
      .from('creator_apps')
      .select('*')
      .eq('pelko_user_id', userId)
      .neq('status', 'archived')
      .order('last_edited_at', { ascending: false });

    if (error) throw error;

    // Get session info (message counts) for each app
    const appIds = (apps || []).map(a => a.app_id);
    const { data: sessions } = await supabase
      .from('builder_sessions')
      .select('app_id, message_count, last_active_at')
      .eq('user_id', userId)
      .in('app_id', appIds);

    const sessionMap = new Map(
      (sessions || []).map(s => [s.app_id, s])
    );

    return res.json({
      apps: (apps || []).map(app => ({
        appId: app.app_id,
        displayName: app.display_name,
        status: app.status,
        iconUrl: app.icon_url,
        createdAt: app.created_at,
        lastEditedAt: app.last_edited_at,
        messageCount: sessionMap.get(app.app_id)?.message_count || 0,
      })),
    });
  } catch (err: any) {
    console.error('Apps list error:', err);
    return res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

// PATCH /builder/apps/:appId — Rename an app or change its status
router.patch('/apps/:appId', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const { appId } = req.params;
    const { displayName, status } = req.body;

    // Verify ownership
    const { data: existing } = await supabase
      .from('creator_apps')
      .select('id')
      .eq('app_id', appId)
      .eq('pelko_user_id', userId)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'App not found' });
    }

    const updates: Record<string, any> = {
      last_edited_at: new Date().toISOString(),
    };
    if (displayName && displayName.trim()) {
      updates.display_name = displayName.trim();
    }
    if (status && ['draft', 'live', 'paused', 'archived'].includes(status)) {
      updates.status = status;
    }

    const { data: updated, error } = await supabase
      .from('creator_apps')
      .update(updates)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) throw error;

    return res.json({
      appId: updated.app_id,
      displayName: updated.display_name,
      status: updated.status,
    });
  } catch (err: any) {
    console.error('Update app error:', err);
    return res.status(500).json({ error: 'Failed to update app' });
  }
});

export default router;
