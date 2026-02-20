/**
 * Strategy Video Queue API — add and list video URLs for later processing.
 * Supports Instagram, Twitter/X, and YouTube.
 */

import { supabase } from './supabaseClient';

export type QueueItemPlatform = 'instagram' | 'twitter' | 'youtube';

export interface StrategyVideoQueueItem {
  id: string;
  url: string;
  platform: QueueItemPlatform | null;
  status: 'pending' | 'processing' | 'done' | 'failed';
  error_message: string | null;
  strategy_video_id: string | null;
  strategy_type: 'daily_signal' | 'generic_strategy' | null;
  created_at: string;
  processed_at: string | null;
}

const INSTAGRAM_REEL = /instagram\.com\/(?:[^/]+\/)?reel\/([A-Za-z0-9_-]+)/i;
const TWITTER_STATUS = /(?:twitter|x)\.com\/(?:[^/]+\/)?status\/(\d+)/i;
const YOUTUBE = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

export function parseVideoUrl(url: string): { platform: QueueItemPlatform; id: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  let m = INSTAGRAM_REEL.exec(trimmed);
  if (m) return { platform: 'instagram', id: m[1] };

  m = TWITTER_STATUS.exec(trimmed);
  if (m) return { platform: 'twitter', id: m[1] };

  m = YOUTUBE.exec(trimmed);
  if (m) return { platform: 'youtube', id: m[1] };

  return null;
}

export function isValidVideoUrl(url: string): boolean {
  return parseVideoUrl(url) !== null;
}

export async function addUrlsToQueue(urls: string[]): Promise<{ added: number; invalid: string[] }> {
  const invalid: string[] = [];
  const toInsert: { url: string; platform: string }[] = [];

  for (const raw of urls) {
    const url = raw.trim();
    if (!url) continue;
    const parsed = parseVideoUrl(url);
    if (parsed) {
      toInsert.push({ url, platform: parsed.platform });
    } else {
      invalid.push(url);
    }
  }

  if (toInsert.length === 0) {
    return { added: 0, invalid };
  }

  const { error } = await supabase
    .from('strategy_video_queue')
    .insert(toInsert.map(({ url, platform }) => ({ url, platform, status: 'pending' })));

  if (error) throw new Error(`Failed to add URLs: ${error.message}`);
  return { added: toInsert.length, invalid };
}

export async function getQueue(limit = 50): Promise<StrategyVideoQueueItem[]> {
  const { data, error } = await supabase
    .from('strategy_video_queue')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to fetch queue: ${error.message}`);
  return (data ?? []) as StrategyVideoQueueItem[];
}

/** Manually assign Unknown videos to a known source (when auto-fix fails) */
export async function assignUnknownToSource(params: {
  source_handle: string;
  source_name: string;
  video_ids?: string[];
}): Promise<{ assigned: number; video_ids: string[] }> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/assign-strategy-videos-to-source`;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && { Authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `Assign failed: ${res.status}`);
  }
  const data = await res.json();
  return { assigned: data.assigned ?? 0, video_ids: data.video_ids ?? [] };
}

/** Fix strategy_videos with source_name = 'Unknown' by re-resolving from URL */
export async function fixUnknownSources(): Promise<{ fixed: number; results: { video_id: string; source_name: string; status: 'fixed' | 'failed' }[] }> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fix-unknown-strategy-sources`;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && { Authorization: `Bearer ${key}` }),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `Fix failed: ${res.status}`);
  }
  const data = await res.json();
  return { fixed: data.fixed ?? 0, results: data.results ?? [] };
}

/** Trigger processing of pending queue items (creates strategy_videos entries) */
export async function processQueue(): Promise<{ processed: number; results: { id: string; status: 'done' | 'failed'; error?: string }[] }> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-strategy-video-queue`;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key && { Authorization: `Bearer ${key}` }),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? `Process failed: ${res.status}`);
  }
  const data = await res.json();
  return { processed: data.processed ?? 0, results: data.results ?? [] };
}
