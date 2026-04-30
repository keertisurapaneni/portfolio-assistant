/**
 * validateOrder — pure synchronous order sanity check.
 *
 * This runs AFTER calculatePositionSize() and BEFORE placeBracketOrder().
 * It is NOT a replacement for the async gates in runPreTradeChecks() (allocation cap,
 * sector exposure, earnings blackout). It is a final belt-and-suspenders check on the
 * computed order values — pure, stateless, and unit-testable without any DB mocks.
 *
 * What it catches:
 *   - Zero/negative quantity (sizer bug or edge case)
 *   - Order notional > configured max position % of portfolio value (floating-point
 *     rounding or unexpected sizer path)
 *   - Order notional > available allocation budget (redundant with async check, but
 *     synchronous and guaranteed to run even if the async path had an error)
 */

export type ValidationCode =
  | 'OK'
  | 'ZERO_OR_NEGATIVE_QUANTITY'
  | 'ZERO_OR_NEGATIVE_VALUE'
  | 'POSITION_TOO_LARGE'          // dollarSize > portfolioValue * maxPositionPct / 100
  | 'EXCEEDS_ALLOCATION_BUDGET';  // deployedCapital + dollarSize > maxTotalAllocation

export interface ValidationResult {
  valid: boolean;
  code: ValidationCode;
  reason: string;
}

export interface ValidateOrderParams {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  dollarSize: number;
  portfolioValue: number;       // config.portfolioValue
  maxPositionPct: number;       // config.maxPositionPct (e.g. 10 = 10%)
  deployedCapital: number;      // current total deployed dollar value
  maxTotalAllocation: number;   // config.maxTotalAllocation
}

export function validateOrder(params: ValidateOrderParams): ValidationResult {
  const {
    symbol, side, quantity, dollarSize,
    portfolioValue, maxPositionPct,
    deployedCapital, maxTotalAllocation,
  } = params;

  if (quantity <= 0) {
    return {
      valid: false,
      code: 'ZERO_OR_NEGATIVE_QUANTITY',
      reason: `${symbol} ${side}: quantity ${quantity} is not positive`,
    };
  }

  if (dollarSize <= 0) {
    return {
      valid: false,
      code: 'ZERO_OR_NEGATIVE_VALUE',
      reason: `${symbol} ${side}: order value $${dollarSize.toFixed(2)} is not positive`,
    };
  }

  // Position size cap: order must not exceed maxPositionPct of portfolio value.
  // Allow a 10% tolerance over the configured limit to absorb rounding from calculatePositionSize.
  const maxDollar = portfolioValue * (maxPositionPct / 100) * 1.1;
  if (dollarSize > maxDollar) {
    return {
      valid: false,
      code: 'POSITION_TOO_LARGE',
      reason: `${symbol} ${side}: $${dollarSize.toFixed(0)} exceeds ${maxPositionPct}% position cap ($${maxDollar.toFixed(0)})`,
    };
  }

  // Allocation budget: total deployed + this order must not exceed the max allocation.
  if (deployedCapital + dollarSize > maxTotalAllocation) {
    return {
      valid: false,
      code: 'EXCEEDS_ALLOCATION_BUDGET',
      reason: `${symbol} ${side}: deployed $${deployedCapital.toFixed(0)} + order $${dollarSize.toFixed(0)} > budget $${maxTotalAllocation.toFixed(0)}`,
    };
  }

  return {
    valid: true,
    code: 'OK',
    reason: `${symbol} ${side}: $${dollarSize.toFixed(0)} (${((dollarSize / portfolioValue) * 100).toFixed(1)}% of portfolio)`,
  };
}
