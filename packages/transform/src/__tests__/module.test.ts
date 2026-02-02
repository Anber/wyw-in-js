import fs from 'fs';
import os from 'os';
import path from 'path';

import * as babel from '@babel/core';
import dedent from 'dedent';

import type { StrictOptions } from '@wyw-in-js/shared';
import { logger } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { DefaultModuleImplementation, Module } from '../module';
import { Entrypoint } from '../transform/Entrypoint';
import type { LoadAndParseFn } from '../transform/Entrypoint.types';
import { isUnprocessedEntrypointError } from '../transform/actions/UnprocessedEntrypointError';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const options: StrictOptions = {
  babelOptions: {},
  displayName: false,
  evaluate: true,
  extensions: ['.cjs', '.js', '.jsx', '.ts', '.tsx'],
  features: {
    dangerousCodeRemover: true,
    globalCache: true,
    happyDOM: true,
    softErrors: false,
    useBabelConfigs: true,
    useWeakRefInEval: true,
  },
  highPriorityPlugins: [],
  overrideContext: (context) => ({
    ...context,
    HighLevelAPI: () => "I'm a high level API",
  }),
  rules: [],
};

const filename = path.resolve(__dirname, './__fixtures__/test.js');

const createServices = (partial: Partial<Services>): Services => {
  const loadAndParseFn: LoadAndParseFn = (services, name, loadedCode) => ({
    get ast() {
      return services.babel.parseSync(loadedCode ?? '', { filename: name })!;
    },
    code: loadedCode!,
    evaluator: jest.fn(),
    evalConfig: {},
  });

  return {
    babel,
    cache: new TransformCacheCollection(),
    emitWarning: jest.fn(),
    loadAndParseFn,
    log: logger,
    eventEmitter: EventEmitter.dummy,
    options: {
      filename,
      pluginOptions: { ...options },
    },
    ...partial,
  };
};

const createEntrypoint = (
  services: Services,
  name: string,
  only: string[],
  code: string
) => {
  const entrypoint = Entrypoint.createRoot(services, name, only, code);

  if (entrypoint.ignored) {
    throw new Error('entrypoint was ignored');
  }

  entrypoint.setTransformResult({
    code,
    metadata: null,
  });

  return entrypoint;
};

const create = (strings: TemplateStringsArray, ...expressions: unknown[]) => {
  const code = dedent(strings, ...expressions);
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);
  const mod = new Module(services, entrypoint);

  return {
    entrypoint,
    mod,
    services,
  };
};

async function safeEvaluate(m: Module): Promise<void> {
  try {
    return await m.evaluate();
  } catch (e) {
    if (isUnprocessedEntrypointError(e)) {
      e.entrypoint.setTransformResult({
        code: e.entrypoint.loadedAndParsed.code ?? '',
        metadata: null,
      });

      const { services } = m as unknown as { services: Services };
      const { moduleImpl } = m as unknown as { moduleImpl: unknown };
      const { entrypoint: rootEntrypoint } = m as unknown as {
        entrypoint: Entrypoint;
      };

      const nextModule = new Module(
        services,
        rootEntrypoint,
        undefined,
        moduleImpl as any
      );

      return safeEvaluate(nextModule);
    }

    throw e;
  }
}

function safeRequire(m: Module, id: string): unknown {
  try {
    return m.require(id);
  } catch (e) {
    if (isUnprocessedEntrypointError(e)) {
      e.entrypoint.setTransformResult({
        code: e.entrypoint.loadedAndParsed.code ?? '',
        metadata: null,
      });

      return safeRequire(m, id);
    }

    throw e;
  }
}

it('creates module for JS files', async () => {
  const { mod } = create`
    module.exports = () => 42;
  `;

  await safeEvaluate(mod);

  expect((mod.exports as any)()).toBe(42);
  expect(mod.id).toBe(filename);
  expect(mod.filename).toBe(filename);
});

