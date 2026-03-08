import rateLimit from 'express-rate-limit';

// Rate limit code requests: max 5 per phone/email per 15 minutes per app
export const codeRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    const appId = req.headers['x-app-id'] as string;
    const target = req.body.phone || req.body.email;
    return `${appId}:${target}`;
  },
  message: { error: 'Too many code requests. Try again later.' },
});

// Rate limit code verification: max 10 per phone/email per 15 minutes per app
export const codeVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    const appId = req.headers['x-app-id'] as string;
    const target = req.body.phone || req.body.email;
    return `${appId}:${target}`;
  },
  message: { error: 'Too many verification attempts. Try again later.' },
});
