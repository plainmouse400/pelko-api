import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { supabase } from '../config/supabase';

const router = Router();

// POST /apps/create — Provision a new micro app
router.post('/create', async (req: Request, res: Response) => {
  try {
    const { appId, appName, authMethods } = req.body;

    if (!appId || !appName) {
      return res.status(400).json({ error: 'appId and appName are required' });
    }

    // Validate appId format (lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9-]+$/.test(appId)) {
      return res.status(400).json({ error: 'appId must be lowercase alphanumeric with hyphens only' });
    }

    // Check if app already exists
    const { data: existing } = await supabase
      .from('app_registry')
      .select('app_id')
      .eq('app_id', appId)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'App ID already taken' });
    }

    // Generate app secret
    const appSecret = `sk_${appId}_${crypto.randomBytes(24).toString('hex')}`;

    // 1. Create GitHub repo
    await createGitHubRepo(appId);

    // 2. Push boilerplate code
    await pushBoilerplate(appId, appName, appSecret);

    // 3. Create Cloudflare Pages project
    await createCloudflarePages(appId);

    // 4. Set up Worker secrets
    await setupWorkerSecrets(appId, appSecret);

    // 5. Set up custom domains
    await setupDomains(appId);

    // 6. Register in app registry
    const { data: app, error } = await supabase
      .from('app_registry')
      .insert({
        app_id: appId,
        app_name: appName,
        app_secret: appSecret,
        auth_methods: authMethods || { phone: true, email: false, apple: false, google: false },
        firebase_config: getFirebaseWebConfig(),
      })
      .select()
      .single();

    if (error) throw error;

    return res.json({
      app: {
        appId: app.app_id,
        appName: app.app_name,
        frontendUrl: `https://${appId}.pelko.ai`,
        workerUrl: `https://api-${appId}.pelko.ai`,
        repoUrl: `https://github.com/pelko-apps/${appId}`,
      },
    });
  } catch (err: any) {
    console.error('Error creating app:', err);
    return res.status(500).json({ error: 'Failed to create app' });
  }
});

// ========== Helper functions ==========

async function createGitHubRepo(appId: string) {
  const response = await fetch('https://api.github.com/orgs/pelko-apps/repos', {
    method: 'POST',
    headers: {
      'Authorization': `token ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: appId,
      private: true,
      auto_init: true,
    }),
  });
  if (!response.ok) throw new Error(`GitHub repo creation failed: ${response.statusText}`);
}

async function pushBoilerplate(appId: string, appName: string, appSecret: string) {
  const files: Record<string, string> = {
    'frontend/package.json': JSON.stringify({
      name: `${appId}-frontend`,
      private: true,
      scripts: { dev: 'vite', build: 'vite build' },
      dependencies: {
        '@pelko/sdk': '^0.1.0',
        'react': '^18.2.0',
        'react-dom': '^18.2.0',
      },
      devDependencies: {
        '@types/react': '^18.2.0',
        'typescript': '^5.3.0',
        'vite': '^5.0.0',
        '@vitejs/plugin-react': '^4.2.0',
      },
    }, null, 2),

    'frontend/src/pelko.ts': `import { initPelko } from '@pelko/sdk';

export const pelko = initPelko({
  appId: '${appId}',
  appSecret: '${appSecret}',
  firebaseConfig: ${JSON.stringify(getFirebaseWebConfig(), null, 4)},
});`,

    'worker/wrangler.toml': `name = "${appId}-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"

routes = [
  { pattern = "api-${appId}.pelko.ai", custom_domain = true }
]

[triggers]
crons = []`,

    'worker/package.json': JSON.stringify({
      name: `${appId}-worker`,
      private: true,
      scripts: { dev: 'wrangler dev', deploy: 'wrangler deploy' },
      dependencies: {
        '@pelko/sdk-server': '^0.1.0',
      },
      devDependencies: {
        'wrangler': '^3.0.0',
        'typescript': '^5.3.0',
      },
    }, null, 2),

    'worker/src/index.ts': `import { PelkoServerAuth, PelkoServerFirestore } from '@pelko/sdk-server';

export interface Env {
  PELKO_APP_ID: string;
  PELKO_APP_SECRET: string;
  PELKO_JWT_SECRET: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_SERVICE_EMAIL: string;
  FIREBASE_SERVICE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = new PelkoServerAuth({ jwtSecret: env.PELKO_JWT_SECRET, appId: env.PELKO_APP_ID });
    const db = new PelkoServerFirestore({
      projectId: env.FIREBASE_PROJECT_ID,
      appId: env.PELKO_APP_ID,
      serviceAccountEmail: env.FIREBASE_SERVICE_EMAIL,
      serviceAccountKey: env.FIREBASE_SERVICE_KEY,
    });

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', app: env.PELKO_APP_ID });
    }

    // TODO: Add app-specific routes here

    return Response.json({ error: 'Not found' }, { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // TODO: Add scheduled tasks here
  },
};`,

    '.github/workflows/deploy-worker.yml': `name: Deploy Worker
on:
  push:
    branches: [main]
    paths: [worker/**]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: cd worker && npm install
      - run: cd worker && npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}`,
  };

  for (const [path, content] of Object.entries(files)) {
    await pushFileToGitHub(appId, path, content);
  }
}

async function pushFileToGitHub(appId: string, path: string, content: string) {
  await fetch(`https://api.github.com/repos/pelko-apps/${appId}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `Initialize ${path}`,
      content: Buffer.from(content).toString('base64'),
    }),
  });
}

async function createCloudflarePages(appId: string) {
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: appId,
      source: {
        type: 'github',
        config: {
          owner: 'pelko-apps',
          repo_name: appId,
          production_branch: 'main',
          root_dir: 'frontend',
          build_command: 'npm run build',
          destination_dir: 'dist',
        },
      },
    }),
  });
}

async function setupWorkerSecrets(appId: string, appSecret: string) {
  const secrets = [
    { name: 'PELKO_APP_ID', text: appId },
    { name: 'PELKO_APP_SECRET', text: appSecret },
    { name: 'PELKO_JWT_SECRET', text: process.env.PELKO_JWT_SECRET! },
    { name: 'FIREBASE_PROJECT_ID', text: process.env.FIREBASE_PROJECT_ID! },
    { name: 'FIREBASE_SERVICE_EMAIL', text: process.env.FIREBASE_SERVICE_EMAIL! },
    { name: 'FIREBASE_SERVICE_KEY', text: process.env.FIREBASE_SERVICE_KEY! },
  ];

  for (const secret of secrets) {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${appId}-worker/secrets`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(secret),
      }
    );
  }
}

async function setupDomains(appId: string) {
  // Frontend domain: appId.pelko.ai
  await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${appId}/domains`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: `${appId}.pelko.ai` }),
    }
  );

  // Worker domain: api-appId.pelko.ai is handled by the wrangler.toml routes config
}

function getFirebaseWebConfig() {
  return {
    apiKey: process.env.FIREBASE_WEB_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_WEB_APP_ID,
  };
}

export default router;
