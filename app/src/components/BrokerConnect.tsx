import { useState, useEffect, useCallback } from 'react';
import { Link2, RefreshCw, Unlink, Loader2, Check, AlertCircle } from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  getBrokerStatus, connectBroker, getBrokerPortalUrl,
  syncBrokerPositions, disconnectBroker,
  type BrokerStatus, type SyncResult,
} from '../lib/brokerApi';

interface BrokerConnectProps {
  onSyncComplete: (result: SyncResult) => void;
}

export function BrokerConnect({ onSyncComplete }: BrokerConnectProps) {
  const { user } = useAuth();
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!user) return;
    try { setStatus(await getBrokerStatus()); } catch { /* silent */ }
  }, [user]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleConnect = async () => {
    setError(null); setLoading(true);
    try {
      const url = status?.connected ? await getBrokerPortalUrl() : await connectBroker();
      const popup = window.open(url, 'snaptrade', 'width=600,height=700');
      const poll = setInterval(async () => {
        if (popup?.closed) {
          clearInterval(poll);
          setLoading(false);
          // Try to sync after popup closes — silently ignore "no accounts" errors
          // (user may have browsed but not linked a brokerage)
          await handleSync(true);
          await loadStatus();
        }
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setLoading(false);
    }
  };

  const handleSync = async (silent = false) => {
    setError(null); setSuccessMsg(null); setSyncing(true);
    try {
      const result = await syncBrokerPositions();
      onSyncComplete(result);
      await loadStatus();
      setSuccessMsg(`Synced ${result.stats.total} positions (${result.stats.added} added, ${result.stats.updated} updated)`);
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err) {
      // In silent mode, don't show the error (e.g. user closed popup without linking a broker)
      if (!silent) setError(err instanceof Error ? err.message : 'Sync failed');
    }
    finally { setSyncing(false); }
  };

  const handleDisconnect = async () => {
    setShowDisconnectConfirm(false); setError(null); setLoading(true);
    try {
      await disconnectBroker();
      setStatus({ connected: false, lastSyncedAt: null, createdAt: null });
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to disconnect'); }
    finally { setLoading(false); }
  };

  if (!user) return null;

  const relTime = (iso: string | null) => {
    if (!iso) return null;
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <div className="flex items-center gap-2">
      {error && (
        <div className="flex items-center gap-1 text-xs text-red-600 bg-red-50 px-2 py-1 rounded-lg">
          <AlertCircle className="w-3 h-3 flex-shrink-0" /><span className="max-w-[280px] truncate">{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="flex items-center gap-1 text-xs text-green-700 bg-green-50 px-2 py-1 rounded-lg">
          <Check className="w-3 h-3" /><span>{successMsg}</span>
        </div>
      )}

      {status?.connected ? (
        <>
          <button onClick={handleSync} disabled={syncing || loading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-60 transition-colors"
            title={status.lastSyncedAt ? `Last synced: ${new Date(status.lastSyncedAt).toLocaleString()}` : 'Sync positions'}>
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            {syncing ? 'Syncing...' : 'Sync'}
            {status.lastSyncedAt && !syncing && <span className="text-green-500 ml-0.5">{relTime(status.lastSyncedAt)}</span>}
          </button>
          <button onClick={handleConnect} disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-[hsl(var(--input))] text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--secondary))] disabled:opacity-60 transition-colors"
            title="Connect another broker">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
          </button>
          <div className="relative">
            <button onClick={() => setShowDisconnectConfirm(true)}
              className="p-1.5 text-[hsl(var(--muted-foreground))] hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Disconnect broker">
              <Unlink className="w-3.5 h-3.5" />
            </button>
            {showDisconnectConfirm && (
              <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border p-3 z-50 w-52">
                <p className="text-xs text-[hsl(var(--foreground))] mb-2">Disconnect broker? Portfolio data stays, auto-sync stops.</p>
                <div className="flex gap-2">
                  <button onClick={handleDisconnect} className="px-3 py-1 text-xs font-medium rounded bg-red-500 text-white hover:bg-red-600">Disconnect</button>
                  <button onClick={() => setShowDisconnectConfirm(false)} className="px-3 py-1 text-xs font-medium rounded border hover:bg-[hsl(var(--secondary))]">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <button onClick={handleConnect} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-60 transition-colors">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
          Connect Broker
        </button>
      )}
    </div>
  );
}
