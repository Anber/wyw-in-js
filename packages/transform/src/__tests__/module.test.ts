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
      return services.babel.parseSync(loadedCode ?? '')!;
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

function safeEvaluate(m: Module): void {
  try {
    return m.evaluate();
  } catch (e) {
    if (isUnprocessedEntrypointError(e)) {
      e.entrypoint.setTransformResult({
        code: e.entrypoint.loadedAndParsed.code ?? '',
        metadata: null,
      });

      return safeEvaluate(m);
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

it('creates module for JS files', () => {
  const { mod } = create`
    module.exports = () => 42;
  `;

  safeEvaluate(mod);

  expect((mod.exports as any)()).toBe(42);
  expect(mod.id).toBe(filename);
  expect(mod.filename).toBe(filename);
});

it('requires .js files', () => {
  const { mod } = create`
    const answer = require('./sample-script');

    module.exports = 'The answer is ' + answer;
  `;

  safeEvaluate(mod);

  expect(mod.exports).toBe('The answer is 42');
});

it('requires .cjs files', () => {
  const { mod } = create`
    const answer = require('./sample-script.cjs');

    module.exports = 'The answer is ' + answer;
  `;
  safeEvaluate(mod);

  expect(mod.exports).toBe('The answer is 42');
});

it('prefers .js when extensionless import resolves to .cjs and .js exists', () => {
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

  safeEvaluate(mod);

  expect(mod.exports).toBe('js');
  expect(resolveFilename).toHaveBeenCalledWith(
    './prefer-js',
    expect.anything()
  );
});

it('does not rewrite bare imports when extensionless import resolves to .cjs and .js exists', () => {
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

  safeEvaluate(mod);

  expect(mod.exports).toBe('cjs');
  expect(resolveFilename).toHaveBeenCalledWith('prefer-js', expect.anything());
});

it('requires .json files', () => {
  const { mod } = create`
    const data = require('./sample-data.json');

    module.exports = 'Our saviour, ' + data.name;
  `;
  safeEvaluate(mod);

  expect(mod.exports).toBe('Our saviour, Luke Skywalker');
});

it('supports "?raw" imports during eval', () => {
  const { entrypoint, mod } = create`
    module.exports = require('./sample-asset.txt?raw');
  `;

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?raw',
  });

  safeEvaluate(mod);

  // Git checkout on Windows may convert text files to CRLF.
  expect(String(mod.exports).replace(/\r\n/g, '\n')).toBe('Hello from asset\n');
});

it('supports "?url" imports during eval', () => {
  const { entrypoint, mod } = create`
    module.exports = require('./sample-asset.txt?url');
  `;

  entrypoint.addDependency({
    only: ['*'],
    resolved: path.resolve(__dirname, './__fixtures__/sample-asset.txt'),
    source: './sample-asset.txt?url',
  });

  safeEvaluate(mod);

  expect(mod.exports).toBe('./sample-asset.txt');
});

it('allows custom query loaders via pluginOptions.importLoaders', () => {
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

  safeEvaluate(mod);

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

it('should use cached version from the codeCache', () => {
  const { entrypoint, mod } = create`
    const margin = require('./objectExport').margin;

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
      module.exports = { margin: 1 };
    `
  );

  safeEvaluate(mod);

  expect(mod.exports).toBe('Imported value is 1');
});

it('should reread module from disk when it is in codeCache but not in resolveCache', () => {
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

  safeEvaluate(mod);

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

it('has access to the global object', () => {
  const { mod } = create`
    new global.Set();
  `;

  expect(() => mod.evaluate()).not.toThrow();
});

it('has access to Object prototype methods on `exports`', () => {
  const { mod } = create`
    exports.hasOwnProperty('keyss');
  `;

  expect(() => mod.evaluate()).not.toThrow();
});

it("doesn't have access to the process object", () => {
  const { mod } = create`
    module.exports = process.abort();
  `;

  expect(() => mod.evaluate()).toThrow('process.abort is not a function');
});

it('has access to a overridden context', () => {
  const { mod } = create`
    module.exports = HighLevelAPI();
  `;

  safeEvaluate(mod);

  expect(mod.exports).toBe("I'm a high level API");
});

it('has access to NODE_ENV', () => {
  const { mod } = create`
    module.exports = process.env.NODE_ENV;
  `;

  safeEvaluate(mod);

  expect(mod.exports).toBe(process.env.NODE_ENV);
});

it('has require.resolve available', () => {
  const { mod } = create`
    module.exports = require.resolve('./sample-script');
  `;

  safeEvaluate(mod);

  expect(mod.exports).toBe(
    path.resolve(path.dirname(mod.filename), 'sample-script.js')
  );
});

it('has require.ensure available', () => {
  const { mod } = create`
    require.ensure(['./sample-script']);
  `;

  expect(() => mod.evaluate()).not.toThrow();
});

it('changes resolve behaviour on overriding _resolveFilename', () => {
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

  safeEvaluate(mod);

  expect(mod.exports).toEqual(['bar', 'test']);
  expect(resolveFilename).toHaveBeenCalledTimes(2);
});

it('should resolve from the cache', () => {
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

  safeEvaluate(mod);

  expect(mod.exports).toEqual(['resolved foo', 'resolved test']);
  expect(resolveFilename).toHaveBeenCalledTimes(0);
});

it('correctly processes export declarations in strict mode', () => {
  const { mod } = create`
    "use strict";
    exports = module.exports = () => 42
  `;

  safeEvaluate(mod);

  expect((mod.exports as any)()).toBe(42);
  expect(mod.id).toBe(filename);
  expect(mod.filename).toBe(filename);
});

it('export * compiled by typescript to commonjs works', () => {
  const { mod } = create`
    const { foo } = require('./ts-compiled-re-exports');

    module.exports = foo;
  `;

  safeEvaluate(mod);

  expect(mod.exports).toBe('foo');
});

it('does not warn when dependency is resolved during prepare stage', () => {
  const { entrypoint, mod, services } = create`
    module.exports = require('./sample-script');
  `;

  services.options.root = path.dirname(filename);

  entrypoint.addDependency({
    only: ['*'],
    resolved: require.resolve('./__fixtures__/sample-script.js'),
    source: './sample-script',
  });

  safeEvaluate(mod);

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

describe('globals', () => {
  it.each([{ name: 'Timeout' }, { name: 'Interval' }, { name: 'Immediate' }])(
    `has set$name, clear$name available`,
    (i) => {
      const { mod } = create`
        const x = set${i.name}(() => {
          console.log('test');
        },0);

        clear${i.name}(x);
      `;

      expect(() => mod.evaluate()).not.toThrow();
    }
  );

  it('has global objects available without referencing global', () => {
    const { mod } = create`
      const x = new Set();
    `;

    expect(() => mod.evaluate()).not.toThrow();
  });
});

describe('definable globals', () => {
  it('has __filename available', () => {
    const { mod } = create`
      module.exports = __filename;
    `;

    safeEvaluate(mod);

    expect(mod.exports).toBe(mod.filename);
  });

  it('has __dirname available', () => {
    const { mod } = create`
      module.exports = __dirname;
    `;

    safeEvaluate(mod);

    expect(mod.exports).toBe(path.dirname(mod.filename));
  });
});

describe('DOM', () => {
  it('should have DOM globals available', () => {
    const { mod } = create`
      module.exports = {
        document: typeof document,
        window: typeof window,
        global: typeof global,
      };
    `;

    safeEvaluate(mod);

    expect(mod.exports).toEqual({
      document: 'object',
      window: 'object',
      global: 'object',
    });
  });

  it('should have DOM APIs available', () => {
    const { mod } = create`
      const handler = () => {}

      document.addEventListener('click', handler);
      document.removeEventListener('click', handler);

      window.addEventListener('click', handler);
      window.removeEventListener('click', handler);
    `;

    expect(() => mod.evaluate()).not.toThrow();
  });

  it('supports DOM manipulations', () => {
    const { mod } = create`
      const el = document.createElement('div');
      el.setAttribute('id', 'test');

      document.body.appendChild(el);

      module.exports = {
        html: document.body.innerHTML,
        tagName: el.tagName.toLowerCase()
      };
    `;

    safeEvaluate(mod);

    expect(mod.exports).toEqual({
      html: '<div id="test"></div>',
      tagName: 'div',
    });
  });
});
