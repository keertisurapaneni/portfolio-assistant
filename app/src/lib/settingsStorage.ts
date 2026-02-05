/**
 * Portfolio Settings Storage
 * Manages user preferences and risk profile
 */

import type { PortfolioSettings, RiskProfile } from '../types';

const SETTINGS_KEY = 'portfolio-settings';

const DEFAULT_SETTINGS: PortfolioSettings = {
  riskProfile: 'moderate',
  portfolioPeakValue: undefined,
  lastPeakDate: undefined,
};

/**
 * Get current portfolio settings
 */
export function getSettings(): PortfolioSettings {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(stored) };
    }
  } catch (error) {
    console.error('[Settings] Failed to load settings:', error);
  }
  return DEFAULT_SETTINGS;
}

/**
 * Update portfolio settings
 */
export function updateSettings(updates: Partial<PortfolioSettings>): void {
  try {
    const current = getSettings();
    const updated = { ...current, ...updates };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('[Settings] Failed to save settings:', error);
  }
}

/**
 * Get current risk profile
 */
export function getRiskProfile(): RiskProfile {
  return getSettings().riskProfile;
}

/**
 * Update risk profile
 */
export function setRiskProfile(profile: RiskProfile): void {
  updateSettings({ riskProfile: profile });
}

/**
 * Update portfolio peak for drawdown calculation
 */
export function updatePortfolioPeak(value: number): void {
  const settings = getSettings();
  
  // Only update if new value is higher than previous peak
  if (!settings.portfolioPeakValue || value > settings.portfolioPeakValue) {
    updateSettings({
      portfolioPeakValue: value,
      lastPeakDate: new Date().toISOString(),
    });
  }
}

/**
 * Calculate current drawdown percentage
 * Returns null if no peak value set
 */
export function calculateDrawdown(currentValue: number): number | null {
  const settings = getSettings();
  
  if (!settings.portfolioPeakValue) {
    // First time - set as peak
    updatePortfolioPeak(currentValue);
    return 0;
  }
  
  // Update peak if current value is higher
  if (currentValue > settings.portfolioPeakValue) {
    updatePortfolioPeak(currentValue);
    return 0;
  }
  
  // Calculate drawdown
  const drawdown = ((currentValue - settings.portfolioPeakValue) / settings.portfolioPeakValue) * 100;
  return drawdown;
}
