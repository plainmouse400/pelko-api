import { Router, Request, Response } from 'express';
import { validatePelkoUser } from '../middleware/validatePelkoUser';
import { runBuilderAgent } from '../services/builderAgent';
import { getUserUsageToday } from '../services/usageService';
import { supabase } from '../config/supabase';

const router = Router();

// All builder routes require a logged-in Pelko platform user
router.use(validatePelkoUser);

// ==========================================
// POST /builder/message
// Send a message in a builder conversation
// ==========================================
router.post('/message', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const { appId, message, conversationHistory, currentCode, appMemory } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const result = await runBuilderAgent(
      userId,
      appId || null,
      currentCode || {},
      conversationHistory || [],
      message,
      appMemory || null
    );

    return res.json({
      conversationText: result.conversationText,
      codeUpdate: result.codeUpdate,
      usage: result.usage,
    });
  } catch (err: any) {
    console.error('Builder message error:', err);
    return res.status(500).json({ error: 'Failed to process message' });
  }
});

// ==========================================
// GET /builder/usage
// Get the current user's builder usage stats
// ==========================================
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const usage = await getUserUsageToday(userId);
    return res.json(usage);
  } catch (err: any) {
    console.error('Usage fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// ==========================================
// GET /builder/apps
// Get the current user's created apps
// ==========================================
router.get('/apps', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;

    const { data: apps, error } = await supabase
      .from('creator_apps')
      .select('*')
      .eq('pelko_user_id', userId)
      .order('last_edited_at', { ascending: false });

    if (error) throw error;

    return res.json({ apps: apps || [] });
  } catch (err: any) {
    console.error('Apps fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

// ==========================================
// POST /builder/apps
// Create a new app (just the database record — full provisioning comes later)
// ==========================================
router.post('/apps', async (req: Request, res: Response) => {
  try {
    const { userId } = (req as any).pelkoUser;
    const { appName } = req.body;

    // Generate a URL-safe app ID
    const appId = (appName || 'my-app')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);

    // Check uniqueness
    const { data: existing } = await supabase
      .from('creator_apps')
      .select('app_id')
      .eq('app_id', appId)
      .single();

    const finalAppId = existing
      ? `${appId}-${Math.random().toString(36).substring(2, 6)}`
      : appId;

    // Create creator_apps record
    const { data: app, error } = await supabase
      .from('creator_apps')
      .insert({
        pelko_user_id: userId,
        app_id: finalAppId,
        app_name: appName || 'My App',
        status: 'draft',
      })
      .select()
      .single();

    if (error) throw error;

    // Create builder memory
    await supabase
      .from('builder_memory')
      .insert({
        app_id: finalAppId,
        architecture_decisions: {},
        creator_preferences: {},
        feature_inventory: [],
        planned_features: [],
        conversation_summary: '',
        current_sequence_number: 0,
      });

    return res.json({ app });
  } catch (err: any) {
    console.error('Create app error:', err);
    return res.status(500).json({ error: 'Failed to create app' });
  }
});

// ==========================================
// GET /builder/apps/:appId/memory
// Get builder memory for an app
// ==========================================
router.get('/apps/:appId/memory', async (req: Request, res: Response) => {
  try {
    const { appId } = req.params;
    const { userId } = (req as any).pelkoUser;

    // Verify ownership
    const { data: app } = await supabase
      .from('creator_apps')
      .select('*')
      .eq('app_id', appId)
      .eq('pelko_user_id', userId)
      .single();

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const { data: memory } = await supabase
      .from('builder_memory')
      .select('*')
      .eq('app_id', appId)
      .single();

    return res.json({ memory: memory || null });
  } catch (err: any) {
    console.error('Memory fetch error:', err);
    return res.status(500).json({ error: 'Failed to fetch memory' });
  }
});

// ==========================================
// PUT /builder/apps/:appId/memory
// Update builder memory for an app
// ==========================================
router.put('/apps/:appId/memory', async (req: Request, res: Response) => {
  try {
    const { appId } = req.params;
    const { userId } = (req as any).pelkoUser;
    const updates = req.body;

    // Verify ownership
    const { data: app } = await supabase
      .from('creator_apps')
      .select('*')
      .eq('app_id', appId)
      .eq('pelko_user_id', userId)
      .single();

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    const { error } = await supabase
      .from('builder_memory')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('app_id', appId);

    if (error) throw error;

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Memory update error:', err);
    return res.status(500).json({ error: 'Failed to update memory' });
  }
});

export default router;
