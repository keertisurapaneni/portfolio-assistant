import { useState, useEffect, useCallback } from 'react';
import { Link2, Plus, RefreshCw, CheckCircle, XCircle, Clock, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import {
  addUrlsToQueue,
  getQueue,
  processQueue,
  fixUnknownSources,
  type StrategyVideoQueueItem,
  type QueueItemPlatform,
} from '../lib/strategyVideoQueueApi';

const PLATFORM_LABELS: Record<QueueItemPlatform, string> = {
  instagram: 'Instagram',
  twitter: 'Twitter',
  youtube: 'YouTube',
};

function StatusBadge({ status }: { status: StrategyVideoQueueItem['status'] }) {
  const config = {
    pending: { icon: Clock, label: 'Pending', className: 'bg-amber-100 text-amber-800' },
    processing: { icon: RefreshCw, label: 'Processing', className: 'bg-blue-100 text-blue-800' },
    done: { icon: CheckCircle, label: 'Done', className: 'bg-emerald-100 text-emerald-800' },
    failed: { icon: XCircle, label: 'Failed', className: 'bg-red-100 text-red-800' },
  };
  const { icon: Icon, label, className } = config[status];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', className)}>
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

function truncateUrl(url: string, maxLen = 50): string {
  if (url.length <= maxLen) return url;
  return url.slice(0, maxLen - 3) + '...';
}

export function StrategyQueue() {
  const [urls, setUrls] = useState('');
  const [queue, setQueue] = useState<StrategyVideoQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const pendingCount = queue.filter((i) => i.status === 'pending').length;

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const items = await getQueue(50);
      setQueue(items);
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load queue' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const handleSubmit = async () => {
    const lines = urls.split(/\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) {
      setMessage({ type: 'info', text: 'Paste some URLs first' });
      return;
    }

    setSubmitting(true);
    setMessage(null);
    try {
      const { added, invalid } = await addUrlsToQueue(lines);
      setUrls('');
      await loadQueue();
      if (invalid.length > 0) {
        setMessage({
          type: 'error',
          text: `Added ${added}. Invalid (${invalid.length}): ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '...' : ''}`,
        });
      } else {
        setMessage({ type: 'success', text: `Added ${added} URL${added === 1 ? '' : 's'}. Processing...` });
        try {
          const { processed } = await processQueue();
          await loadQueue();
          setMessage({ type: 'success', text: `Added ${added} URL${added === 1 ? '' : 's'}. Processed ${processed} into strategy videos.` });
        } catch (procErr) {
          setMessage({ type: 'error', text: `Added ${added} but processing failed: ${procErr instanceof Error ? procErr.message : 'Unknown error'}` });
          await loadQueue();
        }
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to add URLs' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[hsl(var(--foreground))] flex items-center gap-2">
          <Link2 className="h-7 w-7" />
          Add Strategy Videos
        </h1>
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">
          Paste Instagram, Twitter, or YouTube video URLs. They are processed automatically into strategy videos.
        </p>
      </div>

      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 shadow-sm">
        <label htmlFor="urls" className="block text-sm font-medium text-[hsl(var(--foreground))] mb-2">
          Video URLs (one per line)
        </label>
        <textarea
          id="urls"
          value={urls}
          onChange={e => setUrls(e.target.value)}
          placeholder={'https://www.instagram.com/reel/...\nhttps://twitter.com/.../status/...\nhttps://youtube.com/watch?v=...'}
          rows={6}
          className="w-full rounded-lg border border-[hsl(var(--input))] bg-[hsl(var(--background))] px-4 py-3 text-base placeholder:text-[hsl(var(--muted-foreground))] focus:outline-none focus:ring-2 focus:ring-[hsl(var(--ring))]"
        />
        <button
          onClick={handleSubmit}
          disabled={submitting || !urls.trim()}
          className="mt-3 flex items-center justify-center gap-2 w-full sm:w-auto min-w-[140px] px-6 py-3 rounded-lg bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium shadow-md shadow-blue-500/25 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {submitting ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add to Queue
        </button>
      </div>

      {message && (
        <div
          className={cn(
            'rounded-lg px-4 py-3 text-sm',
            message.type === 'success' && 'bg-emerald-50 text-emerald-800',
            message.type === 'error' && 'bg-red-50 text-red-800',
            message.type === 'info' && 'bg-amber-50 text-amber-800'
          )}
        >
          {message.text}
        </div>
      )}

      <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-[hsl(var(--foreground))]">Videos</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                setFixing(true);
                setMessage(null);
                try {
                  const { fixed } = await fixUnknownSources();
                  setMessage({ type: 'success', text: fixed > 0 ? `Fixed ${fixed} video${fixed === 1 ? '' : 's'} with Unknown source. Refresh Strategy Perf.` : 'No Unknown sources to fix.' });
                } catch (err) {
                  setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Fix failed' });
                } finally {
                  setFixing(false);
                }
              }}
              disabled={fixing}
              className="px-3 py-1.5 text-sm rounded-lg bg-amber-600 text-white hover:opacity-90 disabled:opacity-50"
              title="Re-resolve source for videos showing under Unknown"
            >
              {fixing ? 'Fixing...' : 'Fix Unknown sources'}
            </button>
            <button
              onClick={async () => {
                if (pendingCount === 0) return;
                setProcessing(true);
                setMessage(null);
                try {
                  const { processed } = await processQueue();
                  await loadQueue();
                  setMessage({ type: 'success', text: `Processed ${processed} pending item${processed === 1 ? '' : 's'}.` });
                } catch (err) {
                  setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Processing failed' });
                  await loadQueue();
                } finally {
                  setProcessing(false);
                }
              }}
              disabled={processing || pendingCount === 0}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              title={pendingCount === 0 ? 'No pending videos to process' : `Process ${pendingCount} pending video${pendingCount === 1 ? '' : 's'}`}
            >
              {processing ? 'Processing...' : pendingCount > 0 ? `Process ${pendingCount} pending` : 'Process pending'}
            </button>
            <button
              onClick={loadQueue}
              disabled={loading}
              className="p-2 rounded-lg hover:bg-[hsl(var(--muted))] disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {loading && queue.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] py-4">Loading...</p>
        ) : queue.length === 0 ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] py-4">No videos yet. Paste URLs above to add them.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[hsl(var(--border))]">
                  <th className="text-left py-2 font-medium text-[hsl(var(--foreground))]">Video</th>
                  <th className="text-left py-2 font-medium text-[hsl(var(--foreground))]">Platform</th>
                  <th className="text-left py-2 font-medium text-[hsl(var(--foreground))]">Added</th>
                  <th className="text-left py-2 font-medium text-[hsl(var(--foreground))]">Status</th>
                </tr>
              </thead>
              <tbody>
                {queue.map(item => (
                  <tr key={item.id} className="border-b border-[hsl(var(--border))] last:border-0">
                    <td className="py-2">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline truncate block max-w-[200px]"
                      >
                        {truncateUrl(item.url)}
                      </a>
                    </td>
                    <td className="py-2 text-[hsl(var(--muted-foreground))]">
                      {item.platform ? PLATFORM_LABELS[item.platform] : '—'}
                    </td>
                    <td className="py-2 text-[hsl(var(--muted-foreground))]">
                      {item.created_at ? new Date(item.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                    </td>
                    <td className="py-2">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={item.status} />
                        {item.error_message && (
                          <span className="text-red-600" title={item.error_message}>
                            <AlertCircle className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
