import fs from 'fs';
import path from 'path';

import type { LoaderOptions as WywWebpackLoaderOptions } from '@wyw-in-js/webpack-loader';
import type { NextConfig } from 'next';
import type { Configuration, RuleSetRule, RuleSetUseItem } from 'webpack';

const DEFAULT_EXTENSION = '.wyw-in-js.module.css';

const DEFAULT_TURBO_RULE_KEYS = ['*.js', '*.jsx', '*.ts', '*.tsx'];

const PLACEHOLDER_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const PLACEHOLDER_IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'node_modules',
]);

export type WywNextPluginOptions = {
  loaderOptions?: Omit<WywWebpackLoaderOptions, 'extension' | 'sourceMap'> &
    Partial<Pick<WywWebpackLoaderOptions, 'extension' | 'sourceMap'>>;
  turbopackLoaderOptions?: Record<string, unknown>;
};

type NextWebpackConfigFn = NonNullable<NextConfig['webpack']>;
type NextWebpackOptions = Parameters<NextWebpackConfigFn>[1];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUseLoaderObject(
  item: RuleSetUseItem
): item is Exclude<RuleSetUseItem, string> & { loader: string } {
  return (
    isObject(item) &&
    typeof (item as Record<string, unknown>).loader === 'string'
  );
}

function normalizeUseItems(use: RuleSetRule['use']): RuleSetUseItem[] | null {
  if (!use) return null;
  if (typeof use === 'function') return null;

  const list = (Array.isArray(use) ? use : [use]).filter(Boolean);
  return list.length ? (list as RuleSetUseItem[]) : null;
}

function getLoaderName(item: RuleSetUseItem): string {
  if (typeof item === 'string') return item;
  if (isUseLoaderObject(item)) return item.loader;
  return '';
}

function isWywLoaderPath(loader: string) {
  return (
    loader.includes('@wyw-in-js/webpack-loader') ||
    /[\\/]webpack-loader[\\/]/.test(loader)
  );
}

function convertLoaderRuleToUseRule(
  rule: RuleSetRule,
  wywLoaderItem: RuleSetUseItem
) {
  const { loader } = rule as { loader?: unknown };
  if (typeof loader !== 'string') return;

  const alreadyInjected = isWywLoaderPath(loader);
  if (alreadyInjected) return;

  const isNextJsTranspileRule = [
    'next-swc-loader',
    'next-babel-loader',
    'babel-loader',
  ].some((needle) => loader.includes(needle));
  if (!isNextJsTranspileRule) return;

  const { options } = rule as { options?: unknown };

  const nextRule = rule as RuleSetRule & {
    loader?: unknown;
    options?: unknown;
  };

  delete nextRule.loader;
  delete nextRule.options;

  // Loader order is right-to-left. We want WyW to run first, so it should be last.
  Object.assign(nextRule, {
    use: [
      { loader, ...(options !== undefined ? { options } : {}) },
      wywLoaderItem,
    ],
  });
}

