'use client';
import type { Aoa } from '@/lib/logic';

// SheetJS 0.20.3 from SheetJS's own CDN (the npm registry copy is an older, unpatched version).
const SRC = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';

interface SheetJS {
  read: (data: ArrayBuffer, opts: { type: 'array' }) => { SheetNames: string[]; Sheets: Record<string, unknown> };
  utils: { sheet_to_json: (ws: unknown, opts: { header: 1; raw: true; defval: string }) => Aoa };
}
declare global { interface Window { XLSX?: SheetJS } }

let loading: Promise<SheetJS> | null = null;
function load(): Promise<SheetJS> {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('Spreadsheet reader failed to load.')));
      s.onerror = () => { loading = null; reject(new Error('Could not load the spreadsheet reader. Check your connection.')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

// Reads the sheet with the most rows in an .xlsx/.xls/.csv file.
export async function readSpreadsheet(file: File): Promise<Aoa> {
  const X = await load();
  const wb = X.read(await file.arrayBuffer(), { type: 'array' });
  let best: Aoa = [];
  for (const name of wb.SheetNames) {
    const aoa = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    if (aoa.length > best.length) best = aoa;
  }
  // Store only plain values: trim trailing empty cells and empty rows.
  return best
    .map(r => { const row = [...r]; while (row.length && (row[row.length - 1] === '' || row[row.length - 1] == null)) row.pop(); return row; })
    .filter(r => r.length);
}
