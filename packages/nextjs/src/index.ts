import type { LoaderOptions as WywWebpackLoaderOptions } from '@wyw-in-js/webpack-loader';
import type { NextConfig } from 'next';
import type { Configuration, RuleSetRule, RuleSetUseItem } from 'webpack';

const DEFAULT_EXTENSION = '.wyw-in-js.module.css';

export type WywNextPluginOptions = {
  loaderOptions?: Omit<WywWebpackLoaderOptions, 'extension' | 'sourceMap'> &
    Partial<Pick<WywWebpackLoaderOptions, 'extension' | 'sourceMap'>>;
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
  const nextBabelPreset = require.resolve('next/babel');

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

export function withWyw(
  nextConfig: NextConfig = {},
  wywNext: WywNextPluginOptions = {}
): NextConfig {
  const userWebpack = nextConfig.webpack;

  return {
    ...nextConfig,
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
