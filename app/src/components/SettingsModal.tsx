/**
 * Settings Modal - Risk Profile Selection
 */

import { useState } from 'react';
import type { RiskProfile } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentProfile: RiskProfile;
  onProfileChange: (profile: RiskProfile) => void;
}

const RISK_PROFILES: {
  id: RiskProfile;
  name: string;
  description: string;
  aiStyle: string;
  thresholds: {
    stopLoss: string;
    maxPosition: string;
  };
}[] = [
  {
    id: 'aggressive',
    name: 'Aggressive',
    description: 'More buy signals on dips, higher tolerance for volatility',
    aiStyle: 'Leans into fear dips on decent stocks',
    thresholds: {
      stopLoss: '-4%',
      maxPosition: '30%',
    },
  },
  {
    id: 'moderate',
    name: 'Moderate',
    description: 'Balanced — acts when conviction is clear',
    aiStyle: 'Buys quality dips, cautious on weak names',
    thresholds: {
      stopLoss: '-7%',
      maxPosition: '25%',
    },
  },
  {
    id: 'conservative',
    name: 'Conservative',
    description: 'Capital preservation first, acts only on high conviction',
    aiStyle: 'Rarely signals buy — only obvious setups',
    thresholds: {
      stopLoss: '-5%',
      maxPosition: '20%',
    },
  },
];

export default function SettingsModal({
  isOpen,
  onClose,
  currentProfile,
  onProfileChange,
}: SettingsModalProps) {
  const [selectedProfile, setSelectedProfile] = useState<RiskProfile>(currentProfile);

  if (!isOpen) return null;

  const handleSave = () => {
    onProfileChange(selectedProfile);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl font-bold text-gray-900">Portfolio Settings</h2>
              <p className="mt-1 text-sm text-gray-600">
                Choose your risk profile to customize trading thresholds
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <div className="space-y-3">
            {RISK_PROFILES.map(profile => (
              <div
                key={profile.id}
                onClick={() => setSelectedProfile(profile.id)}
                className={`
                  relative border-2 rounded-lg p-5 cursor-pointer transition-all
                  ${
                    selectedProfile === profile.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300 bg-white'
                  }
                `}
              >
                <div className="flex items-start gap-4">
                  {/* Radio Button */}
                  <div className="flex-shrink-0 mt-1">
                    <div
                      className={`
                        w-5 h-5 rounded-full border-2 flex items-center justify-center
                        ${
                          selectedProfile === profile.id
                            ? 'border-blue-500 bg-blue-500'
                            : 'border-gray-300'
                        }
                      `}
                    >
                      {selectedProfile === profile.id && (
                        <div className="w-2 h-2 rounded-full bg-white" />
                      )}
                    </div>
                  </div>

                  {/* Profile Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-lg font-semibold text-gray-900">{profile.name}</h3>
                      {currentProfile === profile.id && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded">
                          Current
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600 mb-2">{profile.description}</p>

                    {/* AI Style */}
                    <div className="mb-3">
                      <span className="text-xs font-medium text-gray-500 uppercase">
                        AI Behavior
                      </span>
                      <p className="text-sm font-medium text-gray-900">{profile.aiStyle}</p>
                    </div>

                    {/* Thresholds */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-xs font-medium text-gray-500">Stop-Loss</span>
                        <p className="text-sm font-semibold text-red-600">
                          {profile.thresholds.stopLoss}
                        </p>
                      </div>
                      <div>
                        <span className="text-xs font-medium text-gray-500">Max Position</span>
                        <p className="text-sm font-semibold text-blue-600">
                          {profile.thresholds.maxPosition}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Info Note */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex gap-3">
              <svg
                className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                  clipRule="evenodd"
                />
              </svg>
              <div>
                <h4 className="text-sm font-semibold text-blue-900 mb-1">
                  How this works
                </h4>
                <p className="text-sm text-blue-800">
                  Your risk profile controls how the AI analyst behaves — aggressive sees more
                  buy opportunities on dips, conservative only flags high-conviction setups.
                  Stop-loss and position limits are enforced automatically.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 bg-gray-50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={selectedProfile === currentProfile}
            className={`
              px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors
              ${
                selectedProfile === currentProfile
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700'
              }
            `}
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