it('requires .js files', async () => {
  const { mod } = create`
    const answer = require('./sample-script');

    module.exports = 'The answer is ' + answer;
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe('The answer is 42');
});

it('requires .cjs files', async () => {
  const { mod } = create`
    const answer = require('./sample-script.cjs');

    module.exports = 'The answer is ' + answer;
  `;
  await safeEvaluate(mod);

  expect(mod.exports).toBe('The answer is 42');
});

it('prefers .js when extensionless import resolves to .cjs and .js exists', async () => {
  const code = dedent`
    module.exports = require('./prefer-js');
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((id: string) => {
    if (id === './prefer-js') {
      return path.resolve(__dirname, './__fixtures__/prefer-js.cjs');
    }

    return id;
  });

  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  await safeEvaluate(mod);

  expect(mod.exports).toBe('js');
  expect(resolveFilename).toHaveBeenCalledWith(
    './prefer-js',
    expect.anything()
  );
});

it('does not rewrite bare imports when extensionless import resolves to .cjs and .js exists', async () => {
  const code = dedent`
    module.exports = require('prefer-js');
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((id: string) => {
    if (id === 'prefer-js') {
      return path.resolve(__dirname, './__fixtures__/prefer-js.cjs');
    }

    return id;
  });

  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  await safeEvaluate(mod);

  expect(mod.exports).toBe('cjs');
  expect(resolveFilename).toHaveBeenCalledWith('prefer-js', expect.anything());
});

it('requires .json files', async () => {
  const { mod } = create`
    const data = require('./sample-data.json');

    module.exports = 'Our saviour, ' + data.name;
  `;
  await safeEvaluate(mod);

  expect(mod.exports).toBe('Our saviour, Luke Skywalker');
});

it('supports "?raw" imports during eval', async () => {
  const { entrypoint, mod } = create`
    module.exports = require('./sample-asset.txt?raw');
  `;

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?raw',
  });

  await safeEvaluate(mod);

  // Git checkout on Windows may convert text files to CRLF.
  expect(String(mod.exports).replace(/\r\n/g, '\n')).toBe('Hello from asset\n');
});

it('supports "?url" imports during eval', async () => {
  const { entrypoint, mod } = create`
    module.exports = require('./sample-asset.txt?url');
  `;

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?url',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toBe('./sample-asset.txt');
});

it('allows custom query loaders via pluginOptions.importLoaders', async () => {
  const { entrypoint, mod, services } = create`
    module.exports = require('./sample-asset.txt?svgUse');
  `;

  services.options.pluginOptions.importLoaders = {
    svgUse: (ctx) => ({ ok: true, url: ctx.toUrl() }),
  };

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?svgUse',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toEqual({ ok: true, url: './sample-asset.txt' });
});

it('returns module from the cache', () => {
  const { entrypoint, mod, services } = create``;

  const id = './sample-data.json';

  expect(safeRequire(mod, id)).toBe(safeRequire(mod, id));

  const res1 = safeRequire(new Module(services, entrypoint), id);
  const res2 = safeRequire(new Module(services, entrypoint), id);

  expect(res1).toBe(res2);
});

it('should use cached version from the codeCache', async () => {
  const { entrypoint, mod } = create`
    import { margin } from './objectExport';

    module.exports = 'Imported value is ' + margin;
  `;

  const resolved = require.resolve('./__fixtures__/objectExport.js');
  entrypoint.addDependency({
    only: ['margin'],
    resolved,
    source: './objectExport',
  });

  entrypoint.createChild(
    resolved,
    ['margin'],
    dedent`
      export const margin = 1;
    `
  );

  await safeEvaluate(mod);

  expect(mod.exports).toBe('Imported value is 1');
});

it('should reread module from disk when it is in codeCache but not in resolveCache', async () => {
  // This may happen when the current importer was not processed, but required
  // module was already required by another module, and its code was cached.
  // In this case, we should not use the cached code, but reread the file.

  const { entrypoint, mod } = create`
    const margin = require('./objectExport').margin;

    module.exports = 'Imported value is ' + margin;
  `;

  const resolved = require.resolve('./__fixtures__/objectExport.js');
  entrypoint.createChild(
    resolved,
    ['margin'],
    dedent`
    module.exports = { margin: 1 };
  `
  );

  await safeEvaluate(mod);

  expect(mod.exports).toBe('Imported value is 5');
});

it('clears modules from the cache', () => {
  const id = './sample-data.json';

  const { entrypoint, mod, services } = create``;
  const result = safeRequire(mod, id);

  expect(safeRequire(new Module(services, entrypoint), id)).toBe(result);

  const dep = new Module(services, entrypoint).resolve(id);
  services.cache.invalidateForFile(dep);

  expect(safeRequire(new Module(services, entrypoint), id)).not.toBe(result);
});

it('exports the path for non JS/JSON files', () => {
  const { mod } = create``;

  expect(mod.require('./sample-asset.png')).toBe(
    path.join(__dirname, '__fixtures__', 'sample-asset.png')
  );
});

it('returns module when requiring mocked builtin node modules', () => {
  const { mod } = create``;

  expect(mod.require('path')).toBe(require('path'));
});

it('returns null when requiring empty builtin node modules', () => {
  const { mod } = create``;

  expect(mod.require('fs')).toBe(null);
});

it('returns refresh runtime stub for Vite virtual module', () => {
  const { mod } = create``;

  const runtime = safeRequire(mod, '/@react-refresh') as {
    createSignatureFunctionForTransform: () => () => void;
  };

  expect(typeof runtime.createSignatureFunctionForTransform).toBe('function');
  expect(typeof runtime.createSignatureFunctionForTransform()).toBe('function');
});

it('returns empty object for other Vite virtual modules', () => {
  const { mod } = create``;

  expect(safeRequire(mod, '/@virtual-dep')).toEqual({});
});

it('throws when requiring unmocked builtin node modules', () => {
  const { mod } = create``;

  expect(() => mod.require('perf_hooks')).toThrow(
    'Unable to import "perf_hooks". Importing Node builtins is not supported in the sandbox.'
  );
});

it('has access to the global object', async () => {
  const { mod } = create`
    new global.Set();
  `;

  await expect(mod.evaluate()).resolves.toBeUndefined();
});

it('has access to Object prototype methods on `exports`', async () => {
  const { mod } = create`
    exports.hasOwnProperty('keyss');
  `;

  await expect(mod.evaluate()).resolves.toBeUndefined();
});

it("doesn't have access to the process object", async () => {
  const { mod } = create`
    module.exports = process.abort();
  `;

  await expect(mod.evaluate()).rejects.toThrow(
    'process.abort is not a function'
  );
});

it('adds a hint when eval fails due to browser-only globals', async () => {
  const code = dedent`
    module.exports = window.location.href;
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({
    cache,
    options: {
      filename,
      pluginOptions: {
        ...options,
        features: {
          ...options.features,
          happyDOM: false,
        },
      },
    },
  });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);
  const mod = new Module(services, entrypoint);

  await expect(mod.evaluate()).rejects.toThrow(EvalError);

  try {
    await mod.evaluate();
  } catch (e) {
    expect((e as Error).message).toContain('[wyw-in-js] Evaluation hint:');
    expect((e as Error).message).toContain('importOverrides');
  }
});

