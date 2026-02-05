/**
 * Portfolio Warning System
 * 
 * Implements traditional risk management guardrails:
 * 1. Position concentration warnings (>15% of portfolio)
 * 2. Loss alerts (down >8% from cost basis)
 * 3. Gain alerts for potential profit-taking
 */

export interface Warning {
  type: 'concentration' | 'loss' | 'gain' | 'rebalance';
  severity: 'info' | 'warning' | 'critical';
  message: string;
  action?: string;
}

// Thresholds (could be made configurable)
const CONCENTRATION_WARNING = 15;   // % of portfolio - warning
const CONCENTRATION_CRITICAL = 25;  // % of portfolio - critical
const STOP_LOSS_WARNING = 8;        // % loss from cost - warning
const STOP_LOSS_CRITICAL = 15;      // % loss from cost - critical
const GAIN_THRESHOLD = 25;          // % gain - consider taking profits

export interface WarningInputs {
  ticker: string;
  portfolioWeight?: number;       // Current weight in portfolio (%)
  avgCost?: number;               // Average cost basis
  currentPrice?: number;          // Current market price
  targetWeight?: number;          // User's target allocation (%)
}

/**
 * Get all warnings for a stock position
 */
export function getWarnings(inputs: WarningInputs): Warning[] {
  const warnings: Warning[] = [];

  // 1. Concentration Warning
  if (inputs.portfolioWeight !== undefined) {
    if (inputs.portfolioWeight >= CONCENTRATION_CRITICAL) {
      warnings.push({
        type: 'concentration',
        severity: 'critical',
        message: `⚠️ ${inputs.portfolioWeight}% of portfolio - highly concentrated`,
        action: 'Consider trimming to reduce single-stock risk',
      });
    } else if (inputs.portfolioWeight >= CONCENTRATION_WARNING) {
      warnings.push({
        type: 'concentration',
        severity: 'warning',
        message: `Position is ${inputs.portfolioWeight}% of portfolio`,
        action: 'Monitor concentration risk',
      });
    }
  }

  // 2. Loss Alert (only if we have cost basis and current price)
  if (inputs.avgCost && inputs.currentPrice && inputs.avgCost > 0) {
    const lossPercent = ((inputs.avgCost - inputs.currentPrice) / inputs.avgCost) * 100;
    
    if (lossPercent >= STOP_LOSS_CRITICAL) {
      warnings.push({
        type: 'loss',
        severity: 'critical',
        message: `🔴 Down ${lossPercent.toFixed(1)}% from cost basis`,
        action: 'Review thesis - significant loss warrants reassessment',
      });
    } else if (lossPercent >= STOP_LOSS_WARNING) {
      warnings.push({
        type: 'loss',
        severity: 'warning',
        message: `Down ${lossPercent.toFixed(1)}% from cost basis`,
        action: 'Review thesis - is the original investment case still valid?',
      });
    }
  }

  // 3. Gain Alert (for profit-taking consideration)
  if (inputs.avgCost && inputs.currentPrice && inputs.avgCost > 0) {
    const gainPercent = ((inputs.currentPrice - inputs.avgCost) / inputs.avgCost) * 100;
    
    if (gainPercent >= GAIN_THRESHOLD) {
      warnings.push({
        type: 'gain',
        severity: 'info',
        message: `📈 Up ${gainPercent.toFixed(1)}% from cost basis`,
        action: 'Consider taking partial profits if thesis is weakening',
      });
    }
  }

  // 4. Rebalance Alert (if target weight is set)
  if (inputs.targetWeight !== undefined && inputs.portfolioWeight !== undefined) {
    const deviation = Math.abs(inputs.portfolioWeight - inputs.targetWeight);
    if (deviation >= 5) {
      const direction = inputs.portfolioWeight > inputs.targetWeight ? 'overweight' : 'underweight';
      warnings.push({
        type: 'rebalance',
        severity: 'info',
        message: `${direction === 'overweight' ? '↑' : '↓'} ${deviation.toFixed(1)}% ${direction} vs target`,
        action: direction === 'overweight' ? 'Consider trimming' : 'Consider adding',
      });
    }
  }

  return warnings;
}

/**
 * Get the most severe warning for quick display
 */
export function getMostSevereWarning(warnings: Warning[]): Warning | null {
  if (warnings.length === 0) return null;
  
  // Sort by severity: critical > warning > info
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  return warnings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])[0];
}

/**
 * Format warning for compact display
 */
export function formatWarningBadge(warning: Warning): { text: string; className: string } {
  switch (warning.severity) {
    case 'critical':
      return {
        text: warning.type === 'loss' ? '🔴 Loss' : '⚠️ Concentrated',
        className: 'bg-red-100 text-red-700 border-red-200',
      };
    case 'warning':
      return {
        text: warning.type === 'loss' ? '↓ Loss' : '↑ Weight',
        className: 'bg-amber-100 text-amber-700 border-amber-200',
      };
    case 'info':
      return {
        text: warning.type === 'gain' ? '📈 Gain' : '⚖️ Rebalance',
        className: 'bg-blue-100 text-blue-700 border-blue-200',
      };
  }
}
