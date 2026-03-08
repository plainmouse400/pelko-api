# pelko-api

The central Pelko platform backend. Handles authentication for micro apps running inside the Pelko native shell.

## Tech Stack

- Node.js + TypeScript
- Express
- Supabase Postgres (auth data)
- Firebase Admin SDK (custom tokens for Firestore)
- Twilio (SMS fallback)
- Resend (email verification)
- Apple / Google token validation

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in all required values in `.env`. See `.env.example` for descriptions.

### 3. Set up the database

Run the SQL schema from the issue/docs in your Supabase SQL Editor to create the required tables:
- `app_registry`
- `auth_users`
- `auth_providers`
- `auth_sessions`
- `auth_verification_codes`
- `pelko_devices`

### 4. Run in development

```bash
npm run dev
```

### 5. Build for production

```bash
npm run build
npm start
```

## API Endpoints

All endpoints require `x-app-id` and `x-app-secret` headers.

### `POST /auth/request-code`
Request a verification code via phone or email.

**Body:** `{ phone?: string, email?: string }`

**Response:** `{ success: true, targetType: "phone" | "email" }`

---

### `POST /auth/verify-code`
Verify a code and receive auth tokens (signup and login are the same flow).

**Body:** `{ phone?: string, email?: string, code: string, deviceId?: string }`

**Response:** `{ pelkoToken, firebaseToken, refreshToken, user, isNewUser }`

---

### `POST /auth/social`
Sign in with Apple or Google.

**Body:** `{ provider: "apple" | "google", identityToken?: string, idToken?: string, name?: string, deviceId?: string }`

**Response:** `{ pelkoToken, firebaseToken, refreshToken, user, isNewUser }`

---

### `POST /auth/refresh`
Refresh expired tokens using a refresh token (token rotation).

**Body:** `{ refreshToken: string }`

**Response:** `{ pelkoToken, firebaseToken, refreshToken }`

---

### `POST /auth/signout`
Invalidate the current session.

**Body:** `{ refreshToken?: string }`

**Response:** `{ success: true }`

---

### `DELETE /auth/account`
Delete user account and all associated data.

**Headers:** `Authorization: Bearer <pelkoToken>`

**Response:** `{ success: true }`

---

### `GET /auth/user`
Get current user profile.

**Headers:** `Authorization: Bearer <pelkoToken>`

**Response:** `{ user: { id, app_id, phone, email, display_name, avatar_url, created_at } }`

---

### `GET /health`
Health check endpoint.

**Response:** `{ status: "ok" }`

## Architecture

See the issue for the full architecture diagram and database schema.
