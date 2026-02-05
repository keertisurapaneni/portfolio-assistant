import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import type { ColumnMapping, ParsedRow } from '../types';

/**
 * Parse a file (CSV or Excel) and return rows with headers.
 */
export async function parseFile(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  
  if (extension === 'csv') {
    return parseCSV(file);
  } else if (extension === 'xlsx' || extension === 'xls') {
    return parseExcel(file);
  } else {
    throw new Error(`Unsupported file type: ${extension}`);
  }
}

/**
 * Parse CSV file using PapaParse.
 */
function parseCSV(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const headers = results.meta.fields || [];
        const rows = results.data as Record<string, string>[];
        resolve({ headers, rows });
      },
      error: (error) => {
        reject(new Error(`CSV parsing failed: ${error.message}`));
      },
    });
  });
}

/**
 * Parse Excel file using SheetJS.
 */
function parseExcel(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        
        // Use first sheet
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        // Convert to JSON with headers
        const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { 
          raw: false,
          defval: '' 
        });
        
        // Extract headers from first row keys
        const headers = jsonData.length > 0 ? Object.keys(jsonData[0]) : [];
        
        resolve({ headers, rows: jsonData });
      } catch (error) {
        reject(new Error(`Excel parsing failed: ${error}`));
      }
    };
    
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Auto-detect column mappings based on header keywords.
 */
export function detectColumns(headers: string[]): ColumnMapping {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  
  const tickerKeywords = ['ticker', 'symbol', 'stock', 'code'];
  const sharesKeywords = ['shares', 'quantity', 'qty', 'units', 'position', 'amount'];
  const costKeywords = ['avg', 'cost', 'price', 'basis', 'average', 'paid'];
  const nameKeywords = ['name', 'company', 'description', 'security'];
  
  const findColumn = (keywords: string[]): string | null => {
    const found = headers.find(h => keywords.some(k => normalize(h).includes(k)));
    return found || null;
  };
  
  return {
    ticker: findColumn(tickerKeywords),
    shares: findColumn(sharesKeywords),
    avgCost: findColumn(costKeywords),
    name: findColumn(nameKeywords),
  };
}

/**
 * Check if column mapping is valid (ticker is required).
 */
export function isValidMapping(mapping: ColumnMapping): boolean {
  return mapping.ticker !== null;
}

/**
 * Apply column mapping to rows and return parsed stocks.
 */
export function applyMapping(
  rows: Record<string, string>[],
  mapping: ColumnMapping
): ParsedRow[] {
  if (!mapping.ticker) {
    throw new Error('Ticker column is required');
  }
  
  return rows
    .map(row => {
      const ticker = row[mapping.ticker!]?.trim();
      if (!ticker) return null;
      
      const parsed: ParsedRow = {
        ticker,
        name: mapping.name ? row[mapping.name]?.trim() : undefined,
        shares: mapping.shares ? parseNumber(row[mapping.shares]) : undefined,
        avgCost: mapping.avgCost ? parseNumber(row[mapping.avgCost]) : undefined,
      };
      
      return parsed;
    })
    .filter((row): row is ParsedRow => row !== null && !!row.ticker);
}

/**
 * Parse a number from a string, handling currency symbols and commas.
 */
function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  
  // Remove currency symbols, commas, and whitespace
  const cleaned = value.replace(/[$€£,\s]/g, '');
  const num = parseFloat(cleaned);
  
  return isNaN(num) ? undefined : num;
}

/**
 * Get a preview of parsed data for user confirmation.
 */
export function getPreview(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
  limit = 5
): ParsedRow[] {
  const parsed = applyMapping(rows, mapping);
  return parsed.slice(0, limit);
}
