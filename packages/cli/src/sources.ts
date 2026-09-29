import type { FocusSource } from '@costtrace/focus';
import { UsageError } from './errors.js';

interface Connector {
  pkg: string;
  label: string;
  matches: (spec: string) => boolean;
}

const CONNECTORS: Connector[] = [
  { pkg: '@costtrace/aws', label: 'Amazon S3', matches: (s) => s.startsWith('s3://') },
  {
    pkg: '@costtrace/azure',
    label: 'Azure Blob Storage',
    matches: (s) => s.startsWith('azure://') || /^https:\/\/[^.]+\.blob\.core\.windows\.net\//.test(s),
  },
  { pkg: '@costtrace/gcp', label: 'BigQuery', matches: (s) => s.startsWith('bq://') },
];

type Import = (pkg: string) => Promise<{ sourceFromUri(uri: string): FocusSource }>;

/**
 * Turn `--focus` into a source: cloud URIs load their connector package on demand, so users only
 * install the SDKs for the clouds they use. Anything else is a local file or folder.
 */
export async function resolveSource(spec: string, load: Import = (pkg) => import(pkg)): Promise<string | FocusSource> {
  const connector = CONNECTORS.find((c) => c.matches(spec));
  if (!connector) return spec;

  let mod: Awaited<ReturnType<Import>>;
  try {
    mod = await load(connector.pkg);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new UsageError(
        `Reading from ${connector.label} needs the ${connector.pkg} package:\n` +
          `  npm install ${connector.pkg}\n` +
          `or, with npx:\n` +
          `  npx -p costtrace -p ${connector.pkg} costtrace …`,
      );
    }
    throw error;
  }
  try {
    return mod.sourceFromUri(spec);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
