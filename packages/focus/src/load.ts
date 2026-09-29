import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseFocusCsv } from './parse.js';
import type { ParseResult } from './types.js';

/** Load a FOCUS export from disk. CSV is supported today; Parquet is planned. */
export async function loadFocusFile(path: string): Promise<ParseResult> {
  const ext = extname(path).toLowerCase();
  if (ext === '.parquet') {
    throw new Error('Parquet FOCUS exports are not supported yet; export as CSV for now.');
  }
  return parseFocusCsv(await readFile(path, 'utf8'));
}