it('has access to a overridden context', async () => {
  const { mod } = create`
    module.exports = HighLevelAPI();
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe("I'm a high level API");
});

it('has access to NODE_ENV', async () => {
  const { mod } = create`
    module.exports = process.env.NODE_ENV;
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe(process.env.NODE_ENV);
});

it('has require.resolve available', async () => {
  const { mod } = create`
    module.exports = require.resolve('./sample-script');
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe(
    path.resolve(path.dirname(mod.filename), 'sample-script.js')
  );
});

it('has require.ensure available', async () => {
  const { mod } = create`
    require.ensure(['./sample-script']);
  `;

  await expect(mod.evaluate()).resolves.toBeUndefined();
});

it('changes resolve behaviour on overriding _resolveFilename', async () => {
  const code = dedent`
    module.exports = [
      require.resolve('foo'),
      require.resolve('test'),
    ];
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((id: string) => (id === 'foo' ? 'bar' : id));
  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  await safeEvaluate(mod);

  expect(mod.exports).toEqual(['bar', 'test']);
  expect(resolveFilename).toHaveBeenCalledTimes(2);
});

it('should resolve from the cache', async () => {
  const code = dedent`
    module.exports = [
      require.resolve('foo'),
      require.resolve('test'),
    ];
  `;
  const cache = new TransformCacheCollection();
  const services = createServices({ cache });
  const entrypoint = createEntrypoint(services, filename, ['*'], code);

  const resolveFilename = jest.fn((...args: unknown[]) =>
    DefaultModuleImplementation._resolveFilename.call(
      DefaultModuleImplementation as any,
      ...args
    )
  );
  const moduleImpl = {
    _extensions: DefaultModuleImplementation._extensions,
    _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
      DefaultModuleImplementation
    ),
    _resolveFilename: resolveFilename as any,
  };

  const mod = new Module(services, entrypoint, undefined, moduleImpl as any);

  entrypoint.addDependency({
    only: ['*'],
    resolved: 'resolved foo',
    source: 'foo',
  });
  entrypoint.addDependency({
    only: ['*'],
    resolved: 'resolved test',
    source: 'test',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toEqual(['resolved foo', 'resolved test']);
  expect(resolveFilename).toHaveBeenCalledTimes(0);
});

it('correctly processes export declarations in strict mode', async () => {
  const { mod } = create`
    "use strict";
    exports = module.exports = () => 42
  `;

  await safeEvaluate(mod);

  expect((mod.exports as any)()).toBe(42);
  expect(mod.id).toBe(filename);
  expect(mod.filename).toBe(filename);
});

it('export * compiled by typescript to commonjs works', async () => {
  const { mod } = create`
    const { foo } = require('./ts-compiled-re-exports');

    module.exports = foo;
  `;

  await safeEvaluate(mod);

  expect(mod.exports).toBe('foo');
});

it('does not warn when dependency is resolved during prepare stage', async () => {
  const { entrypoint, mod, services } = create`
    module.exports = require('./sample-script');
  `;

  services.options.root = path.dirname(filename);

  entrypoint.addDependency({
    only: ['*'],
    resolved: require.resolve('./__fixtures__/sample-script.js'),
    source: './sample-script',
  });

  await safeEvaluate(mod);

  expect(mod.exports).toBe(42);
  expect(services.emitWarning as jest.Mock).not.toHaveBeenCalled();
});

it('warns only on eval-time fallback and dedupes by canonical key', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);

  safeRequire(mod, './sample-script');
  safeRequire(mod, './sample-script');

  expect(services.emitWarning as jest.Mock).toHaveBeenCalledTimes(1);
  expect((services.emitWarning as jest.Mock).mock.calls[0][0]).toContain(
    'config key: ./sample-script.js'
  );
});

