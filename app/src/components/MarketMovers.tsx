import { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

interface MarketMover {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
}

interface MarketMoversData {
  gainers: MarketMover[];
  losers: MarketMover[];
  isLoading: boolean;
  error: string | null;
  lastUpdated: string | null;
}

type SortField = 'price' | 'change' | 'changePercent';
type SortDir = 'asc' | 'desc';
interface TableSort {
  field: SortField | null;
  dir: SortDir;
}

export function MarketMovers() {
  const [data, setData] = useState<MarketMoversData>({
    gainers: [],
    losers: [],
    isLoading: true,
    error: null,
    lastUpdated: null,
  });
  const [gainerSort, setGainerSort] = useState<TableSort>({ field: null, dir: 'desc' });
  const [loserSort, setLoserSort] = useState<TableSort>({ field: null, dir: 'desc' });

  const fetchMovers = async () => {
    setData(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

      // Fetch gainers and losers in parallel
      const [gainersRes, losersRes] = await Promise.all([
        fetch(`${supabaseUrl}/functions/v1/scrape-market-movers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ type: 'gainers' }),
        }),
        fetch(`${supabaseUrl}/functions/v1/scrape-market-movers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${supabaseKey}`,
          },
          body: JSON.stringify({ type: 'losers' }),
        }),
      ]);

      if (!gainersRes.ok || !losersRes.ok) {
        throw new Error('Failed to fetch market movers');
      }

      const gainersData = await gainersRes.json();
      const losersData = await losersRes.json();

      setData({
        gainers: gainersData.movers || [],
        losers: losersData.movers || [],
        isLoading: false,
        error: null,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[Market Movers] Error:', error);
      setData(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  };

  useEffect(() => {
    fetchMovers();
  }, []);

  const renderTable = (movers: MarketMover[], title: string, isGainers: boolean) => {
    const sort = isGainers ? gainerSort : loserSort;
    const setSort = isGainers ? setGainerSort : setLoserSort;

    const toggleSort = (field: SortField) => {
      setSort(prev =>
        prev.field === field
          ? { field, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
          : { field, dir: 'desc' }
      );
    };

    const SortIcon = ({ field }: { field: SortField }) => {
      if (sort.field !== field) return null;
      return sort.dir === 'desc' ? (
        <ChevronDown className="w-3 h-3 inline ml-0.5" />
      ) : (
        <ChevronUp className="w-3 h-3 inline ml-0.5" />
      );
    };

    const sorted = sort.field
      ? [...movers].sort((a, b) => {
          const val = a[sort.field!] - b[sort.field!];
          return sort.dir === 'desc' ? -val : val;
        })
      : movers;

    return (
      <div className="bg-white rounded-xl border border-[hsl(var(--border))] overflow-hidden">
        {/* Header */}
        <div
          className={cn(
            'px-6 py-4 border-b border-[hsl(var(--border))]',
            isGainers ? 'bg-green-50' : 'bg-red-50'
          )}
        >
          <div className="flex items-center gap-2">
            {isGainers ? (
              <TrendingUp className="w-5 h-5 text-green-600" />
            ) : (
              <TrendingDown className="w-5 h-5 text-red-600" />
            )}
            <h2
              className={cn('text-lg font-semibold', isGainers ? 'text-green-900' : 'text-red-900')}
            >
              {title}
            </h2>
            <span className="text-sm text-[hsl(var(--muted-foreground))] ml-auto">Top 25</span>
          </div>
        </div>

        {/* Table with Scrollbar */}
        <div className="overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full">
            <thead className="bg-[hsl(var(--secondary))] text-xs text-[hsl(var(--muted-foreground))] uppercase sticky top-0 z-10">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Symbol</th>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th
                  className="px-4 py-3 text-right font-medium cursor-pointer hover:text-[hsl(var(--foreground))] select-none"
                  onClick={() => toggleSort('price')}
                >
                  Price
                  <SortIcon field="price" />
                </th>
                <th
                  className="px-4 py-3 text-right font-medium cursor-pointer hover:text-[hsl(var(--foreground))] select-none"
                  onClick={() => toggleSort('change')}
                >
                  Change
                  <SortIcon field="change" />
                </th>
                <th
                  className="px-4 py-3 text-right font-medium cursor-pointer hover:text-[hsl(var(--foreground))] select-none"
                  onClick={() => toggleSort('changePercent')}
                >
                  Change %<SortIcon field="changePercent" />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[hsl(var(--border))]">
              {sorted.map(mover => (
                <tr
                  key={mover.symbol}
                  className="hover:bg-[hsl(var(--secondary))] transition-colors"
                >
                  <td className="px-4 py-3">
                    <a
                      href={`https://finance.yahoo.com/quote/${mover.symbol}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-blue-600 hover:text-blue-700 hover:underline"
                    >
                      {mover.symbol}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-sm text-[hsl(var(--muted-foreground))] max-w-xs truncate">
                    {mover.name}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">${mover.price.toFixed(2)}</td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-medium',
                      isGainers ? 'text-green-600' : 'text-red-600'
                    )}
                  >
                    {isGainers ? '+' : '-'}${Math.abs(mover.change).toFixed(2)}
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-semibold',
                      isGainers ? 'text-green-600' : 'text-red-600'
                    )}
                  >
                    {isGainers ? '+' : ''}
                    {mover.changePercent.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[hsl(var(--foreground))] mb-1">Market Movers</h1>
          <p className="text-sm text-[hsl(var(--muted-foreground))]">
            Top gainers and losers in today's market
          </p>
        </div>

        <button
          onClick={fetchMovers}
          disabled={data.isLoading}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg',
            'bg-[hsl(var(--primary))] text-white font-medium',
            'hover:bg-[hsl(var(--primary))]/90 transition-colors',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <RefreshCw className={cn('w-4 h-4', data.isLoading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Last Updated */}
      {data.lastUpdated && !data.isLoading && (
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          Last updated: {new Date(data.lastUpdated).toLocaleTimeString()}
        </p>
      )}

      {/* Error State */}
      {data.error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm text-red-700">⚠️ {data.error}</p>
        </div>
      )}

      {/* Loading State */}
      {data.isLoading && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-[hsl(var(--border))] p-8">
            <div className="flex items-center justify-center">
              <RefreshCw className="w-6 h-6 animate-spin text-[hsl(var(--primary))]" />
              <span className="ml-3 text-[hsl(var(--muted-foreground))]">
                Loading market movers...
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Tables */}
      {!data.isLoading && !data.error && (
        <div className="space-y-6">
          {renderTable(data.gainers, 'Top Gainers', true)}
          {renderTable(data.losers, 'Top Losers', false)}
        </div>
      )}
    </div>
  );
}
