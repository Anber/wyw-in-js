/**
 * This file contains a Vite loader for wyw-in-js.
 * It uses the transform.ts function to generate class names from source code,
 * returns transformed code without template literals and attaches generated source maps
 */

import { existsSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import path from 'path';

import { createFilter, loadEnv } from 'vite';
import type {
  ModuleNode,
  Plugin,
  ResolvedConfig,
  ViteDevServer,
  FilterPattern,
} from 'vite';

import { asyncResolverFactory, logger, syncResolve } from '@wyw-in-js/shared';
import type {
  IFileReporterOptions,
  PluginOptions,
  Preprocessor,
} from '@wyw-in-js/transform';
import {
  createFileReporter,
  getFileIdx,
  transform,
  TransformCacheCollection,
} from '@wyw-in-js/transform';

type VitePluginOptions = {
  debug?: IFileReporterOptions | false | null | undefined;
  exclude?: FilterPattern;
  include?: FilterPattern;
  keepComments?: boolean | RegExp;
  prefixer?: boolean;
  preprocessor?: Preprocessor;
  preserveCssPaths?: boolean;
  sourceMap?: boolean;
  ssrDevCss?: boolean;
  ssrDevCssPath?: string;
  transformLibraries?: boolean;
} & Partial<PluginOptions>;

type OverrideContext = NonNullable<PluginOptions['overrideContext']>;

export { Plugin };

type AssetInfoLike = { name?: unknown };
type AssetFileNames = string | ((assetInfo: AssetInfoLike) => string);
type RollupOutputLike = {
  assetFileNames?: AssetFileNames;
  preserveModules?: boolean;
  preserveModulesRoot?: unknown;
} & Record<string, unknown>;

const isWindowsAbsolutePath = (value: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(value);

const normalizeToPosix = (value: string): string =>
  value.replace(/\\/g, path.posix.sep);

const isInside = (childPath: string, parentPath: string): boolean => {
  const rel = path.relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const isWywCssAssetName = (value: string): boolean =>
  value.endsWith('.wyw-in-js.css');

const normalizeAssetRelativePath = (value: string): string | null => {
  const normalized = path.posix.normalize(
    normalizeToPosix(value).replace(/^\/+/, '')
  );
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    return null;
  }

  return normalized;
};

const stripExtension = (value: string): string => {
  const ext = path.posix.extname(value);
  return ext ? value.slice(0, -ext.length) : value;
};

const getWywCssAssetFileNames = (
  resolvedConfig: ResolvedConfig,
  output: RollupOutputLike,
  originalAssetFileNames: AssetFileNames
): ((assetInfo: AssetInfoLike) => string) | null => {
  if (!output.preserveModules) return null;

  const rootDir = resolvedConfig.root;

  const preserveModulesRootValue = output.preserveModulesRoot;
  let preserveModulesRootAbs: string | null = null;
  if (typeof preserveModulesRootValue === 'string') {
    preserveModulesRootAbs = path.isAbsolute(preserveModulesRootValue)
      ? preserveModulesRootValue
      : path.resolve(rootDir, preserveModulesRootValue);
  }

  const preserveModulesRootRel =
    preserveModulesRootAbs && isInside(preserveModulesRootAbs, rootDir)
      ? normalizeToPosix(path.relative(rootDir, preserveModulesRootAbs))
      : null;

  return (assetInfo) => {
    const template =
      typeof originalAssetFileNames === 'function'
        ? originalAssetFileNames(assetInfo)
        : originalAssetFileNames;

    const assetName = assetInfo?.name;
    if (typeof assetName !== 'string' || !isWywCssAssetName(assetName)) {
      return template;
    }

    if (!template.includes('[')) {
      return template;
    }

    let relativePath: string | null = null;

    const assetNameNormalized = normalizeToPosix(assetName);

    if (
      path.isAbsolute(assetName) ||
      isWindowsAbsolutePath(assetNameNormalized)
    ) {
      const preserveRel =
        preserveModulesRootAbs && isInside(assetName, preserveModulesRootAbs)
          ? path.relative(preserveModulesRootAbs, assetName)
          : null;

      if (
        preserveRel &&
        !path.isAbsolute(preserveRel) &&
        !preserveRel.startsWith('..')
      ) {
        relativePath = preserveRel;
      } else if (isInside(assetName, rootDir)) {
        relativePath = path.relative(rootDir, assetName);
      }
    } else if (
      preserveModulesRootRel &&
      assetNameNormalized.startsWith(`${preserveModulesRootRel}/`)
    ) {
      relativePath = assetNameNormalized.slice(
        preserveModulesRootRel.length + 1
      );
    } else {
      relativePath = assetNameNormalized;
    }

    const normalized = relativePath
      ? normalizeAssetRelativePath(relativePath)
      : null;
    if (!normalized) {
      return template;
    }

    const withoutExt = stripExtension(normalized);

    if (template.includes('[name]')) {
      const dir = path.posix.dirname(withoutExt);
      if (dir === '.' || dir === '') {
        return template;
      }

      return template.replace(/\[name\]/g, `${dir}/[name]`);
    }

    const dir = path.posix.dirname(withoutExt);
    if (dir === '.' || dir === '') {
      return template;
    }

    const idx = template.indexOf('[');
    if (idx < 0) {
      return template;
    }

    const prefix = template.slice(0, idx);
    if (prefix !== '' && !prefix.endsWith('/')) {
      return template;
    }

    return `${prefix}${dir}/${template.slice(idx)}`;
  };
};

export default function wywInJS({
  debug,
  include,
  exclude,
  sourceMap,
  preserveCssPaths,
  keepComments,
  prefixer,
  preprocessor,
  ssrDevCss,
  ssrDevCssPath,
  transformLibraries,
  ...rest
}: VitePluginOptions = {}): Plugin {
  const filter = createFilter(include, exclude);
  const cssLookup: { [key: string]: string } = {};
  const cssFileLookup: { [key: string]: string } = {};
  const pendingCssReloads = new Set<string>();
  let pendingCssReloadTimer: ReturnType<typeof setTimeout> | undefined;
  let ssrDevCssVersion = 0;
  let config: ResolvedConfig;
  let devServer: ViteDevServer;
  let importMetaEnvForEval: {
    client: Record<string, unknown>;
    ssr: Record<string, unknown>;
  } | null = null;

  const ssrDevCssEnabled = Boolean(ssrDevCss);
  const [ssrDevCssPathname, ssrDevCssQuery] = (
    ssrDevCssPath ?? '/_wyw-in-js/ssr.css'
  ).split('?', 2);
  const ssrDevCssRoute = ssrDevCssPathname.startsWith('/')
    ? ssrDevCssPathname
    : `/${ssrDevCssPathname}`;

  const getSsrDevCssHref = () => {
    const versionParam = `v=${ssrDevCssVersion}`;
    const query = ssrDevCssQuery
      ? `${ssrDevCssQuery}&${versionParam}`
      : versionParam;
    return `${ssrDevCssRoute}?${query}`;
  };

  const getSsrDevCssContents = () => {
    const entries = Object.entries(cssLookup);
    if (entries.length === 0) return '';

    const merged = entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, cssText]) => cssText)
      .join('\n');
    return `${merged}\n`;
  };

  const { emitter, onDone } = createFileReporter(debug ?? false);

  const scheduleCssReload = (cssFilename: string) => {
    if (!devServer?.moduleGraph) return;

    pendingCssReloads.add(cssFilename);

    if (pendingCssReloadTimer) return;
    pendingCssReloadTimer = setTimeout(() => {
      pendingCssReloadTimer = undefined;

      const ids = Array.from(pendingCssReloads);
      pendingCssReloads.clear();

      for (const id of ids) {
        const module = devServer.moduleGraph.getModuleById(id);
        if (module) devServer.reloadModule(module);
      }
    }, 0);
  };

  // <dependency id, targets>
  const targets: { dependencies: string[]; id: string }[] = [];
  const cache = new TransformCacheCollection();

  type DepInfoLike = { file: string; processing?: Promise<void> };
  type DepsOptimizerLike = {
    init?: () => Promise<void>;
    isOptimizedDepFile?: (id: string) => boolean;
    metadata?: { depInfoList?: DepInfoLike[] };
    scanProcessing?: Promise<void>;
  };

  type ViteServerWithDepsOptimizer = ViteDevServer & {
    _depsOptimizer?: DepsOptimizerLike;
    depsOptimizer?: DepsOptimizerLike;
    environments?: Record<string, { depsOptimizer?: DepsOptimizerLike }>;
  };

  const isInsideCacheDir = (filename: string): boolean => {
    if (!config.cacheDir) {
      return false;
    }

    const relative = path.relative(config.cacheDir, filename);
    return (
      relative !== '' &&
      !relative.startsWith('..') &&
      !path.isAbsolute(relative)
    );
  };

  const getDepsOptimizer = (): DepsOptimizerLike | null => {
    if (!devServer) return null;

    const server = devServer as unknown as ViteServerWithDepsOptimizer;
    return (
      server.environments?.client?.depsOptimizer ??
      server.depsOptimizer ??
      server._depsOptimizer ??
      null
    );
  };

  const waitForOptimizedDep = async (filename: string): Promise<boolean> => {
    const depsOptimizer = getDepsOptimizer();
    if (!depsOptimizer?.isOptimizedDepFile?.(filename)) {
      return false;
    }

    await depsOptimizer.init?.();
    await depsOptimizer.scanProcessing;

    const info = depsOptimizer.metadata?.depInfoList?.find(
      (item) => item.file === filename
    );
    if (info?.processing) {
      await info.processing;
    }

    return true;
  };

  const createAsyncResolver = asyncResolverFactory(
    async (
      resolved: { external: boolean | 'absolute'; id: string } | null,
      what: string,
      importer: string,
      stack: string[]
    ): Promise<string | null> => {
      const log = logger.extend('vite').extend(getFileIdx(importer));

      if (resolved) {
        if (resolved.external) {
          // If module is marked as external, Rollup will not resolve it,
          // so we need to resolve it ourselves with default resolver
          const resolvedId = syncResolve(what, importer, stack);
          log("resolve ✅ '%s'@'%s -> %O\n%s", what, importer, resolved);
          return resolvedId;
        }

        log("resolve ✅ '%s'@'%s -> %O\n%s", what, importer, resolved);

        // Vite adds param like `?v=667939b3` to cached modules
        const resolvedId = resolved.id.split('?', 1)[0];

        if (resolvedId.startsWith('\0')) {
          // \0 is a special character in Rollup that tells Rollup to not include this in the bundle
          // https://rollupjs.org/guide/en/#outputexports
          return null;
        }

        if (resolvedId.startsWith('/@')) {
          return null;
        }

        if (!existsSync(resolvedId)) {
          // When Vite resolves to an optimized deps entry (cacheDir) it may not be written yet.
          // Wait for Vite's optimizer instead of calling optimizeDeps() manually (deprecated in Vite 7).
          try {
            await waitForOptimizedDep(resolvedId);
          } catch {
            // If optimizer failed, fall through to preserve previous behavior and surface the error.
          }

          // Vite can return an optimized deps entry (from cacheDir) before it's written to disk.
          // Manually calling optimizeDeps is deprecated in Vite 7 and can also get called many times.
          // Instead, fall back to resolving the original module path directly.
          if (!existsSync(resolvedId) && isInsideCacheDir(resolvedId)) {
            try {
              return syncResolve(what, importer, stack);
            } catch {
              // Fall through to preserve previous behavior: return resolvedId and let WyW surface the error.
            }
          }
        }

        return resolvedId;
      }

      log("resolve ❌ '%s'@'%s", what, importer);
      throw new Error(`Could not resolve ${what}`);
    },
    (what, importer) => [what, importer]
  );

  return {
    name: 'wyw-in-js',
    enforce: 'post',
    buildEnd() {
      onDone(process.cwd());
    },
    configResolved(resolvedConfig: ResolvedConfig) {
      config = resolvedConfig;

      if (preserveCssPaths && config.command === 'build') {
        const outputs = config.build.rollupOptions.output;
        let outputEntries: unknown[] = [];
        if (Array.isArray(outputs)) {
          outputEntries = outputs;
        } else if (outputs) {
          outputEntries = [outputs];
        }

        outputEntries.forEach((entry) => {
          if (!entry || typeof entry !== 'object') return;

          const output = entry as RollupOutputLike;
          if (!output.preserveModules) return;

          const template: AssetFileNames =
            output.assetFileNames ??
            `${config.build.assetsDir ?? 'assets'}/[name].[hash].[ext]`;

          const assetFileNames = getWywCssAssetFileNames(
            config,
            output,
            template
          );
          if (assetFileNames) output.assetFileNames = assetFileNames;
        });
      }

      const envPrefix = config.envPrefix ?? 'VITE_';
      const envDir =
        // envDir is absolute in modern Vite, but keep a fallback for older versions
        'envDir' in config && typeof config.envDir === 'string'
          ? config.envDir
          : config.root;

      const loaded = loadEnv(config.mode, envDir, envPrefix);
      const base = {
        ...loaded,
        BASE_URL: config.base,
        MODE: config.mode,
        DEV: config.command === 'serve',
        PROD: config.command === 'build',
      };

      importMetaEnvForEval = {
        client: { ...base, SSR: false },
        ssr: { ...base, SSR: true },
      };
    },
    configureServer(_server) {
      devServer = _server;

      if (!ssrDevCssEnabled || config.command !== 'serve') return;

      devServer.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const { url } = req;
          if (!url) {
            next();
            return;
          }

          const [pathname] = url.split('?', 1);
          if (pathname !== ssrDevCssRoute) {
            next();
            return;
          }

          const etag = `W/"${ssrDevCssVersion}"`;
          const ifNoneMatch = req.headers['if-none-match'];
          if (ifNoneMatch === etag) {
            res.statusCode = 304;
            res.end();
            return;
          }

          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('ETag', etag);
          res.end(getSsrDevCssContents());
        }
      );
    },
    transformIndexHtml(html) {
      if (!ssrDevCssEnabled || config.command !== 'serve') return undefined;

      return {
        html,
        tags: [
          {
            tag: 'link',
            attrs: { rel: 'stylesheet', href: getSsrDevCssHref() },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
    load(url: string) {
      const [id] = url.split('?', 1);
      return cssLookup[id];
    },
    /* eslint-disable-next-line consistent-return */
    resolveId(importeeUrl: string) {
      const [id] = importeeUrl.split('?', 1);
      if (cssLookup[id]) return id;
      return cssFileLookup[id];
    },
    handleHotUpdate(ctx) {
      // it's module, so just transform it
      if (ctx.modules.length) return ctx.modules;

      // Select affected modules of changed dependency
      const affected = targets.filter(
        (x) =>
          // file is dependency of any target
          x.dependencies.some((dep) => dep === ctx.file) ||
          // or changed module is a dependency of any target
          x.dependencies.some((dep) => ctx.modules.some((m) => m.file === dep))
      );
      const deps = affected.flatMap((target) => target.dependencies);

      // eslint-disable-next-line no-restricted-syntax
      for (const depId of deps) {
        cache.invalidateForFile(depId);
      }

      return affected
        .map((target) => devServer.moduleGraph.getModuleById(target.id))
        .concat(ctx.modules)
        .filter((m): m is ModuleNode => !!m);
    },
    async transform(
      code: string,
      url: string,
      transformOptions?: boolean | { ssr?: boolean }
    ) {
      const [id] = url.split('?', 1);

      // Do not transform ignored and generated files
      if (
        (!transformLibraries && url.includes('node_modules')) ||
        !filter(url) ||
        id in cssLookup
      )
        return;

      const log = logger.extend('vite').extend(getFileIdx(id));

      log('transform %s', id);

      const overrideContext: OverrideContext = (context, filename) => {
        const isSsr =
          typeof transformOptions === 'boolean'
            ? transformOptions
            : Boolean(transformOptions?.ssr);
        const env = importMetaEnvForEval?.[isSsr ? 'ssr' : 'client'];
        const withEnv = env
          ? { ...context, __wyw_import_meta_env: env }
          : context;

        return rest.overrideContext
          ? rest.overrideContext(withEnv, filename)
          : withEnv;
      };

      const transformServices = {
        options: {
          filename: id,
          root: process.cwd(),
          prefixer,
          keepComments,
          preprocessor,
          pluginOptions: {
            ...rest,
            overrideContext,
          },
        },
        cache,
        emitWarning: (message: string) => this.warn(message),
        eventEmitter: emitter,
      };

      const result = await transform(
        transformServices,
        code,
        createAsyncResolver(this.resolve)
      );

      let { cssText, dependencies } = result;

      // Heads up, there are three cases:
      // 1. cssText is undefined, it means that file was not transformed
      // 2. cssText is empty, it means that file was transformed, but it does not contain any styles
      // 3. cssText is not empty, it means that file was transformed and it contains styles

      if (typeof cssText === 'undefined') {
        return;
      }

      if (cssText === '') {
        /* eslint-disable-next-line consistent-return */
        return {
          code: result.code,
          map: result.sourceMap,
        };
      }

      dependencies ??= [];

      const cssFilename = path
        .normalize(`${id.replace(/\.[jt]sx?$/, '')}.wyw-in-js.css`)
        .replace(/\\/g, path.posix.sep);

      const cssRelativePath = path
        .relative(config.root, cssFilename)
        .replace(/\\/g, path.posix.sep);

      const cssId = `/${cssRelativePath}`;

      if (sourceMap && result.cssSourceMapText) {
        const map = Buffer.from(result.cssSourceMapText).toString('base64');
        cssText += `/*# sourceMappingURL=data:application/json;base64,${map}*/`;
      }

      const didCssChange = cssLookup[cssFilename] !== cssText;
      cssLookup[cssFilename] = cssText;
      cssFileLookup[cssId] = cssFilename;

      result.code += `\nimport ${JSON.stringify(cssFilename)};\n`;

      for (let i = 0, end = dependencies.length; i < end; i++) {
        // eslint-disable-next-line no-await-in-loop
        const depModule = await this.resolve(dependencies[i], url, {
          isEntry: false,
        });
        if (depModule) dependencies[i] = depModule.id;
      }
      const target = targets.find((t) => t.id === id);
      if (!target) targets.push({ id, dependencies });
      else target.dependencies = dependencies;

      if (didCssChange) {
        scheduleCssReload(cssFilename);
        if (ssrDevCssEnabled && config.command === 'serve') {
          ssrDevCssVersion += 1;
        }
      }
      /* eslint-disable-next-line consistent-return */
      return { code: result.code, map: result.sourceMap };
    },
  };
}
