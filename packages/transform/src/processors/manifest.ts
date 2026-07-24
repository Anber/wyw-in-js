import { readFileSync } from 'fs';
import { dirname, extname, resolve } from 'path';

const SUPPORTED_PROCESSOR_MANIFEST_VERSION = 1;
const SUPPORTED_PROCESSOR_MANIFEST_FIELDS = new Set([
  'version',
  'name',
  'implementation',
  'tags',
  'semantics',
]);

export type ProcessorManifest = {
  version: 1;
  name: string;
  implementation: string;
  /** Directory of the manifest file; anchors relative module references. */
  dir: string;
  tags?: string[];
  semantics?: unknown;
};

export type ResolvedProcessorReference = {
  implementationPath: string;
  manifest: ProcessorManifest | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const manifestError = (manifestPath: string, message: string): Error =>
  new Error(
    `[wyw-in-js] Invalid processor manifest ${manifestPath}: ${message}`
  );

const readStringField = (
  manifestPath: string,
  manifest: Record<string, unknown>,
  field: string
): string => {
  const value = manifest[field];
  if (typeof value !== 'string' || !value) {
    throw manifestError(
      manifestPath,
      `Processor manifest "${field}" must be a string`
    );
  }

  return value;
};

const readTags = (
  manifestPath: string,
  manifest: Record<string, unknown>
): string[] | undefined => {
  const { tags } = manifest;
  if (tags === undefined) {
    return undefined;
  }

  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw manifestError(
      manifestPath,
      'Processor manifest "tags" must be an array of strings'
    );
  }

  return tags;
};

const parseManifest = (manifestPath: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw manifestError(manifestPath, message);
  }

  if (!isRecord(parsed)) {
    throw manifestError(manifestPath, 'Processor manifest must be an object');
  }

  return parsed;
};

const resolveImplementationPath = (
  manifestPath: string,
  implementation: string
): string => resolve(dirname(manifestPath), implementation);

const warnUnsupportedVersion = (
  manifestPath: string,
  version: unknown,
  implementationPath: string
): void => {
  // eslint-disable-next-line no-console
  console.warn(
    [
      `[wyw-in-js] Unsupported processor manifest version ${String(
        version
      )} in ${manifestPath}.`,
      `Falling back to JS implementation ${implementationPath}.`,
    ].join(' ')
  );
};

export const loadProcessorManifest = (
  manifestPath: string
): ResolvedProcessorReference => {
  const manifest = parseManifest(manifestPath);
  const { version } = manifest;

  if (typeof version !== 'number') {
    throw manifestError(
      manifestPath,
      'Processor manifest "version" must be a number'
    );
  }

  if (version !== SUPPORTED_PROCESSOR_MANIFEST_VERSION) {
    const implementation = readStringField(
      manifestPath,
      manifest,
      'implementation'
    );
    const implementationPath = resolveImplementationPath(
      manifestPath,
      implementation
    );

    warnUnsupportedVersion(manifestPath, version, implementationPath);

    return {
      implementationPath,
      manifest: null,
    };
  }

  Object.keys(manifest).forEach((field) => {
    if (!SUPPORTED_PROCESSOR_MANIFEST_FIELDS.has(field)) {
      throw manifestError(
        manifestPath,
        `Unknown processor manifest field "${field}"`
      );
    }
  });

  const name = readStringField(manifestPath, manifest, 'name');
  const implementation = readStringField(
    manifestPath,
    manifest,
    'implementation'
  );
  const tags = readTags(manifestPath, manifest);
  const implementationPath = resolveImplementationPath(
    manifestPath,
    implementation
  );
  const normalizedManifest: ProcessorManifest = {
    version,
    name,
    implementation,
    dir: dirname(manifestPath),
  };

  if (tags) {
    normalizedManifest.tags = tags;
  }
  if ('semantics' in manifest) {
    normalizedManifest.semantics = manifest.semantics;
  }

  return {
    implementationPath,
    manifest: normalizedManifest,
  };
};

export const resolveProcessorReference = (
  processorPath: string
): ResolvedProcessorReference => {
  if (extname(processorPath).toLowerCase() !== '.json') {
    return {
      implementationPath: processorPath,
      manifest: null,
    };
  }

  return loadProcessorManifest(processorPath);
};
