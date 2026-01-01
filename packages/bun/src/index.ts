import { readFileSync } from 'fs';
import path from 'path';

import { createFilter } from '@rollup/pluginutils';
import type { FilterPattern } from '@rollup/pluginutils';

import { asyncResolveFallback } from '@wyw-in-js/shared';
import type {
  IFileReporterOptions,
  PluginOptions,
  Preprocessor,
} from '@wyw-in-js/transform';
import {
  createFileReporter,
  slugify,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

type BunLoader = 'js' | 'jsx' | 'ts' | 'tsx' | 'css';

type BunPluginBuild = {
  initialOptions: Record<string, unknown>;
  onEnd: (callback: () => void) => void;
  onLoad: (
    options: { filter: RegExp; namespace?: string },
    callback: (args: { namespace: string; path: string }) => Promise<
      | {
          contents?: string;
          loader?: BunLoader;
          resolveDir?: string;
        }
      | null
      | undefined
    >
  ) => void;
  onResolve: (
    options: { filter: RegExp; namespace?: string },
    callback: (args: { path: string }) => { namespace?: string; path: string }
  ) => void;
};

export type BunPlugin = {
  name: string;
  setup: (build: BunPluginBuild) => void;
};

export type BunPluginOptions = {
  debug?: IFileReporterOptions | false | null | undefined;
  exclude?: FilterPattern;
  filter?: RegExp | string;
  include?: FilterPattern;
  keepComments?: boolean | RegExp;
  nodeModules?: boolean;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  sourceMap?: boolean;
} & Partial<PluginOptions>;

type BunTranspiler = {
  scanImports: (code: string) => Array<{ kind: string; path: string }>;
  transformSync: (code: string) => string;
};

type BunRuntime = {
  Transpiler: new (options: { loader: BunLoader }) => BunTranspiler;
  resolveSync?: (specifier: string, from: string) => string;
};

const nodeModulesRegex = /^(?:.*[\\/])?node_modules(?:[\\/].*)?$/;

function getBunRuntime(): BunRuntime | undefined {
  return (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
}

function getLoader(filename: string): BunLoader {
  const ext = path.extname(filename);
  switch (ext) {
    case '.jsx':
      return 'jsx';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    default:
      return 'js';
  }
}

function getShebang(code: string): string | null {
  const match = code.match(/^#!.*\n/);
  return match ? match[0] : null;
}

function splitQueryAndHash(request: string): {
  specifier: string;
  suffix: string;
} {
  const queryIdx = request.indexOf('?');
  const hashIdx = request.indexOf('#');

  if (queryIdx === -1 && hashIdx === -1) {
    return { specifier: request, suffix: '' };
  }

  let startIdx: number;
  if (queryIdx === -1) {
    startIdx = hashIdx;
  } else if (hashIdx === -1) {
    startIdx = queryIdx;
  } else {
    startIdx = Math.min(queryIdx, hashIdx);
  }

  return {
    specifier: request.slice(0, startIdx),
    suffix: request.slice(startIdx),
  };
}

function uniq<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

function getMatches(code: string, re: RegExp): string[] {
  return uniq(Array.from(code.matchAll(re), (m) => m[0]));
}

function injectJsxRuntimeImports(
  code: string,
  imports: Array<{ kind: string; path: string }>
): string {
  const runtimeDev = imports.find((i) => i.path.endsWith('/jsx-dev-runtime'))
    ?.path;
  const runtimeProd = imports.find((i) => i.path.endsWith('/jsx-runtime'))
    ?.path;

  const jsxDevIds = getMatches(code, /\bjsxDEV_[A-Za-z0-9]+\b/g);
  const jsxIds = getMatches(code, /\bjsx_[A-Za-z0-9]+\b/g);
  const jsxsIds = getMatches(code, /\bjsxs_[A-Za-z0-9]+\b/g);
  const fragmentIds = getMatches(code, /\bFragment_[A-Za-z0-9]+\b/g);

  const runtime =
    jsxDevIds.length > 0 || (runtimeDev && runtimeProd === undefined)
      ? runtimeDev
      : runtimeProd;

  if (!runtime) {
    return code;
  }

  const specifiers: string[] = [];
  const assignments: string[] = [];

  const addImport = (exportName: string, ids: string[]) => {
    if (ids.length === 0) {
      return;
    }

    const [first, ...rest] = ids;
    specifiers.push(`${exportName} as ${first}`);
    for (const id of rest) {
      assignments.push(`const ${id} = ${first};`);
    }
  };

  if (runtime.endsWith('/jsx-dev-runtime')) {
    addImport('jsxDEV', jsxDevIds);
    addImport('Fragment', fragmentIds);
  } else {
    addImport('jsx', jsxIds);
    addImport('jsxs', jsxsIds);
    addImport('Fragment', fragmentIds);
  }

  if (specifiers.length === 0) {
    return code;
  }

  const prelude = [
    `import { ${specifiers.join(', ')} } from ${JSON.stringify(runtime)};`,
    ...assignments,
    '',
  ].join('\n');

  const shebang = getShebang(code);
  if (!shebang) {
    return prelude + code;
  }

  return shebang + prelude + code.slice(shebang.length);
}

export default function wywInJS({
  debug,
  include,
  exclude,
  filter = /\.[cm]?[jt]sx?$/,
  nodeModules = false,
  sourceMap,
  keepComments,
  prefixer,
  preprocessor,
  ...rest
}: BunPluginOptions = {}): BunPlugin {
  const cache = new TransformCacheCollection();
  const filterFn = createFilter(include, exclude);

  return {
    name: 'wyw-in-js',
    setup(build) {
      const bun = getBunRuntime();
      if (!bun?.Transpiler) {
        throw new Error(
          '[wyw-in-js] @wyw-in-js/bun must be used in Bun runtime (Bun.build).'
        );
      }

      const cssLookup = new Map<string, string>();
      const cssResolveDirs = new Map<string, string>();
      const emittedWarnings = new Set<string>();

      const { emitter, onDone } = createFileReporter(debug ?? false);

      const transpilers = new Map<BunLoader, BunTranspiler>();
      const getTranspiler = (loader: BunLoader): BunTranspiler => {
        const cached = transpilers.get(loader);
        if (cached) {
          return cached;
        }

        const created = new bun.Transpiler({ loader });
        transpilers.set(loader, created);
        return created;
      };

      const asyncResolve = async (
        what: string,
        importer: string,
        stack: string[]
      ): Promise<string | null> => {
        const { specifier, suffix } = splitQueryAndHash(what);
        try {
          return (await asyncResolveFallback(specifier, importer, stack))
            .replace(/\\/g, path.posix.sep)
            .concat(suffix);
        } catch {
          if (typeof bun.resolveSync !== 'function') {
            throw new Error(`Could not resolve ${what}`);
          }

          return bun
            .resolveSync(specifier, importer)
            .replace(/\\/g, path.posix.sep)
            .concat(suffix);
        }
      };

      const emitWarning = (message: string) => {
        const match = message.match(/\nconfig key: (.+)\n/);
        const key = match?.[1] ?? message;
        if (emittedWarnings.has(key)) {
          return;
        }

        emittedWarnings.add(key);
        // eslint-disable-next-line no-console
        console.warn(message);
      };

      build.onEnd(() => {
        onDone(process.cwd());
      });

      build.onResolve({ filter: /\.wyw\.css$/ }, (args) => ({
        namespace: 'wyw-in-js',
        path: args.path,
      }));

      build.onLoad({ filter: /.*/, namespace: 'wyw-in-js' }, async (args) => ({
        contents: cssLookup.get(args.path),
        loader: 'css',
        resolveDir: cssResolveDirs.get(args.path),
      }));

      const filterRegexp =
        typeof filter === 'string' ? new RegExp(filter) : filter;

      build.onLoad({ filter: filterRegexp }, async (args) => {
        if (!filterFn(args.path)) {
          return null;
        }

        if (!nodeModules && nodeModulesRegex.test(args.path)) {
          return null;
        }

        const rawCode = readFileSync(args.path, 'utf8');
        const loader = getLoader(args.path);
        const transpiler = getTranspiler(loader);

        const transpiled = transpiler.transformSync(rawCode);
        const imports = transpiler.scanImports(rawCode);
        const code = injectJsxRuntimeImports(transpiled, imports);

        const transformServices = {
          options: {
            filename: args.path,
            pluginOptions: rest,
            prefixer,
            keepComments,
            preprocessor,
            root: process.cwd(),
          },
          cache,
          emitWarning,
          eventEmitter: emitter,
        };

        const result = await transform(transformServices, code, asyncResolve);

        const { cssText } = result;

        if (typeof cssText === 'undefined') {
          return null;
        }

        const resolveDir = path.dirname(args.path);

        if (cssText === '') {
          let contents = result.code;

          if (sourceMap && result.sourceMap) {
            const map = Buffer.from(JSON.stringify(result.sourceMap)).toString(
              'base64'
            );
            contents += `\n//# sourceMappingURL=data:application/json;base64,${map}`;
          }

          return {
            contents,
            loader,
            resolveDir,
          };
        }

        const slug = slugify(cssText);
        const cssFilename = `${args.path.replace(
          /\.[cm]?[jt]sx?$/,
          ''
        )}_${slug}.wyw.css`.replace(/\\/g, path.posix.sep);

        let nextCssText = cssText;
        let contents = `${result.code}\nimport ${JSON.stringify(
          cssFilename
        )};\n`;

        if (sourceMap && result.cssSourceMapText) {
          const map = Buffer.from(result.cssSourceMapText).toString('base64');
          nextCssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
        }

        if (sourceMap && result.sourceMap) {
          const map = Buffer.from(JSON.stringify(result.sourceMap)).toString(
            'base64'
          );
          contents += `//# sourceMappingURL=data:application/json;base64,${map}\n`;
        }

        cssLookup.set(cssFilename, nextCssText);
        cssResolveDirs.set(cssFilename, resolveDir);

        return {
          contents,
          loader,
          resolveDir,
        };
      });
    },
  };
}
