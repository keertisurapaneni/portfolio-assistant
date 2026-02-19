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
