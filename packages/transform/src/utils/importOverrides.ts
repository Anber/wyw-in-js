import path from 'path';

import { syncResolve, type ImportOverride } from '@wyw-in-js/shared';

export type ImportKeyKind = 'file' | 'package';

export type ImportKey = {
  key: string;
  kind: ImportKeyKind;
};

export function toCanonicalFileKey(
  resolved: string,
  root: string | undefined
): string {
  const rootDir = root ? path.resolve(root) : process.cwd();
  const normalizedResolved = path.resolve(resolved);
  let relative = path.relative(rootDir, normalizedResolved);

  if (path.sep !== path.posix.sep) {
    relative = relative.split(path.sep).join(path.posix.sep);
  }

  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }

  return relative;
}

export function toImportKey({
  source,
  resolved,
  root,
}: {
  resolved: string | null;
  root: string | undefined;
  source: string;
}): ImportKey {
  const isFileImport = source.startsWith('.') || path.isAbsolute(source);

  if (isFileImport && resolved) {
    return { key: toCanonicalFileKey(resolved, root), kind: 'file' };
  }

  return { key: source, kind: 'package' };
}

export function resolveMockSpecifier({
  importer,
  mock,
  root,
  stack,
}: {
  importer: string;
  mock: string;
  root: string | undefined;
  stack: string[];
}): string {
  const specifier =
    mock.startsWith('.') && root ? path.resolve(root, mock) : mock;

  return syncResolve(specifier, importer, stack);
}

export function applyImportOverrideToOnly(
  only: string[],
  override: ImportOverride | undefined
): string[] {
  if (override?.noShake) {
    return ['*'];
  }

  return only;
}
