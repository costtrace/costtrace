import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { formatOf, type ExportFile, type FileSource } from '@costtrace/focus';

/** The part of ContainerClient this connector uses (lets tests supply a fake). */
export interface ContainerLike {
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string; properties: { contentLength?: number } }>;
  getBlobClient(name: string): {
    download(offset?: number, count?: number): Promise<{ readableStreamBody?: NodeJS.ReadableStream }>;
    downloadToBuffer(offset?: number, count?: number): Promise<Buffer>;
  };
}

export interface BlobSourceOptions {
  /** Storage account name, e.g. `acmebilling`. Not needed when `containerUrl` or `container` client is given. */
  account?: string;
  /** Container name, e.g. `cost-exports`. */
  containerName?: string;
  /** Full container URL, optionally with a SAS token: `https://acct.blob.core.windows.net/exports?sv=…`. */
  containerUrl?: string;
  /** Blob name prefix of the export, e.g. `focus/costtrace/`. */
  prefix?: string;
  /** Container client to use instead of resolving credentials. */
  container?: ContainerLike;
}

/**
 * FOCUS export files under a prefix in Azure Blob Storage, as written by Cost Management exports.
 * Parquet files are read with ranged downloads, so only the columns CostTrace needs are fetched.
 *
 * Credentials, in order: a SAS token in `containerUrl`; the `AZURE_STORAGE_CONNECTION_STRING`
 * environment variable; otherwise Microsoft Entra ID via DefaultAzureCredential (`az login`,
 * managed identity, workload identity in CI…), which needs the Storage Blob Data Reader role.
 */
export function blobSource(options: BlobSourceOptions): FileSource {
  const container = options.container ?? containerFor(options);
  const prefix = options.prefix ?? '';
  const where = options.containerUrl?.split('?')[0] ?? `https://${options.account}.blob.core.windows.net/${options.containerName}`;

  return {
    kind: 'files',
    description: `${where}/${prefix}`,
    async list() {
      const files: ExportFile[] = [];
      try {
        for await (const blob of container.listBlobsFlat({ prefix })) {
          if (formatOf(blob.name) === null) continue;
          files.push(blobFile(container, blob.name, blob.properties.contentLength ?? 0, prefix));
        }
      } catch (error) {
        throw explain(error, where);
      }
      return files.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

function containerFor(options: BlobSourceOptions): ContainerLike {
  if (options.containerUrl) {
    // A SAS URL carries its own credentials; a plain URL uses Entra ID.
    return options.containerUrl.includes('?')
      ? new ContainerClient(options.containerUrl)
      : new ContainerClient(options.containerUrl, new DefaultAzureCredential());
  }
  if (!options.containerName) throw new Error('Azure blob source needs containerName or containerUrl');
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connectionString) return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(options.containerName);
  if (!options.account) throw new Error('Azure blob source needs the storage account name');
  return new ContainerClient(`https://${options.account}.blob.core.windows.net/${options.containerName}`, new DefaultAzureCredential());
}

function blobFile(container: ContainerLike, name: string, size: number, prefix: string): ExportFile {
  const blob = container.getBlobClient(name);
  return {
    name: name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length).replace(/^\/+/, '') : name,
    size,
    async stream() {
      const { readableStreamBody } = await blob.download();
      if (!readableStreamBody) throw new Error(`Blob ${name} returned no body`);
      return readableStreamBody as unknown as AsyncIterable<Uint8Array>;
    },
    async read(start, end) {
      if (end <= start) return new ArrayBuffer(0);
      const bytes = await blob.downloadToBuffer(start, end - start);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

/** Turn common Azure failures into an actionable message, keeping the original as `cause`. */
export function explain(error: unknown, where: string): Error {
  const e = error as { name?: string; message?: string; statusCode?: number; code?: string };
  const message = e.message ?? String(error);
  const hint =
    e.name === 'AggregateAuthenticationError' || e.name === 'CredentialUnavailableError' || /authentication failed/i.test(message)
      ? 'No Azure credentials found. Run `az login`, set AZURE_STORAGE_CONNECTION_STRING, or pass a container SAS URL (https://<account>.blob.core.windows.net/<container>?<sas>).'
      : e.statusCode === 403 || e.code === 'AuthorizationPermissionMismatch' || e.code === 'AuthorizationFailure'
        ? `Access denied to ${where}. With Microsoft Entra ID, the identity needs the Storage Blob Data Reader role; a SAS token needs read and list permissions.`
        : e.code === 'ContainerNotFound' || e.statusCode === 404
          ? `Container not found: ${where}.`
          : e.code === 'ENOTFOUND' || e.code === 'REQUEST_SEND_ERROR'
            ? `Could not reach ${where}. Check the storage account name.`
            : null;
  // Credential chains report every attempt; keep only the first line of the original.
  return hint ? new Error(`${hint}\n(${e.name ?? 'Error'}: ${message.split('\n')[0]})`, { cause: error }) : (error as Error);
}

/**
 * Parse `azure://account/container/prefix` or
 * `https://account.blob.core.windows.net/container/prefix[?sas]`.
 */
export function parseBlobUri(uri: string): BlobSourceOptions {
  const trimmed = uri.trim();
  const short = /^azure:\/\/([^/]+)\/([^/?]+)\/?([^?]*)$/.exec(trimmed);
  if (short) return { account: short[1], containerName: short[2], prefix: short[3] ?? '' };

  const https = /^https:\/\/([^.]+)\.blob\.core\.windows\.net\/([^/?]+)\/?([^?]*)(\?.*)?$/.exec(trimmed);
  if (https) {
    const [, account, containerName, prefix = '', sas = ''] = https;
    return {
      account,
      containerName,
      prefix: decodeURIComponent(prefix),
      containerUrl: `https://${account}.blob.core.windows.net/${containerName}${sas}`,
    };
  }
  throw new Error(
    `Not an Azure Blob URI: ${uri}. Expected azure://account/container/prefix or https://account.blob.core.windows.net/container/prefix`,
  );
}

/** Build a source from an `azure://` or `https://….blob.core.windows.net/…` URI. */
export function sourceFromUri(uri: string, options: Pick<BlobSourceOptions, 'container'> = {}): FileSource {
  return blobSource({ ...parseBlobUri(uri), ...options });
}
