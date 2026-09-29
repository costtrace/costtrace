import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { formatOf, type ExportFile, type FileSource } from '@costtrace/focus';

export interface S3SourceOptions {
  bucket: string;
  /** Key prefix of the export, e.g. `focus/costtrace-export/data/`. */
  prefix?: string;
  /** Client to use; defaults to one with the standard AWS credential chain. */
  client?: Pick<S3Client, 'send'>;
  /** Region to start from; requests follow the bucket's actual region automatically. */
  region?: string;
}

/**
 * FOCUS export files under an S3 prefix, as written by AWS Data Exports. Parquet files are read
 * with byte-range requests, so only the columns CostTrace needs are downloaded.
 *
 * Credentials come from the standard AWS chain: environment variables, shared config and
 * profiles (`AWS_PROFILE`), SSO, or an instance, container or CI role. The identity needs
 * `s3:ListBucket` on the bucket and `s3:GetObject` on the prefix.
 */
export function s3Source(options: S3SourceOptions): FileSource {
  const { bucket, prefix = '' } = options;
  const client =
    options.client ??
    new S3Client({
      region: options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      followRegionRedirects: true,
    });

  return {
    kind: 'files',
    description: `s3://${bucket}/${prefix}`,
    async list() {
      const files: ExportFile[] = [];
      let token: string | undefined;
      do {
        const page = await client
          .send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
          .catch((error: unknown) => {
            throw explain(error, bucket);
          });
        for (const object of page.Contents ?? []) {
          if (!object.Key || formatOf(object.Key) === null) continue;
          files.push(s3File(client, bucket, object.Key, object.Size ?? 0, prefix));
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return files.sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

function s3File(client: Pick<S3Client, 'send'>, bucket: string, key: string, size: number, prefix: string): ExportFile {
  return {
    name: key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length).replace(/^\/+/, '') : key,
    size,
    async stream() {
      const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!Body) throw new Error(`s3://${bucket}/${key} returned no body`);
      return Body as AsyncIterable<Uint8Array>;
    },
    async read(start, end) {
      if (end <= start) return new ArrayBuffer(0);
      const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end - 1}` }));
      if (!Body) throw new Error(`s3://${bucket}/${key} returned no body`);
      const bytes = await Body.transformToByteArray();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}

/** Turn common S3 failures into an actionable message, keeping the original as `cause`. */
export function explain(error: unknown, bucket: string): Error {
  const name = (error as { name?: string }).name ?? '';
  const message = (error as Error).message ?? String(error);
  const hint =
    name === 'CredentialsProviderError' || /Could not load credentials/.test(message)
      ? 'No AWS credentials found. Set AWS_PROFILE (and run `aws sso login` if you use SSO), set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or run where an IAM role is available.'
      : name === 'NoSuchBucket'
        ? `Bucket ${bucket} does not exist.`
        : name === 'AccessDenied' || name === 'Forbidden'
          ? `Access denied to bucket ${bucket}. The identity needs s3:ListBucket on the bucket and s3:GetObject on the export prefix.`
          : null;
  return hint ? new Error(`${hint}\n(${name || 'Error'}: ${message})`, { cause: error }) : (error as Error);
}

/** Parse `s3://bucket/prefix`. */
export function parseS3Uri(uri: string): { bucket: string; prefix: string } {
  const match = /^s3:\/\/([^/]+)\/?(.*)$/.exec(uri.trim());
  if (!match || !match[1]) throw new Error(`Not an S3 URI: ${uri}. Expected s3://bucket/prefix`);
  return { bucket: match[1], prefix: match[2] ?? '' };
}

/** Build a source from `s3://bucket/prefix`. */
export function sourceFromUri(uri: string, options: Omit<S3SourceOptions, 'bucket' | 'prefix'> = {}): FileSource {
  return s3Source({ ...parseS3Uri(uri), ...options });
}