it('supports importOverrides.unknown=error for eval-time fallback', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);
  services.options.pluginOptions.importOverrides = {
    './sample-script.js': {
      unknown: 'error',
    },
  };

  expect(() => safeRequire(mod, './sample-script')).toThrow(
    'Unknown import reached during eval'
  );
});

it('supports glob patterns in importOverrides for eval-time fallback', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);
  services.options.pluginOptions.importOverrides = {
    './sample-*.js': {
      unknown: 'error',
    },
  };

  expect(() => safeRequire(mod, './sample-script')).toThrow(
    'Unknown import reached during eval'
  );
});

it('supports importOverrides.mock for eval-time fallback', () => {
  const { mod, services } = create``;

  services.options.root = path.dirname(filename);
  services.options.pluginOptions.importOverrides = {
    './sample-script.js': {
      mock: './objectExport.js',
    },
  };

  expect(safeRequire(mod, './sample-script')).toEqual({ margin: 5 });
  expect(services.emitWarning as jest.Mock).not.toHaveBeenCalled();
});

describe('ESM resolver order', () => {
  it('prefers custom resolver over bundler dependencies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-custom-'));
    const entryFile = path.join(root, 'entry.js');
    const bundlerFile = path.join(root, 'bundler.js');
    const customFile = path.join(root, 'custom.js');

    fs.writeFileSync(bundlerFile, `export default 'bundler';`);
    fs.writeFileSync(customFile, `export default 'custom';`);

    const code = dedent`
      import value from 'dep';
      export const result = value;
    `;

    const customResolver = jest.fn(async (specifier: string) => {
      if (specifier === 'dep') {
        return { id: customFile };
      }

      return null;
    });

    const customLoader = jest.fn(async (id: string) => {
      if (id === customFile) {
        return { code: fs.readFileSync(customFile, 'utf8') };
      }

      return null;
    });

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: {
          ...options,
          eval: {
            customResolver,
            customLoader,
          },
        },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    entrypoint.addDependency({
      source: 'dep',
      resolved: bundlerFile,
      only: ['*'],
    });

    const mod = new Module(services, entrypoint);
    await safeEvaluate(mod);

    expect(entrypoint.exports.result).toBe('custom');
    expect(customResolver).toHaveBeenCalledWith('dep', entryFile, 'import');
  });

  it('falls back to bundler before node resolver', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-bundler-'));
    const entryFile = path.join(root, 'entry.js');
    const bundlerFile = path.join(root, 'bundler.js');

    fs.writeFileSync(bundlerFile, `export default 'bundler';`);

    const code = dedent`
      import value from 'dep';
      export const result = value;
    `;

    const customResolver = jest.fn(async () => null);

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: {
          ...options,
          eval: {
            customResolver,
          },
        },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    entrypoint.addDependency({
      source: 'dep',
      resolved: bundlerFile,
      only: ['*'],
    });

    const mod = new Module(services, entrypoint);
    const fallbackSpy = jest.spyOn(mod, 'resolveWithNodeFallback');

    await safeEvaluate(mod);

    expect(entrypoint.exports.result).toBe('bundler');
    expect(customResolver).toHaveBeenCalledWith('dep', entryFile, 'import');
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('uses node resolver when bundler data is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-node-'));
    const entryFile = path.join(root, 'entry.js');
    const nodeFile = path.join(root, 'node.js');

    fs.writeFileSync(nodeFile, `export default 'node';`);

    const code = dedent`
      import value from 'dep';
      export const result = value;
    `;

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: {
          ...options,
          eval: {
            customResolver: async () => null,
          },
        },
      },
    });

    const moduleImpl = {
      _extensions: DefaultModuleImplementation._extensions,
      _nodeModulePaths: DefaultModuleImplementation._nodeModulePaths.bind(
        DefaultModuleImplementation
      ),
      _resolveFilename: jest.fn((id: string) => {
        if (id === 'dep') {
          return nodeFile;
        }

        return id;
      }),
    };

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    const mod = new Module(services, entrypoint, undefined, moduleImpl as any);
    const fallbackSpy = jest.spyOn(mod, 'resolveWithNodeFallback');

    await safeEvaluate(mod);

    expect(entrypoint.exports.result).toBe('node');
    expect(fallbackSpy).toHaveBeenCalled();
  });
});

