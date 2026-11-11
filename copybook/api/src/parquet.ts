/**
 * Parquet bulk exports (the lead, Nov 11): bulk/{quarter}.parquet next to the data run's bulk/{quarter}.csv.gz, with the
 * same columns and rows, built here with a pure-JS writer (hyparquet-writer, snappy), no new spend. Gene converts; a
 * Cloudflare isolate hasn't the memory for a 1.6M-row quarter.
 */
import { ByteWriter, ParquetWriter } from 'hyparquet-writer';
import type { Env } from './env';

/** Whole-number columns (shares and dollars) are INT64, empty as null; every other column is a string as in the CSV. */
const INT_COLS = new Set(['shares', 'value', 'prev_shares', 'prev_value']);
const ROW_GROUP = 100_000;

/** RFC 4180 rows from a text stream: quoted fields may hold commas, doubled quotes and newlines. Fields are sliced
 * from each chunk, never built a character at a time (1.2 GB for a 1.6M-row quarter that way). */
async function* csvRows(text: ReadableStream<string>): AsyncGenerator<string[]> {
  let row: string[] = [];
  let field = ''; // the field's text from earlier chunks or before an escaped quote
  let quoted = false;
  let quote = false; // the last char was a quote inside a quoted field: an escape or the field's end
  for await (const chunk of text as unknown as AsyncIterable<string>) {
    let s = 0; // where the field's pending run starts in this chunk
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (quoted) {
        if (quote) {
          quote = false;
          s = i;
          if (c === 34) continue; // "" is one quote: the run restarts at the second
          quoted = false; // the closing quote; c is handled below as unquoted
        } else {
          if (c === 34) {
            field += chunk.slice(s, i);
            quote = true;
            s = i + 1;
          }
          continue;
        }
      }
      if (c === 34 && field === '' && i === s) {
        quoted = true;
        s = i + 1;
      } else if (c === 44) {
        row.push(field + chunk.slice(s, i));
        field = '';
        s = i + 1;
      } else if (c === 10) {
        const f = field + chunk.slice(s, i);
        row.push(f.endsWith('\r') ? f.slice(0, -1) : f);
        yield row;
        row = [];
        field = '';
        s = i + 1;
      }
    }
    field += chunk.slice(s);
  }
  if (field !== '' || row.length) {
    row.push(field);
    yield row;
  }
}

/** The data run's bulk CSV (gzip) as one Parquet file: same header, same rows, in the same order. */
export async function csvGzToParquet(gz: ReadableStream<Uint8Array>, rowGroup = ROW_GROUP): Promise<{ bytes: Uint8Array; rows: number; columns: string[] }> {
  const text = (gz as ReadableStream<Uint8Array<ArrayBuffer>>).pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream());
  const writer = new ByteWriter();
  let pw: ParquetWriter | null = null;
  let columns: string[] = [];
  let cols: (string | bigint | null)[][] = [];
  let rows = 0;
  const flush = () => {
    if (!cols[0]?.length) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pw!.write({ columnData: columns.map((name, i) => ({ name, data: cols[i] as any, type: INT_COLS.has(name) ? 'INT64' : 'STRING', nullable: true })), rowGroupSize: rowGroup });
    cols = columns.map(() => []);
  };
  for await (const r of csvRows(text)) {
    if (!pw) {
      columns = r;
      cols = columns.map(() => []);
      pw = new ParquetWriter({
        writer,
        schema: [
          { name: 'root', num_children: columns.length },
          ...columns.map((name) => (INT_COLS.has(name) ? { name, type: 'INT64' as const, repetition_type: 'OPTIONAL' as const } : { name, type: 'BYTE_ARRAY' as const, converted_type: 'UTF8' as const, repetition_type: 'OPTIONAL' as const })),
        ],
        createdBy: 'copybook-api',
      });
      continue;
    }
    if (r.length === 1 && r[0] === '') continue;
    if (r.length !== columns.length) throw new Error(`row ${rows + 1}: ${r.length} fields, header has ${columns.length}`);
    for (let i = 0; i < r.length; i++) cols[i].push(r[i] === '' ? null : INT_COLS.has(columns[i]) ? BigInt(r[i]) : r[i]);
    if (++rows % rowGroup === 0) flush();
  }
  if (!pw) throw new Error('empty CSV');
  flush();
  pw.finish();
  return { bytes: new Uint8Array(writer.getBuffer()), rows, columns };
}

/**
 * Converts the newest bulk CSV whose Parquet is missing or was built from another CSV (one per call), or `quarter`'s.
 * The Parquet carries its own sha256 (so /v1/bulk lists it like the CSV) and the CSV's (source_sha256) it was built from.
 */
export async function buildParquet(env: Env, quarter?: string): Promise<{ file: string; rows: number; bytes: number; sha256: string; ms: number } | { file: null; reason: string }> {
  const { bulkFiles, sha256Hex } = await import('./download');
  const files = await bulkFiles(env, 0);
  const csvs = files.filter((f) => f.key.endsWith('.csv.gz') && f.bytes >= 1_000_000 && (!quarter || f.key === `bulk/${quarter}.csv.gz`)).sort((a, b) => b.key.localeCompare(a.key));
  for (const f of csvs) {
    const key = f.key.replace(/\.csv\.gz$/, '.parquet');
    const source = f.sha256 ?? f.etag ?? '';
    if (!quarter && files.find((x) => x.key === key)?.source === source) continue;
    const obj = await env.HIST.get(f.key);
    if (!obj) continue;
    const t0 = Date.now();
    const { bytes, rows } = await csvGzToParquet(obj.body);
    const sha256 = await sha256Hex(bytes);
    await env.HIST.put(key, bytes, { httpMetadata: { contentType: 'application/vnd.apache.parquet' }, customMetadata: { sha256, source_sha256: source, rows: String(rows) } });
    return { file: key.slice(5), rows, bytes: bytes.length, sha256, ms: Date.now() - t0 };
  }
  return { file: null, reason: quarter ? `no bulk/${quarter}.csv.gz` : 'every CSV has its Parquet' };
}
