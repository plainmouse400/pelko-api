import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { firebaseAdmin } from '../config/firebase';
import { supabase } from '../config/supabase';
import { TokenPayload, MintedTokens } from '../types';

const JWT_SECRET = process.env.PELKO_JWT_SECRET!;
const JWT_EXPIRY = process.env.PELKO_JWT_EXPIRY || '1h';

// Mint a Pelko JWT (used for calling Pelko platform APIs)
export function mintPelkoToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY } as jwt.SignOptions);
}

// Verify a Pelko JWT
export function verifyPelkoToken(token: string): TokenPayload {
  return jwt.verify(token, JWT_SECRET) as TokenPayload;
}

// Mint a Firebase custom token (used for Firestore access)
// The appId custom claim is what Firestore security rules check
export async function mintFirebaseToken(userId: string, appId: string): Promise<string> {
  return firebaseAdmin.auth().createCustomToken(userId, { appId });
}

// Generate a cryptographically secure refresh token
export function generateRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

// Create a session with refresh token in the database
export async function createSession(userId: string, appId: string, deviceId?: string): Promise<string> {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30); // 30 days

  await supabase.from('auth_sessions').insert({
    user_id: userId,
    app_id: appId,
    refresh_token: refreshToken,
    device_id: deviceId,
    expires_at: expiresAt.toISOString(),
  });

  return refreshToken;
}

// Mint all tokens for a successful auth
export async function mintAllTokens(userId: string, appId: string, deviceId?: string): Promise<MintedTokens> {
  const pelkoToken = mintPelkoToken({ userId, appId });
  const firebaseToken = await mintFirebaseToken(userId, appId);
  const refreshToken = await createSession(userId, appId, deviceId);

  return { pelkoToken, firebaseToken, refreshToken };
}