describe('ESM specifiers', () => {
  it('handles query IDs via import loaders', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esm-query-'));
    const entryFile = path.join(root, 'entry.js');
    const assetFile = path.join(root, 'asset.txt');

    fs.writeFileSync(assetFile, 'raw-content');

    const code = dedent`
      import asset from './asset.txt?raw';
      export const value = asset;
    `;

    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename: entryFile,
        pluginOptions: { ...options },
      },
    });

    const entrypoint = createEntrypoint(services, entryFile, ['*'], code);
    entrypoint.addDependency({
      source: './asset.txt?raw',
      resolved: `${assetFile}?raw`,
      only: ['*'],
    });

    const mod = new Module(services, entrypoint);
    await safeEvaluate(mod);

    expect(entrypoint.exports.value).toBe('raw-content');
  });

  it('handles Vite virtual IDs during linking', async () => {
    const { mod, entrypoint } = create`
      import { createSignatureFunctionForTransform } from '/@react-refresh';

      export const ok = typeof createSignatureFunctionForTransform === 'function';
    `;

    await safeEvaluate(mod);

    expect(entrypoint.exports.ok).toBe(true);
  });
});

describe('ESM evaluation determinism', () => {
  it('does not re-evaluate when called twice', async () => {
    const counter = { value: 0 };
    const cache = new TransformCacheCollection();
    const services = createServices({
      cache,
      options: {
        filename,
        pluginOptions: {
          ...options,
          overrideContext: (context) => ({
            ...context,
            counter,
          }),
        },
      },
    });

    const entrypoint = createEntrypoint(
      services,
      filename,
      ['*'],
      dedent`
        counter.value += 1;
        export const value = counter.value;
      `
    );

    const mod = new Module(services, entrypoint);

    await mod.evaluate();
    expect(entrypoint.exports.value).toBe(1);

    await mod.evaluate();
    expect(entrypoint.exports.value).toBe(1);
    expect(counter.value).toBe(1);
  });
});

