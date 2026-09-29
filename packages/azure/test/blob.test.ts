import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadFocus, parseFocusCsv, type FocusRow } from '@costtrace/focus';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeExportFolder } from '../../focus/test/fixtures.js';
import { blobSource, explain, parseBlobUri, type ContainerLike } from '../src/index.js';

const SAMPLE = fileURLToPath(new URL('../../../examples/sample/focus-sample.csv', import.meta.url));
const PREFIX = 'exports/focus-costtrace/';

/** An in-memory container that records downloads. */
function fakeContainer(blobs: Map<string, Buffer>) {
  const downloads: { name: string; offset?: number; count?: number }[] = [];
  const container: ContainerLike = {
    async *listBlobsFlat(options) {
      for (const name of [...blobs.keys()].sort()) {
        if (name.startsWith(options?.prefix ?? '')) yield { name, properties: { contentLength: blobs.get(name)!.length } };
      }
    },
    getBlobClient(name) {
      const data = blobs.get(name)!;
      return {
        async download() {
          downloads.push({ name });
          return { readableStreamBody: Readable.from([data]) };
        },
        async downloadToBuffer(offset = 0, count = data.length - offset) {
          downloads.push({ name, offset, count });
          return data.subarray(offset, offset + count);
        },
      };
    },
  };
  return { container, downloads };
}

let dir: string;
let expected: FocusRow[];
let blobs: Map<string, Buffer>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'costtrace-blob-'));
  expected = parseFocusCsv(await readFile(SAMPLE, 'utf8')).rows;
  await writeExportFolder(join(dir, 'export'), expected);
  blobs = new Map();
  for (const entry of await readdir(join(dir, 'export'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    // Azure exports partition by date-range folders.
    blobs.set(`${PREFIX}20260901-20260930/${relative(join(dir, 'export'), full)}`, await readFile(full));
  }
  blobs.set(`${PREFIX}20260601-20260630/old.csv.gz`, blobs.get(`${PREFIX}20260901-20260930/nested/part-00003.csv.gz`)!);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('blobSource', () => {
  it('reads exports from a container prefix, skipping periods outside the range', async () => {
    const { container, downloads } = fakeContainer(blobs);
    const range = { start: new Date('2026-08-25T00:00:00Z'), end: new Date('2026-10-05T00:00:00Z') };
    const result = await loadFocus(blobSource({ account: 'acme', containerName: 'billing', prefix: PREFIX, container }), { range });

    expect(result.issues).toEqual([]);
    expect(result.rows).toHaveLength(expected.length);
    expect(result.files.every((f) => f.startsWith('20260901-20260930/'))).toBe(true);
    expect(downloads.some((d) => d.name.includes('20260601'))).toBe(false);
    expect(downloads.some((d) => d.name.endsWith('.parquet') && d.count !== undefined)).toBe(true);
  });
});

describe('explain', () => {
  it('keeps just the first line of a credential chain failure', () => {
    const chain = Object.assign(new Error('ChainedTokenCredential authentication failed.\nCredentialUnavailableError: …\nCredentialUnavailableError: …'), {
      name: 'AggregateAuthenticationError',
    });
    const message = explain(chain, 'https://acme.blob.core.windows.net/billing/').message;
    expect(message).toMatch(/^No Azure credentials found\. Run `az login`/);
    expect(message.split('\n')).toHaveLength(2);
  });

  it('explains missing permissions', () => {
    const denied = Object.assign(new Error('This request is not authorized'), { statusCode: 403, code: 'AuthorizationPermissionMismatch' });
    expect(explain(denied, 'x').message).toMatch(/Storage Blob Data Reader/);
  });

  it('is applied when listing fails', async () => {
    const container: ContainerLike = {
      async *listBlobsFlat() {
        throw Object.assign(new Error('denied'), { statusCode: 403 });
      },
      getBlobClient: () => {
        throw new Error('unused');
      },
    };
    await expect(loadFocus(blobSource({ account: 'acme', containerName: 'billing', container }))).rejects.toThrow(/Access denied/);
  });
});

describe('parseBlobUri', () => {
  it('parses azure:// URIs', () => {
    expect(parseBlobUri('azure://acme/billing/exports/focus/')).toEqual({
      account: 'acme',
      containerName: 'billing',
      prefix: 'exports/focus/',
    });
  });

  it('parses https URIs and keeps a SAS token on the container URL', () => {
    expect(parseBlobUri('https://acme.blob.core.windows.net/billing/exports/my%20focus/?sv=2024&sig=abc')).toEqual({
      account: 'acme',
      containerName: 'billing',
      prefix: 'exports/my focus/',
      containerUrl: 'https://acme.blob.core.windows.net/billing?sv=2024&sig=abc',
    });
  });

  it('rejects other URLs', () => {
    expect(() => parseBlobUri('https://example.com/billing')).toThrow(/Not an Azure Blob URI/);
  });
});
