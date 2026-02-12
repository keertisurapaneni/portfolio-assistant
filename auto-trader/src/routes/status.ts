/**
 * GET /api/status — connection state and account info
 */

import { Router } from 'express';
import { isConnected, getAccounts, getDefaultAccount } from '../ib-connection.js';

const router = Router();

router.get('/status', (_req, res) => {
  const account = getDefaultAccount();
  res.json({
    connected: isConnected(),
    accounts: getAccounts(),
    defaultAccount: account,
    // Map to the shape the web app expects (IBAuthStatus)
    authenticated: isConnected(),
  });
});

export default router;
