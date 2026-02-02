import { cosmiconfigSync } from 'cosmiconfig';

import type {
  EvalOptionsV2,
  FeatureFlags,
  ImportLoaders,
  StrictOptions,
} from '@wyw-in-js/shared';

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
const defaultImportLoaders: ImportLoaders = {
  raw: 'raw',
  url: 'url',
};

export function loadWywOptions(
  overrides: PartialOptions = defaultOverrides
): StrictOptions {
  if (cache.has(overrides)) {
    return cache.get(overrides)!;
  }

  const {
    configFile,
    ignore,
    rules,
    babelOptions = {},
    importLoaders: overridesImportLoaders,
    ...rest
  } = overrides;

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
    useWeakRefInEval: true,
  };
  const defaultEval: EvalOptionsV2 = {
    mode: 'strict',
    require: 'warn-and-run',
    resolver: 'bundler',
  };

  const config = (result?.config ?? {}) as Partial<StrictOptions>;
  const configImportLoaders = config.importLoaders;
  const configFeatures = config.features;
  const configEval = config.eval;

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
    ...config,
    ...rest,
    eval: {
      ...defaultEval,
      ...(configEval ?? {}),
      ...(rest.eval ?? {}),
    },
    importLoaders: {
      ...defaultImportLoaders,
      ...(configImportLoaders ?? {}),
      ...(overridesImportLoaders ?? {}),
    },
    features: {
      ...defaultFeatures,
      ...(configFeatures ?? {}),
      ...rest.features,
    },
  };

  cache.set(overrides, options);

  return options;
}
