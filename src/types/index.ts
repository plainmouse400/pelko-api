export interface AppRecord {
  id: string;
  app_id: string;
  app_name: string;
  app_secret: string;
  firebase_config: Record<string, unknown> | null;
  auth_methods: {
    phone: boolean;
    email: boolean;
    apple: boolean;
    google: boolean;
  };
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  id: string;
  app_id: string;
  phone: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  phone_verified: boolean;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface AuthSession {
  id: string;
  user_id: string;
  app_id: string;
  refresh_token: string;
  device_id: string | null;
  expires_at: string;
  created_at: string;
}

export interface AuthVerificationCode {
  id: string;
  app_id: string;
  target: string;
  target_type: 'phone' | 'email';
  code_hash: string;
  attempts: number;
  expires_at: string;
  created_at: string;
}

export interface PelkoDevice {
  id: string;
  pelko_user_id: string | null;
  device_token: string;
  phone: string | null;
  platform: 'ios' | 'android';
  last_seen_at: string;
  created_at: string;
}

export interface TokenPayload {
  userId: string;
  appId: string;
}

export interface MintedTokens {
  pelkoToken: string;
  firebaseToken: string;
  refreshToken: string;
}
