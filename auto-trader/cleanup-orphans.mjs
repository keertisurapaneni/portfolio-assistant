/**
 * cleanup-orphans.mjs — Liquidate orphaned long positions in IB paper account.
 *
 * These positions were created by the auto-trader but their paper_trade records
 * were incorrectly marked CLOSED while IB still held the shares.
 *
 * Usage:
 *   node cleanup-orphans.mjs            # DRY RUN — logs what it would do
 *   node cleanup-orphans.mjs --execute  # LIVE — actually places sell orders
 *
 * Must be run during market hours (9:30 AM – 4:00 PM ET).
 */

import { IBApi, EventName, OrderAction, OrderType, SecType, TimeInForce } from '@stoqey/ib';

const IB_HOST = '127.0.0.1';
const IB_PORT = 4002;
const CLIENT_ID = 99; // unique clientId to avoid conflict with running auto-trader (clientId=1)

const EXECUTE = process.argv.includes('--execute');
const ORDER_TIMEOUT_MS = 30_000;

const ORPHANED_POSITIONS = {
  SNDK: 6,
  INTC: 45,
  DIA: 10,
  MCW: 2842,
  TSLA: 26,
  STX: 7,
  WMT: 38,
  NFLX: 219,
  HOOD: 65,
  GOOGL: 12,
  QQQ: 21,
  SPY: 41,
  BE: 34,
  DNTH: 14,
  NXPI: 17,
};

function log(msg) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  console.log(`[${ts}] ${msg}`);
}

function isMarketOpen() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

