import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Calendar, BarChart2, Newspaper, Star, ChevronRight, RefreshCw, Clock, AlertCircle, Zap } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
);
import { cn } from '../lib/utils';

// ── Types ────────────────────────────────────────────────

interface EconEvent {
  time_et: string;
  event: string;
  prior: string | null;
  estimate: string | null;
  importance: 'high' | 'medium' | 'low';
}

interface EarningsItem {
  ticker: string;
  when: string;
  note: string;
  direction: 'bullish' | 'bearish' | 'neutral' | 'volatile';
}

interface TopMover {
  ticker: string;
  direction: 'bullish' | 'bearish' | 'neutral' | 'volatile';
  catalyst: string;
  why: string;
}

interface ResearchTheme {
  theme: string;
  tickers: string[];
  note: string;
}

interface SecondaryName {
  ticker: string;
  direction: 'bullish' | 'bearish' | 'neutral' | 'volatile';
  note: string;
}

interface MorningBrief {
  id: string;
  brief_date: string;
  macro_snapshot: string;
  macro_tone: string;
  economic_events: EconEvent[];
  earnings: EarningsItem[];
  top_movers: TopMover[];
  research_themes: ResearchTheme[];
  secondary_names: SecondaryName[];
  week_ahead: string;
  raw_news_count: number;
  generated_at: string;
}

// ── Helpers ──────────────────────────────────────────────

function directionIcon(d: string) {
  if (d === 'bullish') return <TrendingUp className="w-4 h-4 text-emerald-500" />;
  if (d === 'bearish') return <TrendingDown className="w-4 h-4 text-red-500" />;
  if (d === 'volatile') return <BarChart2 className="w-4 h-4 text-amber-500" />;
  return <Minus className="w-4 h-4 text-slate-400" />;
}

function directionBadge(d: string) {
  const base = 'px-2 py-0.5 rounded-full text-xs font-semibold';
  if (d === 'bullish') return <span className={cn(base, 'bg-emerald-100 text-emerald-700')}>Bullish</span>;
  if (d === 'bearish') return <span className={cn(base, 'bg-red-100 text-red-700')}>Bearish</span>;
  if (d === 'volatile') return <span className={cn(base, 'bg-amber-100 text-amber-700')}>Volatile</span>;
  return <span className={cn(base, 'bg-slate-100 text-slate-600')}>Neutral</span>;
}

function importanceDot(imp: string) {
  if (imp === 'high') return <span className="w-2 h-2 rounded-full bg-red-500 shrink-0 mt-1.5" />;
  if (imp === 'medium') return <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0 mt-1.5" />;
  return <span className="w-2 h-2 rounded-full bg-slate-300 shrink-0 mt-1.5" />;
}

