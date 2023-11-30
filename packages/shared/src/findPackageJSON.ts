import { dirname, isAbsolute } from 'path';
import * as process from 'process';

import findUp from 'find-up';

const cache = new Map<string, string | undefined>();

export function findPackageJSON(
  pkgName: string,
  filename: string | null | undefined
) {
  try {
    // Jest's resolver does not work properly with `moduleNameMapper` when `paths` are defined
    const isJest = Boolean(process.env.JEST_WORKER_ID);
    const skipPathsOptions = isJest && !pkgName.startsWith('.');

    const pkgPath =
      pkgName === '.' && filename && isAbsolute(filename)
        ? filename
        : require.resolve(
            pkgName,
            filename ? { paths: [dirname(filename)] } : {}
            // filename && !skipPathsOptions ? { paths: [dirname(filename)] } : {}
          );
    if (!cache.has(pkgPath)) {
      cache.set(pkgPath, findUp.sync('package.json', { cwd: pkgPath }));
    }

    return cache.get(pkgPath);
  } catch (er: unknown) {
    if (
      typeof er === 'object' &&
      er !== null &&
      (er as { code?: unknown }).code === 'MODULE_NOT_FOUND'
    ) {
      return undefined;
    }

    throw er;
  }
}
