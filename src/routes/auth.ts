import { Router, Request, Response } from 'express';
import { validateApp } from '../middleware/validateApp';
import { codeRequestLimiter, codeVerifyLimiter } from '../middleware/rateLimit';
import { storeCode, validateCode } from '../services/codeService';
import { mintAllTokens, verifyPelkoToken } from '../services/tokenService';
import { sendCodeViaPush } from '../services/pushService';
import { sendCodeViaSMS } from '../services/smsService';
import { sendCodeViaEmail } from '../services/emailService';
import { validateAppleToken, validateGoogleToken } from '../services/socialService';
import {
  findOrCreateUserByPhone,
  findOrCreateUserByEmail,
  findOrCreateUserBySocial,
  deleteUser,
} from '../services/authService';
import { supabase } from '../config/supabase';

const router = Router();

// All auth routes require valid app credentials
router.use(validateApp);

// ==========================================
// POST /auth/request-code
// Request a verification code (phone or email)
// ==========================================
router.post('/request-code', codeRequestLimiter, async (req: Request, res: Response) => {
  try {
    const app = (req as any).app;
    const { phone, email } = req.body;

    if (!phone && !email) {
      return res.status(400).json({ error: 'Either phone or email is required' });
    }

    if (phone && !app.auth_methods.phone) {
      return res.status(400).json({ error: 'Phone auth is not enabled for this app' });
    }

    if (email && !app.auth_methods.email) {
      return res.status(400).json({ error: 'Email auth is not enabled for this app' });
    }

    const target = phone || email;
    const targetType = phone ? 'phone' : 'email';

    // Generate and store code
    const code = await storeCode(app.app_id, target, targetType as 'phone' | 'email');
    console.log(`[DEV] Verification code for ${target}: ${code}`);
    
    // Deliver the code
    if (targetType === 'phone') {
      // Try push first (free), fall back to SMS (paid)
      const pushSent = await sendCodeViaPush(phone, code);
      if (!pushSent) {
        await sendCodeViaSMS(phone, code);
      }
    } else {
      await sendCodeViaEmail(email, code, app.app_name);
    }

    return res.json({
      success: true,
      targetType,
      // Never return the code in the response!
    });
  } catch (err: any) {
    console.error('Error requesting code:', err);
    return res.status(500).json({ error: 'Failed to send verification code' });
  }
});

// ==========================================
// POST /auth/verify-code
// Verify a code and return auth tokens
// Signup and login are the same flow
// ==========================================
router.post('/verify-code', codeVerifyLimiter, async (req: Request, res: Response) => {
  try {
    const app = (req as any).app;
    const { phone, email, code, deviceId } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }

    const target = phone || email;
    const targetType = phone ? 'phone' : 'email';

    if (!target) {
      return res.status(400).json({ error: 'Either phone or email is required' });
    }

    // Validate the code
    const result = await validateCode(app.app_id, target, targetType as 'phone' | 'email', code);

    if (!result.valid) {
      return res.status(401).json({ error: result.error });
    }

    // Code is valid — find or create the user
    let user, isNewUser;

    if (targetType === 'phone') {
      ({ user, isNewUser } = await findOrCreateUserByPhone(app.app_id, phone));
    } else {
      ({ user, isNewUser } = await findOrCreateUserByEmail(app.app_id, email));
    }

    // Mint all tokens
    const tokens = await mintAllTokens(user.id, app.app_id, deviceId);

    return res.json({
      ...tokens,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      },
      isNewUser,
    });
  } catch (err: any) {
    console.error('Error verifying code:', err);
    return res.status(500).json({ error: 'Failed to verify code' });
  }
});