function formatDate(d: string) {
  return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}m ago`;
  return `${Math.floor(diff / 60)}h ago`;
}

// ── Section wrapper ───────────────────────────────────────

function Section({ icon, title, children, className }: { icon: React.ReactNode; title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('bg-white rounded-xl border border-slate-200 p-4 shadow-sm', className)}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-slate-400">{icon}</span>
        <h3 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">{title}</h3>
      </div>
      {children}
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────

function EmptyState({ isToday, onGenerate, generating }: { isToday: boolean; onGenerate: () => void; generating: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
        <Newspaper className="w-8 h-8 text-slate-400" />
      </div>
      <h3 className="text-slate-700 font-semibold mb-2">
        {isToday ? "Today's brief hasn't been generated yet" : 'No brief for this date'}
      </h3>
      <p className="text-slate-500 text-sm max-w-sm mb-5">
        {isToday
          ? 'The morning brief runs automatically at 8:00 AM ET on weekdays.'
          : 'No morning brief was generated for this date.'}
      </p>
      {isToday && (
        <button
          onClick={onGenerate}
          disabled={generating}
          className="flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {generating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
          {generating ? 'Generating...' : 'Generate Now'}
        </button>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────

export function MorningBrief() {
  const [brief, setBrief] = useState<MorningBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [availableDates, setAvailableDates] = useState<string[]>([]);

  const todayStr = new Date().toLocaleDateString('en-CA');

  async function fetchBriefs() {
    setLoading(true);
    const { data } = await supabase
      .from('morning_briefs')
      .select('*')
      .order('brief_date', { ascending: false })
      .limit(10);

    if (data && data.length > 0) {
      const dates = data.map((d: MorningBrief) => d.brief_date);
      setAvailableDates(dates);
      const target = selectedDate && dates.includes(selectedDate) ? selectedDate : dates[0];
      setSelectedDate(target);
      setBrief(data.find((d: MorningBrief) => d.brief_date === target) ?? null);
    } else {
      setAvailableDates([]);
      setBrief(null);
    }
    setLoading(false);
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      await supabase.functions.invoke('generate-morning-brief', { body: {} });
      // Brief takes ~10-15s to generate; poll after a short wait
      await new Promise(r => setTimeout(r, 12000));
      await fetchBriefs();
    } catch {
      // silently fall through — fetchBriefs will show empty state if it failed
      await fetchBriefs();
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => { fetchBriefs(); }, []);

  useEffect(() => {
    if (selectedDate && availableDates.length > 0) {
      supabase
        .from('morning_briefs')
        .select('*')
        .eq('brief_date', selectedDate)
        .single()
        .then(({ data }: { data: MorningBrief | null }) => setBrief(data ?? null));
    }
  }, [selectedDate]);

  const isToday = selectedDate === todayStr || availableDates.length === 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="flex items-center gap-3 text-slate-400">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span>Loading morning brief...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Newspaper className="w-6 h-6 text-amber-500" />
            Morning Brief
          </h1>
          {brief && (
            <p className="text-slate-400 text-sm mt-0.5 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              Generated {timeAgo(brief.generated_at)} · {brief.raw_news_count} news items processed
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {availableDates.length > 1 && (
            <select
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="bg-white border border-slate-200 text-slate-700 text-sm rounded-lg px-3 py-1.5"
            >
              {availableDates.map(d => (
                <option key={d} value={d}>
                  {d === todayStr ? `Today — ${d}` : d}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 disabled:bg-amber-300 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {generating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {generating ? 'Generating...' : 'Generate Now'}
          </button>
          <button
            onClick={fetchBriefs}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {!brief ? (
        <EmptyState isToday={isToday} onGenerate={handleGenerate} generating={generating} />
      ) : (
        <>
          {/* Date heading */}
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-700">{formatDate(brief.brief_date)}</h2>
          </div>

          {/* Macro snapshot — hero card */}
          {brief.macro_snapshot && (
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5 mb-4">
              <p className="text-sm font-medium text-blue-600 mb-1 uppercase tracking-wide">Market Snapshot</p>
              <p className="text-slate-800 leading-relaxed">{brief.macro_snapshot}</p>
              {brief.macro_tone && (
                <p className="text-slate-500 text-sm mt-3 leading-relaxed border-t border-blue-200 pt-3">
                  {brief.macro_tone}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* Top Movers */}
            {brief.top_movers?.length > 0 && (
              <Section icon={<Star className="w-4 h-4" />} title="Top Movers" className="lg:col-span-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {brief.top_movers.map((m, i) => (
                    <div key={i} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          {directionIcon(m.direction)}
                          <span className="font-bold text-slate-800">{m.ticker}</span>
                          {directionBadge(m.direction)}
                        </div>
                      </div>
                      <p className="text-xs text-blue-600 font-medium mb-1">{m.catalyst}</p>
                      <p className="text-xs text-slate-500 leading-relaxed">{m.why}</p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Economic Calendar */}
            {brief.economic_events?.length > 0 && (
              <Section icon={<Calendar className="w-4 h-4" />} title="Economic Calendar">
                <div className="space-y-2">
                  {brief.economic_events.map((e, i) => (
                    <div key={i} className="flex items-start gap-2.5">
                      {importanceDot(e.importance)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-mono text-slate-400 shrink-0">{e.time_et}</span>
                          <span className="text-sm text-slate-700 font-medium">{e.event}</span>
                        </div>
                        {(e.estimate || e.prior) && (
                          <p className="text-xs text-slate-400 mt-0.5">
                            {e.estimate && `Est: ${e.estimate}`}
                            {e.estimate && e.prior && ' · '}
                            {e.prior && `Prior: ${e.prior}`}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Earnings */}
            {brief.earnings?.length > 0 && (
              <Section icon={<BarChart2 className="w-4 h-4" />} title="Earnings Today">
                <div className="space-y-2">
                  {brief.earnings.map((e, i) => (
                    <div key={i} className="flex items-start gap-2.5">
                      {directionIcon(e.direction)}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-slate-800 text-sm">{e.ticker}</span>
                          <span className="text-xs text-slate-400">
                            {e.when === 'before_open' ? 'Pre-market' : e.when === 'after_close' ? 'After close' : e.when}
                          </span>
                          {directionBadge(e.direction)}
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{e.note}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            {/* Research Themes */}
            {brief.research_themes?.length > 0 && (
              <Section icon={<ChevronRight className="w-4 h-4" />} title="Research Themes">
                <div className="space-y-3">
                  {brief.research_themes.map((t, i) => (
                    <div key={i}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-semibold text-slate-700">{t.theme}</span>
                        <div className="flex gap-1 flex-wrap">
                          {t.tickers?.map(tk => (
                            <span key={tk} className="px-1.5 py-0.5 bg-slate-100 border border-slate-200 rounded text-xs text-slate-600 font-mono">{tk}</span>
                          ))}
                        </div>
                      </div>
                      <p className="text-xs text-slate-500 leading-relaxed">{t.note}</p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Secondary Names */}
            {brief.secondary_names?.length > 0 && (
              <Section icon={<Newspaper className="w-4 h-4" />} title="Also on Radar">
                <div className="space-y-2">
                  {brief.secondary_names.map((s, i) => (
                    <div key={i} className="flex items-start gap-2">
                      {directionIcon(s.direction)}
                      <div>
                        <span className="font-bold text-slate-800 text-sm mr-2">{s.ticker}</span>
                        <span className="text-xs text-slate-500">{s.note}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>

          {/* Week Ahead */}
          {brief.week_ahead && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle className="w-4 h-4 text-amber-500" />
                <h3 className="text-sm font-semibold text-amber-700 uppercase tracking-wide">Week Ahead</h3>
              </div>
              <p className="text-slate-600 text-sm leading-relaxed">{brief.week_ahead}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
