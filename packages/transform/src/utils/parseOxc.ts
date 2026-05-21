import { parseSync } from 'oxc-parser';
import type { Program } from 'oxc-parser';

type OxcSourceType = 'module' | 'unambiguous';

type ParsedOxc = {
  module: {
    hasModuleSyntax: boolean;
  };
  program: Program;
};

// 200 evicts under sustained pressure on large monorepos — the
// removeUnusedAfterReplacement cleanup loop reparses on every iteration
// (new content -> new key) and applyOxcProcessors reparses after extraction.
// 1000 is still bounded (~50-100 MB worst case for an enormous build) and
// keeps every entry hot across the actions for a single file.
const MAX_PARSE_CACHE_ENTRIES = 1000;
const parseCache = new Map<string, ParsedOxc>();

const getAstType = (filename: string): 'js' | 'ts' =>
  filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js';

const makeCacheKey = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): string => `${sourceType}\0${filename}\0${code}`;

const setCachedParse = (key: string, value: ParsedOxc): ParsedOxc => {
  parseCache.set(key, value);
  if (parseCache.size > MAX_PARSE_CACHE_ENTRIES) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey) {
      parseCache.delete(oldestKey);
    }
  }

  return value;
};

export const parseOxcCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): ParsedOxc => {
  const cacheKey = makeCacheKey(filename, code, sourceType);
  const cached = parseCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const parsed = parseSync(filename, code, {
    astType: getAstType(filename),
    range: true,
    sourceType,
  });
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    throw new Error(fatalError.message);
  }

  return setCachedParse(cacheKey, {
    module: {
      hasModuleSyntax: parsed.module.hasModuleSyntax,
    },
    program: parsed.program as Program,
  });
};

export const parseOxcProgramCached = (
  filename: string,
  code: string,
  sourceType: OxcSourceType
): Program => parseOxcCached(filename, code, sourceType).program;