describe('globals', () => {
  it.each([{ name: 'Timeout' }, { name: 'Interval' }, { name: 'Immediate' }])(
    `has set$name, clear$name available`,
    async (i) => {
      const { mod } = create`
        const x = set${i.name}(() => {
          console.log('test');
        },0);

        clear${i.name}(x);
      `;

      await expect(mod.evaluate()).resolves.toBeUndefined();
    }
  );

  it('has global objects available without referencing global', async () => {
    const { mod } = create`
      const x = new Set();
    `;

    await expect(mod.evaluate()).resolves.toBeUndefined();
  });
});

describe('definable globals', () => {
  it('has __filename available', async () => {
    const { mod } = create`
      module.exports = __filename;
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toBe(mod.filename);
  });

  it('has __dirname available', async () => {
    const { mod } = create`
      module.exports = __dirname;
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toBe(path.dirname(mod.filename));
  });
});

describe('DOM', () => {
  it('should have DOM globals available', async () => {
    const { mod } = create`
      module.exports = {
        document: typeof document,
        window: typeof window,
        global: typeof global,
      };
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toEqual({
      document: 'object',
      window: 'object',
      global: 'object',
    });
  });

  it('should have DOM APIs available', async () => {
    const { mod } = create`
      const handler = () => {}

      document.addEventListener('click', handler);
      document.removeEventListener('click', handler);

    window.addEventListener('click', handler);
    window.removeEventListener('click', handler);
  `;

    await expect(mod.evaluate()).resolves.toBeUndefined();
  });

  it('supports DOM manipulations', async () => {
    const { mod } = create`
      const el = document.createElement('div');
      el.setAttribute('id', 'test');

      document.body.appendChild(el);

      module.exports = {
        html: document.body.innerHTML,
        tagName: el.tagName.toLowerCase()
      };
    `;

    await safeEvaluate(mod);

    expect(mod.exports).toEqual({
      html: '<div id="test"></div>',
      tagName: 'div',
    });
  });
});
