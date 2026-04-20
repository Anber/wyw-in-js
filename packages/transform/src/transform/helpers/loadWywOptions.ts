import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';

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
  `.wyw-in-jsrc.mjs`,
  `.wyw-in-jsrc.js`,
  `.wyw-in-jsrc.cjs`,
  `.config/wyw-in-jsrc`,
  `.config/wyw-in-jsrc.json`,
  `.config/wyw-in-jsrc.yaml`,
  `.config/wyw-in-jsrc.yml`,
  `.config/wyw-in-jsrc.mjs`,
  `.config/wyw-in-jsrc.js`,
  `.config/wyw-in-jsrc.cjs`,
  `wyw-in-js.config.mjs`,
  `wyw-in-js.config.js`,
  `wyw-in-js.config.cjs`,
];

const explorerSync = cosmiconfigSync('wyw-in-js', {
  searchPlaces: searchPlaces.filter(
    (searchPlace) => !searchPlace.endsWith('.mjs')
  ),
});

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
const resolveConfigFilePath = (configFile: string): string =>
  path.isAbsolute(configFile)
    ? configFile
    : path.resolve(process.cwd(), configFile);

const normalizeLoadedConfig = (loadedConfig: unknown): Partial<StrictOptions> =>
  (loadedConfig && typeof loadedConfig === 'object' && 'default' in loadedConfig
    ? (loadedConfig as { default: unknown }).default
    : loadedConfig) as Partial<StrictOptions>;

const loadMjsConfig = (configFile: string): Partial<StrictOptions> => {
  const resolvedConfigFile = resolveConfigFilePath(configFile);
  const configRequire = createRequire(resolvedConfigFile);

  try {
    const cacheKey = configRequire.resolve(resolvedConfigFile);
    delete configRequire.cache[cacheKey];
  } catch {
    // Ignore cache cleanup failures and let the require call surface the real error.
  }

  return normalizeLoadedConfig(configRequire(resolvedConfigFile));
};

const loadConfigFromFile = (configFile: string): Partial<StrictOptions> => {
  const resolvedConfigFile = resolveConfigFilePath(configFile);
  if (path.extname(resolvedConfigFile) === '.mjs') {
    return loadMjsConfig(resolvedConfigFile);
  }

  return (explorerSync.load(resolvedConfigFile)?.config ??
    {}) as Partial<StrictOptions>;
};

const searchConfig = (): Partial<StrictOptions> => {
  let currentDir: string | null = process.cwd();

  while (currentDir) {
    for (const searchPlace of searchPlaces) {
      const candidate = path.join(currentDir, searchPlace);
      if (existsSync(candidate)) {
        return loadConfigFromFile(candidate);
      }
    }

    const parentDir = path.dirname(currentDir);
    currentDir = parentDir === currentDir ? null : parentDir;
  }

  return {};
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

  const config = (() => {
    if (configFile === false) {
      return {};
    }

    if (configFile !== undefined) {
      return loadConfigFromFile(configFile);
    }

    return searchConfig();
  })();
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
