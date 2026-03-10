import './config/env'; // Validate env vars on startup
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import appsRoutes from './routes/apps';
import builderRoutes from './routes/builder';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: [
    /\.pelko\.ai$/,             // All *.pelko.ai subdomains
    'https://pelko.ai',
    'http://localhost:3000',     // Local development
    'http://localhost:5173',     // Vite dev server
  ],
  credentials: true,
}));

app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Auth routes
app.use('/auth', authRoutes);

// App provisioning routes
app.use('/apps', appsRoutes);

// Builder routes
app.use('/builder', builderRoutes);

// Error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Pelko API running on port ${PORT}`);
});
