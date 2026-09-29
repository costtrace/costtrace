/**
 * Incremental RFC 4180 CSV parser: quoted fields, escaped quotes (""), embedded commas and
 * newlines, CRLF or LF line endings, and a leading BOM. Feed it text in chunks of any size, so
 * multi-gigabyte exports never have to fit in memory as one string.
 */
export class CsvParser {
  private record: string[] = [];
  private field = '';
  private inQuotes = false;
  /** A quote at the end of a chunk: can't tell yet whether it's `""` or a closing quote. */
  private pendingQuote = false;
  /** A CR at the end of a chunk: swallow a following LF. */
  private pendingCR = false;
  private started = false;

  constructor(private readonly onRecord: (record: string[]) => void) {}

  push(chunk: string): void {
    let i = 0;
    if (!this.started && chunk.length > 0) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) i = 1;
    }
    for (; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (this.pendingCR) {
        this.pendingCR = false;
        if (ch === '\n') continue;
      }
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }
      if (this.inQuotes) {
        if (ch === '"') {
          if (i + 1 < chunk.length) {
            if (chunk[i + 1] === '"') {
              this.field += '"';
              i++;
            } else {
              this.inQuotes = false;
            }
          } else {
            this.pendingQuote = true;
          }
        } else {
          this.field += ch;
        }
      } else if (ch === '"') {
        this.inQuotes = true;
      } else if (ch === ',') {
        this.endField();
      } else if (ch === '\n') {
        this.endRecord();
      } else if (ch === '\r') {
        this.endRecord();
        this.pendingCR = true;
      } else {
        this.field += ch;
      }
    }
  }

  end(): void {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) throw new Error('Unterminated quoted field in CSV input');
    if (this.field !== '' || this.record.length > 0) this.endRecord();
  }

  private endField(): void {
    this.record.push(this.field);
    this.field = '';
  }

  private endRecord(): void {
    this.endField();
    // Skip blank lines rather than emitting [''] records.
    if (!(this.record.length === 1 && this.record[0] === '')) this.onRecord(this.record);
    this.record = [];
  }
}

/** Parse a complete CSV string into records. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  const parser = new CsvParser((record) => records.push(record));
  parser.push(text);
  parser.end();
  return records;
}
