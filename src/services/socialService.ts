import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { OAuth2Client } from 'google-auth-library';

// ========== APPLE ==========

const appleJwksClient = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  cache: true,
  rateLimit: true,
});

function getAppleSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    appleJwksClient.getSigningKey(kid, (err, key) => {
      if (err) return reject(err);
      resolve(key!.getPublicKey());
    });
  });
}

export interface AppleAuthResult {
  appleUserId: string;
  email: string | null;
  name: string | null;
}

export async function validateAppleToken(identityToken: string): Promise<AppleAuthResult> {
  // Decode header to get kid
  const decoded = jwt.decode(identityToken, { complete: true });
  if (!decoded) throw new Error('Invalid Apple identity token');

  // Get Apple's public key
  const publicKey = await getAppleSigningKey(decoded.header.kid!);

  // Verify the token
  const payload = jwt.verify(identityToken, publicKey, {
    algorithms: ['RS256'],
    issuer: 'https://appleid.apple.com',
    audience: process.env.APPLE_CLIENT_ID!,
  }) as Record<string, unknown>;

  return {
    appleUserId: payload.sub as string,
    email: (payload.email as string) || null,
    name: null, // Apple only sends name on first auth, client must pass it
  };
}

// ========== GOOGLE ==========

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID!);

export interface GoogleAuthResult {
  googleUserId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export async function validateGoogleToken(idToken: string): Promise<GoogleAuthResult> {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID!,
  });

  const payload = ticket.getPayload()!;

  return {
    googleUserId: payload.sub,
    email: payload.email!,
    name: payload.name || null,
    avatarUrl: payload.picture || null,
  };
}