async function main() {
  log('=== Orphaned Position Cleanup Script ===');
  log(`Mode: ${EXECUTE ? '🔴 LIVE — orders WILL be placed' : '🟡 DRY RUN — no orders will be placed'}`);
  log(`Tickers to liquidate: ${Object.keys(ORPHANED_POSITIONS).join(', ')}`);
  log('');

  if (EXECUTE && !isMarketOpen()) {
    log('❌ Market is closed. Cannot place orders outside 9:30 AM – 4:00 PM ET.');
    log('   Re-run during market hours.');
    process.exit(1);
  }

  const ib = new IBApi({ host: IB_HOST, port: IB_PORT, clientId: CLIENT_ID });
  let nextOrderId = 0;
  let connected = false;

  // Wait for connection + nextValidId
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout (15s)')), 15_000);

    ib.on(EventName.connected, () => {
      connected = true;
      log('✓ Connected to IB Gateway');
      ib.reqIds();
    });

    ib.on(EventName.nextValidId, (orderId) => {
      nextOrderId = orderId;
      log(`✓ Next valid order ID: ${nextOrderId}`);
      clearTimeout(timeout);
      resolve();
    });

    ib.on(EventName.error, (err, code) => {
      const infoOnly = code && [2104, 2106, 2108, 2158].includes(code);
      if (infoOnly) return;
      if (!connected) {
        clearTimeout(timeout);
        reject(new Error(`Connection error (code=${code}): ${err.message}`));
      }
    });

    log(`Connecting to ${IB_HOST}:${IB_PORT} (clientId=${CLIENT_ID})...`);
    ib.connect();
  });

  // Request all positions
  log('');
  log('Fetching current IB positions...');
  const positions = await new Promise((resolve) => {
    const result = [];
    const timeout = setTimeout(() => resolve(result), 10_000);

    ib.on(EventName.position, (_account, contract, pos, avgCost) => {
      if (pos !== 0) {
        result.push({ symbol: contract.symbol, secType: contract.secType, position: pos, avgCost });
      }
    });

    ib.on(EventName.positionEnd, () => {
      clearTimeout(timeout);
      resolve(result);
    });

    ib.reqPositions();
  });

  log(`Found ${positions.length} non-zero positions in IB`);
  log('');

  // Build lookup of IB positions (STK only)
  const ibPositions = new Map();
  for (const p of positions) {
    if (p.secType === 'STK' || p.secType === SecType.STK) {
      ibPositions.set(p.symbol, p);
    }
  }

  // Verify and process each orphan
  const results = [];
  let ordersFilled = 0;
  let ordersSkipped = 0;
  let ordersFailed = 0;

  for (const [ticker, expectedQty] of Object.entries(ORPHANED_POSITIONS)) {
    const ibPos = ibPositions.get(ticker);

    if (!ibPos) {
      log(`⚠️  ${ticker}: NOT found in IB — already liquidated or never existed. Skipping.`);
      results.push({ ticker, status: 'NOT_IN_IB', detail: 'Position not found' });
      ordersSkipped++;
      continue;
    }

    if (ibPos.position <= 0) {
      log(`⚠️  ${ticker}: IB position is ${ibPos.position} (not long). Skipping.`);
      results.push({ ticker, status: 'NOT_LONG', detail: `Position=${ibPos.position}` });
      ordersSkipped++;
      continue;
    }

    if (ibPos.position !== expectedQty) {
      log(`⚠️  ${ticker}: IB qty=${ibPos.position} but expected=${expectedQty}. QUANTITY MISMATCH — skipping for safety.`);
      results.push({ ticker, status: 'QTY_MISMATCH', detail: `IB=${ibPos.position}, expected=${expectedQty}` });
      ordersSkipped++;
      continue;
    }

    // Position verified
    const avgCost = ibPos.avgCost.toFixed(2);
    const notional = (ibPos.position * ibPos.avgCost).toFixed(2);

    if (!EXECUTE) {
      log(`✓ ${ticker}: WOULD SELL ${expectedQty} shares (avgCost=$${avgCost}, notional=$${notional})`);
      results.push({ ticker, status: 'DRY_RUN', detail: `${expectedQty} shares @ $${avgCost}` });
      continue;
    }

    // Place market sell order
    log(`→ ${ticker}: Selling ${expectedQty} shares (avgCost=$${avgCost})...`);

    const orderId = nextOrderId++;
    const contract = {
      symbol: ticker,
      secType: SecType.STK,
      exchange: 'SMART',
      currency: 'USD',
    };
    const order = {
      action: OrderAction.SELL,
      orderType: OrderType.MKT,
      totalQuantity: expectedQty,
      tif: TimeInForce.DAY,
      transmit: true,
    };

    try {
      const fillResult = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Order ${orderId} timed out after ${ORDER_TIMEOUT_MS / 1000}s`));
        }, ORDER_TIMEOUT_MS);

        const statusHandler = (oid, status, filled, _remaining, avgFillPrice) => {
          if (oid !== orderId) return;
          if (status === 'Filled') {
            clearTimeout(timer);
            ib.off(EventName.orderStatus, statusHandler);
            resolve({ orderId: oid, avgFillPrice, filledQty: filled });
          } else if (status === 'Cancelled' || status === 'Inactive') {
            clearTimeout(timer);
            ib.off(EventName.orderStatus, statusHandler);
            reject(new Error(`Order ${oid} ${status}`));
          }
        };

        ib.on(EventName.orderStatus, statusHandler);
        ib.placeOrder(orderId, contract, order);
      });

      log(`  ✓ ${ticker}: FILLED ${fillResult.filledQty} shares @ $${fillResult.avgFillPrice.toFixed(4)} (orderId=${fillResult.orderId})`);
      results.push({ ticker, status: 'FILLED', detail: `${fillResult.filledQty} @ $${fillResult.avgFillPrice.toFixed(4)}` });
      ordersFilled++;
    } catch (err) {
      log(`  ❌ ${ticker}: FAILED — ${err.message}`);
      results.push({ ticker, status: 'FAILED', detail: err.message });
      ordersFailed++;
    }

    // Small delay between orders to avoid overwhelming the gateway
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  log('');
  log('=== SUMMARY ===');
  log(`Total orphans:  ${Object.keys(ORPHANED_POSITIONS).length}`);
  if (EXECUTE) {
    log(`Filled:         ${ordersFilled}`);
    log(`Failed:         ${ordersFailed}`);
    log(`Skipped:        ${ordersSkipped}`);
  } else {
    log(`Would sell:     ${results.filter(r => r.status === 'DRY_RUN').length}`);
    log(`Skipped:        ${ordersSkipped}`);
    log('');
    log('To execute for real, run:  node cleanup-orphans.mjs --execute');
  }

  log('');
  log('Results:');
  for (const r of results) {
    log(`  ${r.ticker.padEnd(6)} ${r.status.padEnd(14)} ${r.detail}`);
  }

  // Disconnect
  log('');
  log('Disconnecting from IB...');
  try { ib.disconnect(); } catch { /* ignore */ }
  log('Done.');

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
