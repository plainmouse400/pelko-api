// Environment variable validation — fails fast on startup if required vars are missing

const required = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'FIREBASE_SERVICE_ACCOUNT',
  'PELKO_JWT_SECRET',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const env = {
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY!,
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT!,
  pelkoJwtSecret: process.env.PELKO_JWT_SECRET!,
  pelkoJwtExpiry: process.env.PELKO_JWT_EXPIRY || '1h',
  pelkoRefreshExpiry: process.env.PELKO_REFRESH_EXPIRY || '30d',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER,
  resendApiKey: process.env.RESEND_API_KEY,
  appleClientId: process.env.APPLE_CLIENT_ID,
  appleTeamId: process.env.APPLE_TEAM_ID,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  port: parseInt(process.env.PORT || '3000', 10),
};
