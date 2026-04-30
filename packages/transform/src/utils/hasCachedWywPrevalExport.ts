import fs from 'node:fs';

import type { Services } from '../transform/types';

import { collectOxcExportsAndImports } from './collectOxcExportsAndImports';
import { stripQueryAndHash } from './parseRequest';

type CachedEntrypointLike = {
  evaluated?: boolean;
  ignored?: boolean;
  initialCode?: string;
  loadedAndParsed?: { code?: string; evalConfig?: { filename?: string } };
};

export const hasCachedWywPrevalExport = (
  services: Services,
  resolved: string,
  cached: CachedEntrypointLike | undefined
): boolean => {
  const knownExports = services.cache.get('exports', resolved) as
    | string[]
    | undefined;
  if (knownExports) {
    return (
      knownExports.includes('__wywPreval') || knownExports.includes('*')
    );
  }

  const filename = stripQueryAndHash(resolved);
  const code =
    cached?.initialCode ??
    cached?.loadedAndParsed?.code ??
    fs.readFileSync(filename, 'utf-8');

  try {
    const analyzed = collectOxcExportsAndImports(code, filename);
    if (analyzed.reexports.some((reexport) => reexport.exported === '*')) {
      return true;
    }

    const exportNames = Array.from(
      new Set([
        ...Object.keys(analyzed.exports),
        ...analyzed.reexports
          .filter((reexport) => reexport.exported !== '*')
          .map((reexport) => reexport.exported),
      ])
    );
    services.cache.add('exports', resolved, exportNames);
    return exportNames.includes('__wywPreval');
  } catch {
    return true;
  }
};

export type { CachedEntrypointLike };