// ==========================================
// POST /auth/social
// Sign in with Apple or Google
// ==========================================
router.post('/social', async (req: Request, res: Response) => {
  try {
    const app = (req as any).app;
    const { provider, identityToken, idToken, name, deviceId } = req.body;

    if (!provider || !['apple', 'google'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid provider. Use "apple" or "google".' });
    }

    if (provider === 'apple' && !app.auth_methods.apple) {
      return res.status(400).json({ error: 'Apple auth is not enabled for this app' });
    }

    if (provider === 'google' && !app.auth_methods.google) {
      return res.status(400).json({ error: 'Google auth is not enabled for this app' });
    }

    let providerUserId: string;
    let email: string | null = null;
    let displayName: string | null = name || null;
    let avatarUrl: string | null = null;

    if (provider === 'apple') {
      if (!identityToken) {
        return res.status(400).json({ error: 'identityToken is required for Apple sign in' });
      }
      const appleResult = await validateAppleToken(identityToken);
      providerUserId = appleResult.appleUserId;
      email = appleResult.email;
    } else {
      if (!idToken) {
        return res.status(400).json({ error: 'idToken is required for Google sign in' });
      }
      const googleResult = await validateGoogleToken(idToken);
      providerUserId = googleResult.googleUserId;
      email = googleResult.email;
      displayName = displayName || googleResult.name;
      avatarUrl = googleResult.avatarUrl;
    }

    // Find or create user
    const { user, isNewUser } = await findOrCreateUserBySocial(
      app.app_id,
      provider,
      providerUserId,
      email,
      displayName,
      avatarUrl
    );

    // Mint all tokens
    const tokens = await mintAllTokens(user.id, app.app_id, deviceId);

    return res.json({
      ...tokens,
      user: {
        id: user.id,
        phone: user.phone,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
      },
      isNewUser,
    });
  } catch (err: any) {
    console.error('Error with social auth:', err);
    return res.status(500).json({ error: 'Social authentication failed' });
  }
});

// ==========================================
// POST /auth/refresh
// Refresh expired tokens using refresh token
// ==========================================
router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const app = (req as any).app;
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    // Look up the session
    const { data: session, error } = await supabase
      .from('auth_sessions')
      .select('*')
      .eq('refresh_token', refreshToken)
      .eq('app_id', app.app_id)
      .single();

    if (error || !session) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Check expiry
    if (new Date(session.expires_at) < new Date()) {
      await supabase.from('auth_sessions').delete().eq('id', session.id);
      return res.status(401).json({ error: 'Refresh token expired. Please sign in again.' });
    }

    // Delete old session
    await supabase.from('auth_sessions').delete().eq('id', session.id);

    // Mint new tokens (including new refresh token — rotation)
    const tokens = await mintAllTokens(session.user_id, app.app_id, session.device_id);

    return res.json(tokens);
  } catch (err: any) {
    console.error('Error refreshing tokens:', err);
    return res.status(500).json({ error: 'Failed to refresh tokens' });
  }
});

// ==========================================
// POST /auth/signout
// Invalidate the current session
// ==========================================
router.post('/signout', async (req: Request, res: Response) => {
  try {
    const app = (req as any).app;
    const { refreshToken } = req.body;

    if (refreshToken) {
      await supabase
        .from('auth_sessions')
        .delete()
        .eq('refresh_token', refreshToken)
        .eq('app_id', app.app_id);
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Error signing out:', err);
    return res.status(500).json({ error: 'Failed to sign out' });
  }
});

// ==========================================
// DELETE /auth/account
// Delete user account and all associated data
// ==========================================
router.delete('/account', async (req: Request, res: Response) => {
  try {
    const app = (req as any).app;
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyPelkoToken(token);

    if (payload.appId !== app.app_id) {
      return res.status(403).json({ error: 'Token does not match app' });
    }

    await deleteUser(payload.userId, app.app_id);

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Error deleting account:', err);
    return res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ==========================================
// GET /auth/user
// Get current user profile
// ==========================================
router.get('/user', async (req: Request, res: Response) => {
  try {
    const app = (req as any).app;
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyPelkoToken(token);

    if (payload.appId !== app.app_id) {
      return res.status(403).json({ error: 'Token does not match app' });
    }

    const { data: user, error } = await supabase
      .from('auth_users')
      .select('id, app_id, phone, email, display_name, avatar_url, created_at')
      .eq('id', payload.userId)
      .eq('app_id', app.app_id)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user });
  } catch (err: any) {
    console.error('Error getting user:', err);
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

export default router;