function traverseRules(rules: unknown[], visitor: (rule: RuleSetRule) => void) {
  for (const rule of rules) {
    if (rule && typeof rule === 'object') {
      visitor(rule as RuleSetRule);

      if (Array.isArray((rule as RuleSetRule).oneOf)) {
        traverseRules((rule as RuleSetRule).oneOf!, visitor);
      }
      if (Array.isArray((rule as RuleSetRule).rules)) {
        traverseRules((rule as RuleSetRule).rules!, visitor);
      }
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoFunctions(value: unknown, name: string) {
  const queue: Array<{ path: string; value: unknown }> = [
    { path: name, value },
  ];
  const seen = new Set<unknown>();

  while (queue.length) {
    const current = queue.shift()!;

    if (typeof current.value === 'function') {
      throw new Error(
        `${current.path} must be JSON-serializable (functions are not supported in Turbopack loader options). Use "configFile" to pass non-JSON config.`
      );
    }

    if (current.value === null) {
      // skip
    } else if (Array.isArray(current.value)) {
      if (!seen.has(current.value)) {
        seen.add(current.value);
        current.value.forEach((item, idx) =>
          queue.push({ path: `${current.path}[${idx}]`, value: item })
        );
      }
    } else if (isPlainObject(current.value)) {
      if (!seen.has(current.value)) {
        seen.add(current.value);
        Object.entries(current.value).forEach(([key, item]) =>
          queue.push({ path: `${current.path}.${key}`, value: item })
        );
      }
    }
  }
}

function createWywCssModuleRule(
  baseRule: RuleSetRule,
  extensionSuffix: string
): RuleSetRule {
  const use = normalizeUseItems(baseRule.use) ?? [];

  const patchedUse = use.map((item) => {
    if (!isUseLoaderObject(item) || !item.loader.includes('css-loader')) {
      return item;
    }

    const itemOptions = (item as { options?: unknown }).options;
    if (!isObject(itemOptions)) {
      return item;
    }

    const { modules } = itemOptions as { modules?: unknown };
    if (!isObject(modules)) {
      return item;
    }

    const nextModules = {
      ...(modules as Record<string, unknown>),
      mode: 'global',
      getLocalIdent: (
        _context: unknown,
        _localIdentName: string,
        localName: string
      ) => localName,
    };

    return {
      ...item,
      options: {
        ...(itemOptions as Record<string, unknown>),
        modules: nextModules,
      },
    };
  });

  const nextRule: RuleSetRule = {
    ...baseRule,
    sideEffects: true,
    test: new RegExp(`${escapeRegExp(extensionSuffix)}$`),
    use: patchedUse,
  };

  return nextRule;
}

function ensureWywCssModuleRules(
  config: Configuration,
  extensionSuffix: string
) {
  traverseRules(config.module?.rules ?? [], (rule) => {
    if (!Array.isArray(rule.oneOf) || rule.oneOf.length === 0) {
      return;
    }

    const expectedTestSource = `${escapeRegExp(extensionSuffix)}$`;

    const alreadyPresent = rule.oneOf.some((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;

      const { test } = candidate as RuleSetRule;
      return test instanceof RegExp && test.source === expectedTestSource;
    });

    if (alreadyPresent) {
      return;
    }

    const oneOf = rule.oneOf as unknown[];
    for (let idx = 0; idx < oneOf.length; idx += 1) {
      const candidate = oneOf[idx];
      if (candidate && typeof candidate === 'object') {
        const candidateRule = candidate as RuleSetRule;
        const { test } = candidateRule;

        const isModuleCssRule =
          test instanceof RegExp && test.source.includes('\\.module\\.css');

        if (isModuleCssRule) {
          const use = normalizeUseItems(candidateRule.use);
          if (use) {
            const hasCssLoader = use.some(
              (item) =>
                isUseLoaderObject(item) && item.loader.includes('css-loader')
            );
            if (hasCssLoader) {
              oneOf.splice(
                idx,
                0,
                createWywCssModuleRule(candidateRule, extensionSuffix)
              );
              break;
            }
          }
        }
      }
    }
  });
}

function injectWywLoader(
  config: Configuration,
  nextOptions: NextWebpackOptions,
  wywNext: WywNextPluginOptions
) {
  const loader = require.resolve('@wyw-in-js/webpack-loader');
  const nextBabelPreset = require.resolve('next/babel', {
    paths: [process.cwd()],
  });

  const extension = wywNext.loaderOptions?.extension ?? DEFAULT_EXTENSION;
  const babelOptions = wywNext.loaderOptions?.babelOptions ?? {
    presets: [nextBabelPreset],
  };

  const loaderOptions = {
    cssImport: 'import',
    ...wywNext.loaderOptions,
    babelOptions,
    extension,
    sourceMap: wywNext.loaderOptions?.sourceMap ?? nextOptions.dev,
  } satisfies WywWebpackLoaderOptions;

  const wywLoaderItem: RuleSetUseItem = {
    loader,
    options: loaderOptions,
  };

  traverseRules(config.module?.rules ?? [], (rule) => {
    convertLoaderRuleToUseRule(rule, wywLoaderItem);

    const use = normalizeUseItems(rule.use);
    if (!use) return;

    const loaders = use.map(getLoaderName);

    const alreadyInjected = loaders.some(
      (l) => l === loader || isWywLoaderPath(l)
    );
    if (alreadyInjected) return;

    const isNextJsTranspileRule = loaders.some((l) =>
      ['next-swc-loader', 'next-babel-loader', 'babel-loader'].some((needle) =>
        l.includes(needle)
      )
    );
    if (!isNextJsTranspileRule) return;

    // Loader order is right-to-left. We want WyW to run first, so it should be last.
    Object.assign(rule, { use: [...use, wywLoaderItem] });
  });

  ensureWywCssModuleRules(config, extension);
}

function ensureTurbopackCssPlaceholders(projectRoot: string) {
  const queue: string[] = [projectRoot];

  while (queue.length) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (entry.name !== '.' && entry.name !== '..') {
        const entryPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!PLACEHOLDER_IGNORED_DIRS.has(entry.name)) {
            queue.push(entryPath);
          }
        } else if (entry.isFile()) {
          const shouldIgnore =
            entry.name.startsWith('middleware.') ||
            entry.name.endsWith('.d.ts');

          if (!shouldIgnore) {
            const ext = path.extname(entry.name);
            if (PLACEHOLDER_EXTENSIONS.has(ext)) {
              const baseName = path.basename(entry.name, ext);
              const cssFilePath = path.join(
                path.dirname(entryPath),
                `${baseName}${DEFAULT_EXTENSION}`
              );

              try {
                fs.writeFileSync(cssFilePath, '', { flag: 'wx' });
              } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
                  throw err;
                }
              }
            }
          }
        }
      }
    }
  }
}

