import { dirname, isAbsolute } from 'path';
import * as process from 'process';

import findUp from 'find-up';

const cache = new Map<string, string | undefined>();

export function findPackageJSON(
  pkgName: string,
  filename: string | null | undefined
) {
  // Jest's resolver does not work properly with `moduleNameMapper` when `paths` are defined
  const isJest = Boolean(globalThis.process?.env?.JEST_WORKER_ID);
  const skipPathsOptions = isJest && !pkgName.startsWith('.');

  try {
    const pkgPath =
      pkgName === '.' && filename && isAbsolute(filename)
        ? filename
        : require.resolve(
            pkgName,
            filename ? { paths: [dirname(filename)] } : {}
          );
    if (!cache.has(pkgPath)) {
      cache.set(pkgPath, findUp.sync('package.json', { cwd: pkgPath }));
    }

    return cache.get(pkgPath);
  } catch (er: unknown) {
    const code =
      typeof er === 'object' && er !== null && 'code' in er
        ? er.code
        : undefined;

    if (code === 'MODULE_NOT_FOUND') {
      if (skipPathsOptions && filename) {
        return findPackageJSON(pkgName, null);
      }

      return undefined;
    }

    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      // See https://github.com/Anber/wyw-in-js/issues/43
      // `require` can't resolve ESM-only packages. We can use the `resolve`
      // package here, but it does not solve all cases because `pkgName`
      // can be an alias and should be resolved by a bundler. However, we can't use
      // `resolve` from a bundler because it is async. The good news is that in that
      // specific case, we can just ignore those packages. For now.
      return undefined;
    }

    throw er;
  }
}
