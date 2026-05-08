/**
 * GET /api/status — connection state and account info
 */

import { Router } from 'express';
import { isConnected, getAccounts, getDefaultAccount, getDailyPnL } from '../ib-connection.js';

const router = Router();

router.get('/status', (_req, res) => {
  const account = getDefaultAccount();
  res.json({
    connected: isConnected(),
    accounts: getAccounts(),
    defaultAccount: account,
    authenticated: isConnected(),
  });
});

router.get('/account-pnl', (_req, res) => {
  if (!isConnected()) {
    res.json({ dailyPnL: null, unrealizedPnL: null, realizedPnL: null });
    return;
  }
  res.json(getDailyPnL());
});

export default router;