function shouldUseTurbopackConfig(nextConfig: NextConfig) {
  const explicit = (nextConfig as unknown as Record<string, unknown>).turbopack;
  if (typeof explicit !== 'undefined') {
    return true;
  }

  try {
    const pkgPath = require.resolve('next/package.json', {
      paths: [process.cwd()],
    });
    const pkg = require(pkgPath) as { version?: unknown };
    const version = typeof pkg.version === 'string' ? pkg.version : '';
    const major = Number.parseInt(version.split('.')[0] ?? '', 10);
    return Number.isFinite(major) && major >= 16;
  } catch {
    return false;
  }
}

function injectWywTurbopackRules(
  nextConfig: NextConfig,
  wywNext: WywNextPluginOptions
): NextConfig {
  const loader = require.resolve('@wyw-in-js/turbopack-loader');
  const nextBabelPreset = require.resolve('next/babel', {
    paths: [process.cwd()],
  });

  const userOptions = wywNext.turbopackLoaderOptions ?? {};

  assertNoFunctions(userOptions, 'turbopackLoaderOptions');

  const loaderOptions = {
    babelOptions: { presets: [nextBabelPreset] },
    sourceMap: process.env.NODE_ENV !== 'production',
    ...userOptions,
  };

  const useTurbopackConfig = shouldUseTurbopackConfig(nextConfig);

  const isNextBuild = process.argv.includes('build');
  const isWebpackBuild = process.argv.includes('--webpack');

  if (
    useTurbopackConfig &&
    process.env.NODE_ENV === 'production' &&
    isNextBuild &&
    !isWebpackBuild
  ) {
    ensureTurbopackCssPlaceholders(process.cwd());
  }

  const ruleValue = useTurbopackConfig
    ? {
        loaders: [{ loader, options: loaderOptions }],
        condition: {
          all: [
            { not: 'foreign' },
            { not: { path: /(?:^|[\\/])middleware\.[jt]sx?$/ } },
          ],
        },
      }
    : [{ loader, options: loaderOptions }];

  const wywRules = Object.fromEntries(
    DEFAULT_TURBO_RULE_KEYS.map((key) => [key, ruleValue])
  );

  if (useTurbopackConfig) {
    const turbopackConfig = (nextConfig as unknown as Record<string, unknown>)
      .turbopack;
    const userTurbopack = isPlainObject(turbopackConfig) ? turbopackConfig : {};

    const userRules = isPlainObject(userTurbopack.rules)
      ? (userTurbopack.rules as Record<string, unknown>)
      : {};

    return {
      ...nextConfig,
      turbopack: {
        ...userTurbopack,
        rules: {
          ...wywRules,
          ...userRules,
        },
      },
    } as NextConfig;
  }

  const userExperimental = isPlainObject(nextConfig.experimental)
    ? (nextConfig.experimental as Record<string, unknown>)
    : {};

  const userTurbo = isPlainObject(userExperimental.turbo)
    ? (userExperimental.turbo as Record<string, unknown>)
    : {};

  const userRules = isPlainObject(userTurbo.rules)
    ? (userTurbo.rules as Record<string, unknown>)
    : {};

  return {
    ...nextConfig,
    experimental: {
      ...userExperimental,
      turbo: {
        ...userTurbo,
        rules: {
          ...wywRules,
          ...userRules,
        },
      },
    },
  } as NextConfig;
}

export function withWyw(
  nextConfig: NextConfig = {},
  wywNext: WywNextPluginOptions = {}
): NextConfig {
  const userWebpack = nextConfig.webpack;

  return {
    ...injectWywTurbopackRules(nextConfig, wywNext),
    webpack(config: Configuration, options: NextWebpackOptions) {
      const resolvedConfig =
        typeof userWebpack === 'function'
          ? userWebpack(config, options)
          : config;

      injectWywLoader(resolvedConfig, options, wywNext);

      return resolvedConfig;
    },
  };
}
