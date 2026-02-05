import { useState, useRef } from 'react';
import { X, Upload, AlertCircle, Check } from 'lucide-react';
import {
  parseFile,
  detectColumns,
  applyMapping,
  isValidMapping,
  getPreview,
} from '../lib/importParser';
import { importStocksWithPositions } from '../lib/storage';
import type { ColumnMapping, ParsedRow } from '../types';
import { cn } from '../lib/utils';

interface ImportPortfolioModalProps {
  onClose: () => void;
  onComplete: (addedTickers: string[]) => void;
}

type Step = 'upload' | 'mapping' | 'preview' | 'done';

export function ImportPortfolioModal({ onClose, onComplete }: ImportPortfolioModalProps) {
  const [step, setStep] = useState<Step>('upload');
  const [error, setError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({
    ticker: null,
    name: null,
    shares: null,
    avgCost: null,
  });
  const [preview, setPreview] = useState<ParsedRow[]>([]);
  const [result, setResult] = useState<{
    added: string[];
    updated: string[];
    skipped: string[];
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle file selection
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);

    try {
      const { headers: h, rows: r } = await parseFile(file);
      setHeaders(h);
      setRows(r);

      // Auto-detect columns
      const detected = detectColumns(h);
      setMapping(detected);

      // Move to mapping step
      setStep('mapping');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse file');
    }
  };

  // Handle mapping confirmation
  const handleConfirmMapping = () => {
    if (!isValidMapping(mapping)) {
      setError('Please select a ticker column');
      return;
    }

    try {
      const previewData = getPreview(rows, mapping, 5);
      setPreview(previewData);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to map columns');
    }
  };

  // Handle import
  const handleImport = () => {
    try {
      const parsed = applyMapping(rows, mapping);
      // Filter out any rows without a ticker
      const validRows = parsed.filter(
        (row): row is typeof row & { ticker: string } =>
          typeof row.ticker === 'string' && row.ticker.length > 0
      );
      const importResult = importStocksWithPositions(validRows);
      setResult(importResult);
      setStep('done');

      // Automatically trigger data fetch for newly added stocks
      if (importResult.added.length > 0) {
        // Close modal and trigger refresh with added tickers
        setTimeout(() => {
          onComplete(importResult.added);
        }, 1500); // Give user 1.5s to see success message
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-50" onClick={onClose} />

      {/* Modal */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-white rounded-xl shadow-xl z-50 max-h-[80vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white flex items-center justify-between px-6 py-4 border-b border-[hsl(var(--border))]">
          <h2 className="text-lg font-semibold">Import Portfolio</h2>
          <button onClick={onClose} className="p-2 hover:bg-[hsl(var(--secondary))] rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {/* Error display */}
          {error && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 text-red-700 rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          {/* Step: Upload */}
          {step === 'upload' && (
            <div className="text-center py-8">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={handleFileSelect}
                className="hidden"
              />
              <Upload className="w-12 h-12 mx-auto text-[hsl(var(--muted-foreground))] mb-4" />
              <h3 className="font-medium mb-2">Upload Brokerage Export</h3>
              <p className="text-sm text-[hsl(var(--muted-foreground))] mb-4">
                CSV or Excel file with your holdings
              </p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-6 py-3 bg-[hsl(var(--primary))] text-white rounded-lg font-medium hover:opacity-90"
              >
                Choose File
              </button>
            </div>
          )}

          {/* Step: Column Mapping */}
          {step === 'mapping' && (
            <div className="space-y-4">
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                Map your file columns to the required fields. Ticker is required.
              </p>

              {/* Mapping dropdowns */}
              {(['ticker', 'name', 'shares', 'avgCost'] as const).map(field => (
                <div key={field} className="flex items-center gap-4">
                  <span className="w-24 text-sm font-medium capitalize">
                    {field === 'avgCost' ? 'Avg Cost' : field}
                    {field === 'ticker' && <span className="text-red-500">*</span>}
                  </span>
                  <select
                    value={mapping[field] || ''}
                    onChange={e => setMapping({ ...mapping, [field]: e.target.value || null })}
                    className={cn(
                      'flex-1 px-3 py-2 border rounded-lg text-sm',
                      field === 'ticker' && !mapping.ticker
                        ? 'border-red-300'
                        : 'border-[hsl(var(--border))]'
                    )}
                  >
                    <option value="">-- Select column --</option>
                    {headers.map(h => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}

              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setStep('upload')}
                  className="flex-1 py-2 border border-[hsl(var(--border))] rounded-lg hover:bg-[hsl(var(--secondary))]"
                >
                  Back
                </button>
                <button
                  onClick={handleConfirmMapping}
                  className="flex-1 py-2 bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90"
                >
                  Preview
                </button>
              </div>
            </div>
          )}

          {/* Step: Preview */}
          {step === 'preview' && (
            <div className="space-y-4">
              <p className="text-sm text-[hsl(var(--muted-foreground))]">
                Preview of {rows.length} rows to import:
              </p>

              {/* Warning if no position data */}
              {preview.every(row => !row.shares && !row.avgCost) && (
                <div className="flex items-start gap-2 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">No position data found</p>
                    <p className="text-xs mt-1">
                      Portfolio weight and risk warnings won't be available without shares and avg
                      cost data.
                    </p>
                  </div>
                </div>
              )}

              <div className="border border-[hsl(var(--border))] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[hsl(var(--secondary))]">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Ticker</th>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-right font-medium">Shares</th>
                      <th className="px-3 py-2 text-right font-medium">Avg Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, i) => (
                      <tr key={i} className="border-t border-[hsl(var(--border))]">
                        <td className="px-3 py-2 font-medium">{row.ticker}</td>
                        <td className="px-3 py-2 text-[hsl(var(--muted-foreground))]">
                          {row.name || '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {row.shares?.toLocaleString() || '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {row.avgCost ? `$${row.avgCost.toFixed(2)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {rows.length > 5 && (
                <p className="text-xs text-[hsl(var(--muted-foreground))] text-center">
                  ...and {rows.length - 5} more
                </p>
              )}

              <div className="flex gap-3 pt-4">
                <button
                  onClick={() => setStep('mapping')}
                  className="flex-1 py-2 border border-[hsl(var(--border))] rounded-lg hover:bg-[hsl(var(--secondary))]"
                >
                  Back
                </button>
                <button
                  onClick={handleImport}
                  className="flex-1 py-2 bg-[hsl(var(--primary))] text-white rounded-lg hover:opacity-90"
                >
                  Import {rows.length} Stocks
                </button>
              </div>
            </div>
          )}

          {/* Step: Done */}
          {step === 'done' && result && (
            <div className="text-center py-4">
              <div className="w-12 h-12 mx-auto mb-4 bg-green-100 rounded-full flex items-center justify-center">
                <Check className="w-6 h-6 text-green-600" />
              </div>
              <h3 className="font-medium mb-4">Import Complete!</h3>

              <div className="space-y-2 text-sm mb-6">
                {result.added.length > 0 && (
                  <p className="text-green-600">✓ {result.added.length} stocks added</p>
                )}
                {result.updated.length > 0 && (
                  <p className="text-blue-600">↻ {result.updated.length} stocks updated</p>
                )}
                {result.skipped.length > 0 && (
                  <p className="text-[hsl(var(--muted-foreground))]">
                    — {result.skipped.length} skipped
                  </p>
                )}
              </div>

              <button
                onClick={() => onComplete(result?.added || [])}
                className="px-6 py-3 bg-[hsl(var(--primary))] text-white rounded-lg font-medium hover:opacity-90"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
