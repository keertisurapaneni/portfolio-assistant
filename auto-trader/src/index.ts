/**
 * auto-trader — local Node.js service bridging the web app to IB Gateway.
 *
 * Architecture:
 *   Web App (localhost:5173) → REST (localhost:3001) → TWS API → IB Gateway (port 4002)
 *
 * No daily login required — IBC auto-starts IB Gateway with saved credentials.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { connect, isConnected, getAccounts, onConnectionChange } from './ib-connection.js';
import statusRoutes from './routes/status.js';
import contractRoutes from './routes/contracts.js';
import orderRoutes from './routes/orders.js';
import positionRoutes from './routes/positions.js';
import marketDataRoutes from './routes/market-data.js';
import schedulerRoutes from './routes/scheduler.js';
import strategyRoutes from './routes/strategies.js';
import performanceLogRoutes from './routes/performance-log.js';
import paperTradingRoutes from './routes/paper-trading.js';
import optionsRoutes from './routes/options.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const app = express();

// ── Middleware ────────────────────────────────────────────

app.use(cors({
  origin: [
    'http://localhost:5173',    // Vite dev server
    'http://localhost:4173',    // Vite preview
    'https://portfolioassistant.org',
    /\.vercel\.app$/,           // Vercel preview deployments
  ],
  credentials: true,
}));

app.use(express.json());

// ── Health check (no auth needed) ────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ── API routes ───────────────────────────────────────────

app.use('/api', statusRoutes);
app.use('/api', contractRoutes);
app.use('/api', orderRoutes);
app.use('/api', positionRoutes);
app.use('/api', marketDataRoutes);
app.use('/api', schedulerRoutes);
app.use('/api', strategyRoutes);
app.use('/api', performanceLogRoutes);
app.use('/api', paperTradingRoutes);
app.use('/api', optionsRoutes);

// ── Compatibility endpoints (match old CPGW paths) ──────

// The web app's ibClient.ts used to call these CPGW paths.
// We remap them here so the client can use the same paths.

app.post('/iserver/auth/status', (_req, res) => {
  res.json({
    authenticated: isConnected(),
    connected: isConnected(),
    competing: false,
  });
});

app.post('/tickle', (_req, res) => {
  res.json({ session: isConnected() ? 'active' : 'inactive' });
});

app.get('/iserver/accounts', (_req, res) => {
  res.json({ accounts: getAccounts() });
});

// ── Start ────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Auto-trader service running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Status: http://localhost:${PORT}/api/status\n`);

  // Connect to IB Gateway
  connect();

  onConnectionChange((state) => {
    if (state) {
      console.log('✅ IB Gateway connected — ready to trade');
      startScheduler();
    } else {
      console.log('⚠️  IB Gateway disconnected — will auto-reconnect');
    }
  });
});

// ── Graceful shutdown ────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\nShutting down auto-trader...');
  stopScheduler();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down auto-trader...');
  stopScheduler();
  process.exit(0);
});
