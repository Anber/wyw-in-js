import { cosmiconfigSync } from 'cosmiconfig';

import type { FeatureFlags, StrictOptions } from '@wyw-in-js/shared';

import { shaker } from '../../shaker';
import type { PluginOptions } from '../../types';

const searchPlaces = [
  `.wyw-in-jsrc`,
  `.wyw-in-jsrc.json`,
  `.wyw-in-jsrc.yaml`,
  `.wyw-in-jsrc.yml`,
  `.wyw-in-jsrc.js`,
  `.wyw-in-jsrc.cjs`,
  `.config/wyw-in-jsrc`,
  `.config/wyw-in-jsrc.json`,
  `.config/wyw-in-jsrc.yaml`,
  `.config/wyw-in-jsrc.yml`,
  `.config/wyw-in-jsrc.js`,
  `.config/wyw-in-jsrc.cjs`,
  `wyw-in-js.config.js`,
  `wyw-in-js.config.cjs`,
];

const explorerSync = cosmiconfigSync('wyw-in-js', { searchPlaces });

export type PartialOptions = Partial<Omit<PluginOptions, 'features'>> & {
  features?: Partial<FeatureFlags>;
};

const cache = new WeakMap<Partial<PartialOptions>, StrictOptions>();
const defaultOverrides = {};
const nodeModulesRegExp = /[\\/]node_modules[\\/]/;

export function loadWywOptions(
  overrides: PartialOptions = defaultOverrides
): StrictOptions {
  if (cache.has(overrides)) {
    return cache.get(overrides)!;
  }

  const { configFile, ignore, rules, babelOptions = {}, ...rest } = overrides;

  const result =
    // eslint-disable-next-line no-nested-ternary
    configFile === false
      ? undefined
      : configFile !== undefined
      ? explorerSync.load(configFile)
      : explorerSync.search();

  const defaultFeatures: FeatureFlags = {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
  };

  const options: StrictOptions = {
    displayName: false,
    evaluate: true,
    extensions: ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
    rules: rules ?? [
      {
        action: shaker,
      },
      {
        // The old `ignore` option is used as a default value for `ignore` rule.
        test: ignore ?? nodeModulesRegExp,
        action: 'ignore',
      },
      {
        // Do not ignore ES-modules
        test: (filename, code) => {
          if (!nodeModulesRegExp.test(filename)) {
            return false;
          }

          // If a file contains `export` or `import` keywords, we assume it's an ES-module
          return /(?:^|\*\/|;|})\s*(?:export|import)[\s{]/m.test(code);
        },
        action: shaker,
      },
    ],
    babelOptions,
    highPriorityPlugins: ['module-resolver'],
    ...(result ? result.config : {}),
    ...rest,
    features: {
      ...defaultFeatures,
      ...(result ? result.config.features : {}),
      ...rest.features,
    },
  };

  cache.set(overrides, options);

  return options;
}
