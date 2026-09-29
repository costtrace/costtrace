/**
 * Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), embedded
 * commas and newlines, CRLF or LF line endings, and a leading BOM.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    // Skip blank lines rather than emitting [''] records.
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
  };

  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n') {
      endRecord();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new Error('Unterminated quoted field in CSV input');
  if (field !== '' || record.length > 0) endRecord();
  return records;
}
