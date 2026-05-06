import * as babel from '@babel/core';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';

import {
  loadWywOptions,
  type PartialOptions,
} from '../transform/helpers/loadWywOptions';
import { shaker } from '../shaker';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import { Entrypoint } from '../transform/Entrypoint';
import {
  EvalBroker,
  stripEntrypointGlobalsFromRunnerContext,
} from '../eval/broker';
import { serializeValue } from '../eval/serialize';

const createPluginOptions = (overrides: PartialOptions = {}) =>
  loadWywOptions({
    configFile: false,
    rules: [
      {
        test: () => true,
        action: shaker,
      },
    ],
    babelOptions: {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { loose: true }],
        '@babel/preset-react',
        '@babel/preset-typescript',
      ],
    },
    ...overrides,
  });

const createServices = (
  root: string,
  filename: string,
  overrides: PartialOptions = {}
) => {
  const pluginOptions = createPluginOptions(overrides);
  return withDefaultServices({
    babel,
    options: {
      root,
      filename,
      pluginOptions,
    },
  });
};

const testCssProcessorFile = join(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const getPrivateBroker = (broker: EvalBroker) =>
  broker as unknown as {
    activeResolveRootId: string | null;
    currentServices: ReturnType<typeof createServices>;
    happyDomDisabled: boolean;
    importsByModule: Map<string, Map<string, string[]>>;
    lastHappyDomEnabled: boolean;
    lastInitKey: string | null;
    onlyByModule: Map<string, string[]>;
    ensureImportsMapping: (
      id: string,
      imports: Map<string, string[]> | null | undefined
    ) => void;
    ensureRunner: () => Promise<void>;
    handleRunnerStderr: (chunk: Buffer) => void;
    initIsolatedRunner: (
      payload: unknown,
      timeoutMs: number
    ) => Promise<unknown>;
    initRunner: (entrypoint: Entrypoint) => Promise<void>;
    loadModule: (payload: {
      id: string;
      importerId?: string | null;
      request?: string | null;
    }) => Promise<{
      code: string;
      imports: Map<string, string[]> | null;
      only: string[];
    }>;
    request: (
      type: 'INIT' | 'EVAL',
      payload: unknown,
      timeoutMs?: number
    ) => Promise<unknown>;
    resolveImport: (payload: {
      importerId: string;
      kind: 'import' | 'dynamic-import' | 'require';
      specifier: string;
    }) => Promise<{ resolvedId: string | null }>;
    runner: unknown;
  };

describe('EvalBroker', () => {
  it('strips default entrypoint globals from stable override context payloads', () => {
    const entry = '/tmp/example/entry.js';
    const globals = {
      IMPORT_META_ENV: { MODE: 'test' },
      __dirname: '/tmp/example',
      __filename: entry,
    };

    expect(stripEntrypointGlobalsFromRunnerContext(globals, entry)).toEqual({
      IMPORT_META_ENV: { MODE: 'test' },
    });
    expect(globals).toEqual({
      IMPORT_META_ENV: { MODE: 'test' },
      __dirname: '/tmp/example',
      __filename: entry,
    });
  });

  it('prefers custom resolver over bundler resolver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    writeFileSync(dep, 'export const value = 1;');

    const customResolver = jest.fn(async () => ({ id: dep }));
    const asyncResolve = jest.fn(async () => dep);
    const services = createServices(root, importer, {
      eval: { customResolver },
    });

    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(importer, new Map([['./dep.js', ['*']]]));

    const result = await privateBroker.resolveImport({
      specifier: './dep.js',
      importerId: importer,
      kind: 'import',
    });

    expect(customResolver).toHaveBeenCalledTimes(1);
    expect(asyncResolve).not.toHaveBeenCalled();
    expect(result.resolvedId).toBe(dep);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers native resolver over bundler resolver in hybrid mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const bundlerDep = join(root, 'bundler.js');
    const nativeDep = join(root, 'node_modules', 'dep', 'index.js');

    mkdirSync(dirname(nativeDep), { recursive: true });
    writeFileSync(importer, 'export const value = true;');
    writeFileSync(bundlerDep, 'export const value = "bundler";');
    writeFileSync(nativeDep, 'export const value = "native";');

    const asyncResolve = jest.fn(async () => bundlerDep);
    const services = createServices(root, importer, {
      eval: {
        resolver: 'hybrid',
      },
    });

    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(importer, new Map([['dep', ['*']]]));

    const result = await privateBroker.resolveImport({
      specifier: 'dep',
      importerId: importer,
      kind: 'import',
    });

    expect(realpathSync(result.resolvedId!)).toBe(realpathSync(nativeDep));
    expect(asyncResolve).not.toHaveBeenCalled();

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps active eval services while later evals wait in queue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const firstEntry = join(root, 'first.js');
    const secondEntry = join(root, 'second.js');
    writeFileSync(firstEntry, 'export const __wywPreval = {};');
    writeFileSync(secondEntry, 'export const __wywPreval = {};');

    const firstWarnings: string[] = [];
    const secondWarnings: string[] = [];
    const firstServices = createServices(root, firstEntry, {
      evalConsole: 'warning',
    });
    const secondServices = createServices(root, secondEntry, {
      evalConsole: 'warning',
    });
    firstServices.emitWarning = (message) => firstWarnings.push(message);
    secondServices.emitWarning = (message) => secondWarnings.push(message);

    const broker = new EvalBroker(
      firstServices,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.ensureRunner = jest.fn(async () => {});
    privateBroker.initRunner = jest.fn(async () => {});

    let resolveFirstEval: ((payload: { values: null }) => void) | null = null;
    let firstEvalStarted: (() => void) | null = null;
    const firstEvalStartedPromise = new Promise<void>((resolveStarted) => {
      firstEvalStarted = resolveStarted;
    });
    privateBroker.request = jest.fn((_type, payload) => {
      const { id } = payload as { id: string };
      if (id === firstEntry) {
        firstEvalStarted?.();
        return new Promise<{ values: null }>((resolveEval) => {
          resolveFirstEval = resolveEval;
        });
      }

      return Promise.resolve({ values: null });
    });

    const firstEntrypoint = Entrypoint.createRoot(
      firstServices,
      firstEntry,
      ['__wywPreval'],
      readFileSync(firstEntry, 'utf-8')
    );
    const secondEntrypoint = Entrypoint.createRoot(
      secondServices,
      secondEntry,
      ['__wywPreval'],
      readFileSync(secondEntry, 'utf-8')
    );

    const firstEval = broker.evaluate(firstEntrypoint, firstServices);
    await firstEvalStartedPromise;
    const secondEval = broker.evaluate(secondEntrypoint, secondServices);

    privateBroker.handleRunnerStderr(Buffer.from('active warning\n'));

    expect(firstWarnings).toEqual(['active warning']);
    expect(secondWarnings).toEqual([]);

    resolveFirstEval?.({ values: null });
    await firstEval;
    await secondEval;

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('loadModule merges importer-specific needs even when onlyByModule is narrow', async () => {
    // Simulates the intra-session race: onlyByModule has only one importer's
    // contribution, but the LOAD payload identifies a different importer whose
    // importsByModule map reveals additional needed exports. The fix in
    // loadModuleImpl merges these into requiredOnly so the prepared code
    // includes all exports the importer actually needs.
    //
    // The barrel must NOT be statically evaluatable (the broker overrides
    // simple modules to only:['*']). Using re-exports from sub-modules
    // makes it non-trivial, matching the real design-system barrel pattern.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const barrel = join(root, 'barrel.js');
    const typography = join(root, 'typography.js');
    const layout = join(root, 'layout.js');
    const consumerA = join(root, 'consumer-a.js');
    const consumerB = join(root, 'consumer-b.js');

    // Sub-modules with non-trivial logic to avoid static evaluation
    writeFileSync(
      typography,
      [
        'const base = 16;',
        'export const fontWeight = base * 25;',
        'export const lineHeight = base * 1.5;',
      ].join('\n')
    );
    writeFileSync(
      layout,
      [
        'const unit = 8;',
        'export const iconSize = unit * 3;',
        'export const spacing = unit * 2;',
      ].join('\n')
    );
    // Barrel re-exports from sub-modules (not statically evaluatable)
    writeFileSync(
      barrel,
      [
        "export { fontWeight, lineHeight } from './typography.js';",
        "export { iconSize, spacing } from './layout.js';",
      ].join('\n')
    );
    writeFileSync(
      consumerA,
      [
        "import { fontWeight } from './barrel.js';",
        'export const a = fontWeight;',
      ].join('\n')
    );
    writeFileSync(
      consumerB,
      [
        "import { iconSize } from './barrel.js';",
        'export const b = iconSize;',
      ].join('\n')
    );

    const services = createServices(root, consumerA);
    const asyncResolve = jest.fn(async () => null);
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);

    // Simulate: onlyByModule for barrel was set by consumer-a's RESOLVE only
    privateBroker.onlyByModule.set(barrel, ['fontWeight']);

    // Simulate: importsByModule for consumer-b shows it imports iconSize
    privateBroker.importsByModule.set(
      consumerB,
      new Map([['./barrel.js', ['iconSize']]])
    );

    // LOAD from consumer-b's context. Without the fix, requiredOnly would be
    // ["fontWeight"] (from onlyByModule), missing iconSize. With the fix,
    // it merges consumer-b's needs: ["fontWeight", "iconSize"].
    const loaded = await privateBroker.loadModule({
      id: barrel,
      importerId: consumerB,
      request: './barrel.js',
    });

    expect(loaded.only).toEqual(
      expect.arrayContaining(['fontWeight', 'iconSize'])
    );
    // The prepared code must re-export iconSize from the layout sub-module
    expect(loaded.code).toContain('iconSize');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('dedupes in-flight resolve calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    writeFileSync(dep, 'export const value = 1;');

    let resolvePromise: ((value: string | null) => void) | null = null;
    const asyncResolve = jest.fn(
      () =>
        new Promise<string | null>((resolveFn) => {
          resolvePromise = resolveFn;
        })
    );
    const services = createServices(root, importer);
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(importer, new Map([['./dep.js', ['*']]]));

    const first = privateBroker.resolveImport({
      specifier: './dep.js',
      importerId: importer,
      kind: 'import',
    });
    const second = privateBroker.resolveImport({
      specifier: './dep.js',
      importerId: importer,
      kind: 'import',
    });

    expect(asyncResolve).toHaveBeenCalledTimes(1);
    resolvePromise?.(dep);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.resolvedId).toBe(dep);
    expect(secondResult.resolvedId).toBe(dep);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes active entrypoint as async resolver stack root for transitive imports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const importer = join(root, 'dep.js');
    const nested = join(root, 'nested.js');
    writeFileSync(importer, 'export const value = 1;');
    writeFileSync(nested, 'export const value = 2;');

    const asyncResolve = jest.fn(async () => nested);
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    privateBroker.activeResolveRootId = entry;
    privateBroker.importsByModule.set(
      importer,
      new Map([['./nested.js', ['*']]])
    );

    const result = await privateBroker.resolveImport({
      specifier: './nested.js',
      importerId: importer,
      kind: 'import',
    });

    expect(result.resolvedId).toBe(nested);
    expect(asyncResolve).toHaveBeenCalledWith('./nested.js', importer, [
      importer,
      entry,
    ]);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes conditionNames to native fallback resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const pkgDir = join(root, 'node_modules', '@test', 'helpers');
    const sourceDep = join(pkgDir, 'src', 'utils.js');
    const defaultDep = join(pkgDir, 'lib', 'src', 'utils.js');

    mkdirSync(dirname(sourceDep), { recursive: true });
    mkdirSync(dirname(defaultDep), { recursive: true });
    writeFileSync(importer, 'module.exports = 1;');
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: '@test/helpers',
          exports: {
            './src/*': {
              '@test/source': './src/*.js',
              default: './lib/src/*.js',
            },
          },
        },
        null,
        2
      )
    );
    writeFileSync(sourceDep, 'module.exports = { value: "source" };');
    writeFileSync(defaultDep, 'module.exports = { value: "default" };');

    const services = createServices(root, importer, {
      conditionNames: ['@test/source', '...'],
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.importsByModule.set(
      importer,
      new Map([['@test/helpers/src/utils', ['*']]])
    );

    const result = await privateBroker.resolveImport({
      specifier: '@test/helpers/src/utils',
      importerId: importer,
      kind: 'require',
    });

    expect(realpathSync(result.resolvedId)).toBe(realpathSync(sourceDep));

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('dedupes in-flight load calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    let loaderResolve:
      | ((value: { code: string; loader?: string | null } | null) => void)
      | null = null;
    const customLoader = jest.fn(
      () =>
        new Promise<{ code: string } | null>((resolveFn) => {
          loaderResolve = resolveFn;
        })
    );
    const services = createServices(root, importer, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['*']);

    const first = privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });
    const second = privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });

    expect(customLoader).toHaveBeenCalledTimes(1);
    loaderResolve?.({ code: 'export const value = 1;' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.code).toContain('export const value = 1;');
    expect(secondResult.code).toContain('export const value = 1;');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses load cache for sequential loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    const customLoader = jest.fn(async () => ({
      code: 'export const value = 1;',
    }));
    const services = createServices(root, importer, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['*']);

    await privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });
    await privateBroker.loadModule({
      id: dep,
      importerId: importer,
      request: null,
    });

    expect(customLoader).toHaveBeenCalledTimes(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('rebuilds processor modules when __wywPreval is requested after named export loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'styles.ts');

    writeFileSync(
      entry,
      [
        "import { css } from 'test-css-processor';",
        'export const className = css`color: red;`;',
      ].join('\n')
    );

    const services = createServices(root, entry, {
      tagResolver: (source, tag) => {
        if (source === 'test-css-processor' && tag === 'css') {
          return testCssProcessorFile;
        }

        return null;
      },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);

    privateBroker.onlyByModule.set(entry, ['className']);
    const first = await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    expect(first.only).toContain('className');
    expect(first.code).not.toContain('__wywPreval');

    privateBroker.onlyByModule.set(entry, ['__wywPreval']);
    const second = await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    expect(second.only).toContain('__wywPreval');
    expect(second.code).toContain('__wywPreval');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reloads in-flight modules when nested imports request additional exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const helper = join(root, 'helper.js');
    const dep = join(root, 'dep.js');

    writeFileSync(
      entry,
      [
        "import { first } from './dep.js';",
        "import { second } from './helper.js';",
        'export const __wywPreval = {',
        '  value: () => `${first}:${second}`,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      helper,
      ["import { second } from './dep.js';", 'export { second };'].join('\n')
    );
    writeFileSync(
      dep,
      ["export const first = 'first';", "export const second = 'second';"].join(
        '\n'
      )
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }

      return null;
    });
    const services = createServices(root, entry);
    const loadAndParse = services.loadAndParseFn;
    let slowedDepLoad = false;
    services.loadAndParseFn = (nextServices, id, ...rest) => {
      if (id === dep && !slowedDepLoad) {
        slowedDepLoad = true;
        const end = Date.now() + 50;
        while (Date.now() < end) {
          // Keep the first dep load in-flight while nested imports resolve.
        }
      }

      return loadAndParse(nextServices, id, ...rest);
    };

    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe('first:second');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not reuse partial prepared export cache for wildcard or __wywPreval loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const dep = join(root, 'dep.js');

    writeFileSync(
      dep,
      [
        "export const normal = 'normal';",
        "export const second = 'second';",
        'export const __wywPreval = {',
        "  value: () => 'preval',",
        '};',
      ].join('\n')
    );

    const services = createServices(root, dep);
    const exportsProxy = Entrypoint.createExports(services.log);
    exportsProxy.normal = 'cached-normal';
    services.cache.add('entrypoints', dep, {
      dependencies: new Map(),
      evaluated: true,
      evaluatedOnly: ['*'],
      exports: exportsProxy,
      generation: 1,
      hasTransformResult: false,
      hasWywMetadata: false,
      ignored: false,
      invalidationDependencies: new Map(),
      invalidateOnDependencyChange: new Set(),
      log: services.log,
      name: dep,
      only: ['*'],
      parents: [],
      preevalResult: null,
      seqId: -1,
      transformResultCode: null,
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);

    privateBroker.onlyByModule.set(dep, ['*']);
    const wildcardPrepared = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    privateBroker.onlyByModule.set(dep, ['second']);
    const namedPrepared = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    privateBroker.onlyByModule.set(dep, ['__wywPreval']);
    const prevalPrepared = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    expect(wildcardPrepared.code).toContain('normal');
    expect(namedPrepared.code).toContain('second');
    expect(prevalPrepared.code).toContain('__wywPreval');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('invalidates all query variants in load cache after file change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importer = join(root, 'entry.js');
    const dep = join(root, 'data.txt');
    const rawId = `${dep}?raw`;
    const urlId = `${dep}?url`;

    const customLoader = jest.fn(async (id: string) => ({
      code: `export default ${JSON.stringify(id)};`,
    }));
    const services = createServices(root, importer, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = getPrivateBroker(broker);

    await privateBroker.loadModule({
      id: rawId,
      importerId: importer,
      request: rawId,
    });
    await privateBroker.loadModule({
      id: urlId,
      importerId: importer,
      request: urlId,
    });
    await privateBroker.loadModule({
      id: rawId,
      importerId: importer,
      request: rawId,
    });
    await privateBroker.loadModule({
      id: urlId,
      importerId: importer,
      request: urlId,
    });

    expect(customLoader).toHaveBeenCalledTimes(2);

    services.cache.invalidateForFile(dep);

    await privateBroker.loadModule({
      id: rawId,
      importerId: importer,
      request: rawId,
    });
    await privateBroker.loadModule({
      id: urlId,
      importerId: importer,
      request: urlId,
    });

    expect(customLoader).toHaveBeenCalledTimes(4);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('strips top-level browser-global expressions from prepared __wywPreval-only loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const dep = join(root, 'dep.js');
    writeFileSync(
      dep,
      [
        'const runtimeOnly = () => document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);',
        'const runtimeHref = window.location.href;',
        'export const __wywPreval = {',
        "  value: () => 'ok',",
        '};',
      ].join('\n')
    );

    const services = createServices(root, dep);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(dep, ['__wywPreval']);

    const loaded = await privateBroker.loadModule({
      id: dep,
      importerId: dep,
      request: dep,
    });

    // The shaker removes all code not referenced by __wywPreval.
    expect(loaded.code).not.toContain('window.location.href');
    expect(loaded.code).not.toContain('document.createTreeWalker');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not prepare transitive graph before runner requests modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const leaves = Array.from({ length: 12 }, (_, index) =>
      join(root, `leaf-${index}.js`)
    );

    leaves.forEach((file, index) => {
      writeFileSync(file, `export const value${index} = ${index};`);
    });

    writeFileSync(
      entry,
      [
        ...leaves.map(
          (_, index) => `import { value${index} } from './leaf-${index}.js';`
        ),
        'export const __wywPreval = {',
        "  value: () => 'ready',",
        '};',
      ].join('\n')
    );

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      })
    );
    const privateBroker = getPrivateBroker(broker);
    privateBroker.onlyByModule.set(entry, ['__wywPreval']);

    await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    for (const leaf of leaves) {
      expect(services.cache.get('entrypoints', leaf)).toBeUndefined();
    }

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not resolve unused imports for __wywPreval-only runner loads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    writeFileSync(dep, 'export const unused = 1;');
    writeFileSync(
      entry,
      [
        "import { unused } from './dep.js';",
        'export const __wywPreval = {',
        '  value: () => 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(1);
    expect(asyncResolve).not.toHaveBeenCalledWith('./dep.js', entry);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not widen preval-only eval loads with cached runtime component exports', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.tsx');
    const tokens = join(root, 'tokens.ts');

    writeFileSync(
      tokens,
      [
        'export const border = { radius8: 8 };',
        "export const themeVars = { inputBorderHoverColor: 'red' };",
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { memo } from 'react';",
        "import { css } from 'test-css-processor';",
        "import { border, themeVars } from './tokens';",
        'const className = css`',
        '  border-radius: ${border.radius8}px;',
        '  color: ${themeVars.inputBorderHoverColor};',
        '`;',
        'export const Comment = memo(function Comment() {',
        '  return <div className={className} />;',
        '});',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return testCssProcessorFile;
      }

      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }

      return null;
    });
    const services = createServices(root, entry, {
      tagResolver: (source, tag) => {
        if (source === 'test-css-processor' && tag === 'css') {
          return testCssProcessorFile;
        }

        return null;
      },
    });
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);

    privateBroker.onlyByModule.set(entry, ['Comment']);
    await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    privateBroker.onlyByModule.set(entry, ['__wywPreval']);
    const loaded = await privateBroker.loadModule({
      id: entry,
      importerId: entry,
      request: entry,
    });

    expect(loaded.only).toEqual(['__wywPreval']);
    expect(loaded.code).toContain('export const __wywPreval');
    expect(loaded.code).not.toContain('memo');
    expect(loaded.code).not.toContain('Comment');
    expect(loaded.imports?.has('react')).toBe(false);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('evaluates a module graph via runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');

    writeFileSync(dep, 'export const value = 41;');
    writeFileSync(
      entry,
      [
        "import { value } from './dep.js';",
        'export const __wywPreval = {',
        '  value: () => value + 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(result.dependencies).toContain('./dep.js');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps package subdirectory modules classified as ESM after cached package misses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const packageDir = join(root, 'node_modules', 'fake');
    const srcDir = join(packageDir, 'src');
    const cjsDir = join(packageDir, 'cjs');
    const first = join(srcDir, 'first.js');
    const second = join(srcDir, 'second.js');

    mkdirSync(srcDir, { recursive: true });
    mkdirSync(cjsDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: {
          './first': {
            import: './src/first.js',
            require: './cjs/first.cjs',
          },
          './second': {
            import: './src/second.js',
            require: './cjs/second.cjs',
          },
        },
      })
    );
    writeFileSync(first, 'export const first = 1;');
    writeFileSync(second, 'export const second = 2;');
    writeFileSync(join(cjsDir, 'first.cjs'), 'exports.first = 10;');
    writeFileSync(join(cjsDir, 'second.cjs'), 'exports.second = 20;');
    writeFileSync(
      entry,
      [
        "import { first } from 'fake/first';",
        "import { second } from 'fake/second';",
        'export const __wywPreval = {',
        '  value: () => first + second,',
        '};',
      ].join('\n')
    );

    const warnings: Array<{ code: string; specifier?: string }> = [];
    const asyncResolve = jest.fn(async (what: string) => {
      if (what === 'fake/first') {
        return first;
      }
      if (what === 'fake/second') {
        return second;
      }
      return null;
    });
    const services = createServices(root, entry, {
      eval: {
        onWarn: (warning) => warnings.push(warning),
      },
    });
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(3);
    expect(warnings.filter((w) => w.code === 'require-fallback')).toHaveLength(
      0
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses root ancestor as async resolver stack root for evaluated child entrypoints', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    const nested = join(root, 'nested.js');

    writeFileSync(entry, "import './dep.js';");
    writeFileSync(nested, 'export const value = 41;');
    writeFileSync(
      dep,
      [
        "import { value } from './nested.js';",
        'export const __wywPreval = {',
        '  value: () => value + 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const rootEntrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );
    const childEntrypoint = rootEntrypoint.createChild(
      dep,
      ['__wywPreval'],
      readFileSync(dep, 'utf-8')
    );

    if (childEntrypoint === 'loop') {
      throw new Error('Unexpected loop in test entrypoint graph');
    }

    const result = await broker.evaluate(childEntrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(asyncResolve).toHaveBeenCalledWith('./nested.js', dep, [dep, entry]);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps only direct dependency specifiers in metadata for re-export chains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const barrel = join(root, 'barrel.js');
    const leaf = join(root, 'leaf.js');

    writeFileSync(leaf, 'export const value = 41;');
    writeFileSync(barrel, `export { value } from './leaf.js';`);
    writeFileSync(
      entry,
      [
        "import { value } from './barrel.js';",
        'export const __wywPreval = {',
        '  value: () => value + 1,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(result.dependencies).toEqual(['./barrel.js']);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  describe('eval.globals lifecycle', () => {
    it('re-evaluates when eval.globals value changes between runs', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          'const captured = GLOBAL_VAL;',
          'export const __wywPreval = {',
          '  value: () => captured,',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry, {
        eval: {
          globals: {
            GLOBAL_VAL: 1,
          },
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const first = await broker.evaluate(entrypoint);
      expect(first.values?.get('value')).toBe(1);

      services.options.pluginOptions.eval = {
        ...(services.options.pluginOptions.eval ?? {}),
        globals: {
          GLOBAL_VAL: 2,
        },
      };

      const second = await broker.evaluate(entrypoint);
      expect(second.values?.get('value')).toBe(2);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('drops removed globals across re-init', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          "const captured = typeof REMOVED_GLOBAL === 'undefined' ? 'missing' : REMOVED_GLOBAL;",
          'export const __wywPreval = {',
          '  value: () => captured,',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry, {
        eval: {
          globals: {
            REMOVED_GLOBAL: 'present',
          },
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const first = await broker.evaluate(entrypoint);
      expect(first.values?.get('value')).toBe('present');

      services.options.pluginOptions.eval = {
        ...(services.options.pluginOptions.eval ?? {}),
        globals: {},
      };

      const second = await broker.evaluate(entrypoint);
      expect(second.values?.get('value')).toBe('missing');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('keeps the warm runner when a late happyDOM upgrade times out', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const plainEntry = join(root, 'plain-entry.js');
      const domEntry = join(root, 'dom-entry.js');

      writeFileSync(
        plainEntry,
        ['export const __wywPreval = {', "  value: () => 'plain',", '};'].join(
          '\n'
        )
      );
      writeFileSync(
        domEntry,
        ['export const __wywPreval = {', "  value: () => 'dom',", '};'].join(
          '\n'
        )
      );

      const services = createServices(root, plainEntry, {
        features: {
          ...createPluginOptions().features,
          happyDOM: [domEntry],
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const privateBroker = getPrivateBroker(broker);
      const request = jest
        .spyOn(privateBroker, 'request')
        .mockResolvedValue({});
      const initIsolatedRunner = jest
        .spyOn(privateBroker, 'initIsolatedRunner')
        .mockImplementation(async () => {
          const error = new Error('[wyw-in-js] Eval runner timed out for INIT');
          (error as { code?: string }).code = 'WYW_EVAL_TIMEOUT';
          throw error;
        });

      const plainEntrypoint = Entrypoint.createRoot(
        services,
        plainEntry,
        ['__wywPreval'],
        readFileSync(plainEntry, 'utf-8')
      );
      await privateBroker.initRunner(plainEntrypoint);

      privateBroker.runner = {
        kill: jest.fn(),
        removeAllListeners: jest.fn(),
      } as unknown;

      const domEntrypoint = Entrypoint.createRoot(
        services,
        domEntry,
        ['__wywPreval'],
        readFileSync(domEntry, 'utf-8')
      );
      await privateBroker.initRunner(domEntrypoint);

      expect(initIsolatedRunner).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[0]).toBe('INIT');
      expect(privateBroker.happyDomDisabled).toBe(true);
      expect(privateBroker.lastHappyDomEnabled).toBe(false);
      expect(privateBroker.lastInitKey).not.toBeNull();

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('reuses non-serializable dependency modules across entrypoints when globals are stable', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'dep.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(
        dep,
        [
          'const value = () => undefined;',
          'value.token = Math.random().toString(36).slice(2);',
          'export default value;',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry);
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const first = await broker.evaluate(firstEntrypoint);
      const second = await broker.evaluate(secondEntrypoint);

      expect(first.values?.get('value')).toBe(second.values?.get('value'));

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('reuses non-serializable dependency modules across entrypoints when overrideContext globals stay stable', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'dep.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(
        dep,
        [
          'const value = () => undefined;',
          'value.token = Math.random().toString(36).slice(2);',
          'export default value;',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry, {
        overrideContext: (context) => ({
          ...context,
          __wyw_import_meta_env: {
            MODE: 'production',
          },
        }),
      });
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const first = await broker.evaluate(firstEntrypoint);
      const second = await broker.evaluate(secondEntrypoint);

      expect(first.values?.get('value')).toBe(second.values?.get('value'));

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('dedupes concurrent loads for a shared noShake dependency across root and importer entrypoints', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'icons.js');
      const svgMock = join(root, 'svg-react.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(svgMock, 'export default "svg-mock";');
      writeFileSync(
        dep,
        [
          'export const loadCount = (() => { globalThis.__iconsLoadCount = (globalThis.__iconsLoadCount ?? 0) + 1; return globalThis.__iconsLoadCount; })();',
          "import InviteMedium from './svg-react.js';",
          "import CreateSemibold from './svg-react.js';",
          'export { InviteMedium, CreateSemibold };',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import { InviteMedium, loadCount } from './icons.js';",
          'export const __wywPreval = {',
          '  count: () => loadCount,',
          '  value: () => InviteMedium,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import { CreateSemibold, loadCount } from './icons.js';",
          'export const __wywPreval = {',
          '  count: () => loadCount,',
          '  value: () => CreateSemibold,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry, {
        importOverrides: {
          './icons.js': { noShake: true },
        },
      });
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const [firstResult, secondResult] = await Promise.all([
        broker.evaluate(firstEntrypoint),
        broker.evaluate(secondEntrypoint),
      ]);

      // Both entries import icons.js with noShake — single unshaken variant,
      // so the module executes only once despite two concurrent consumers.
      expect(firstResult.values?.get('count')).toBe(1);
      expect(secondResult.values?.get('count')).toBe(1);
      expect(firstResult.values?.get('value')).toBe('svg-mock');
      expect(secondResult.values?.get('value')).toBe('svg-mock');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('does not reuse non-serializable dependency modules across entrypoints when overrideContext globals change', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const dep = join(root, 'dep.js');
      const firstEntry = join(root, 'entry-a.js');
      const secondEntry = join(root, 'entry-b.js');

      writeFileSync(
        dep,
        [
          'const value = () => undefined;',
          'value.token = Math.random().toString(36).slice(2);',
          'export default value;',
        ].join('\n')
      );
      writeFileSync(
        firstEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import dep from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => dep.token,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, firstEntry, {
        overrideContext: (context) => ({
          ...context,
          CURRENT_FILE: context.__filename,
        }),
      });
      const broker = new EvalBroker(services, asyncResolve);
      const firstEntrypoint = Entrypoint.createRoot(
        services,
        firstEntry,
        ['__wywPreval'],
        readFileSync(firstEntry, 'utf-8')
      );
      const secondEntrypoint = Entrypoint.createRoot(
        services,
        secondEntry,
        ['__wywPreval'],
        readFileSync(secondEntry, 'utf-8')
      );

      const first = await broker.evaluate(firstEntrypoint);
      const second = await broker.evaluate(secondEntrypoint);

      expect(first.values?.get('value')).not.toBe(second.values?.get('value'));

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('wraps decode failures with path-aware globals diagnostics', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        ['export const __wywPreval = {', '  value: () => 1,', '};'].join('\n')
      );

      const services = createServices(root, entry, {
        eval: {
          globals: {
            BROKEN_FN: {
              __wyw_eval_global: {
                signature: 'wyw-eval-global',
                version: 1,
                kind: 'function',
                source: 'function () {',
              },
            },
          },
        },
      });
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      await expect(broker.evaluate(entrypoint)).rejects.toThrow(
        '[wyw-in-js] Failed to restore eval.globals function at eval.globals.BROKEN_FN. Ensure the value is a user-defined function expression/arrow function. Native and bound functions are not supported.'
      );

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('reports path-aware errors for unsupported __wywPreval values', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          'export const __wywPreval = {',
          '  value: () => ({',
          "    nested: new Map([['answer', 42]]),",
          '  }),',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        await broker.evaluate(entrypoint);
        throw new Error('Expected broker.evaluate() to reject');
      } catch (error) {
        expect(String(error)).toContain('[wyw-in-js] __wywPreval');
        expect(String(error)).toContain('__wywPreval.value.nested');
        expect(String(error)).toContain('unsupported non-plain object (Map)');
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('preserves function-valued __wywPreval entries as callable placeholders', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          'const helper = () => 1;',
          'export const __wywPreval = {',
          '  value: () => helper,',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const value = result.values?.get('value');

        expect(typeof value).toBe('function');
        expect((value as () => unknown)()).toBeUndefined();
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('preserves symbol markers inside __wywPreval objects', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');

      writeFileSync(
        entry,
        [
          "const marker = Symbol.for('react.forward_ref');",
          'export const __wywPreval = {',
          '  value: () => ({ marker }),',
          '};',
        ].join('\n')
      );

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const value = result.values?.get('value') as
          | { marker?: symbol }
          | undefined;

        expect(typeof value?.marker).toBe('symbol');
        expect(value?.marker).toBe(Symbol.for('react.forward_ref'));
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('skips non-serializable dependency exports when caching module results', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const secondEntry = join(root, 'entry-2.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        [
          'export const serializable = 41;',
          'export const skipped = () => 2;',
        ].join('\n')
      );
      writeFileSync(
        entry,
        [
          "import { serializable, skipped } from './dep.js';",
          'export const __wywPreval = {',
          "  value: () => serializable + (typeof skipped === 'function' ? 1 : 0),",
          '};',
        ].join('\n')
      );
      writeFileSync(
        secondEntry,
        [
          "import { skipped } from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => skipped(),',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      try {
        const result = await broker.evaluate(entrypoint);
        const secondEntrypoint = Entrypoint.createRoot(
          services,
          secondEntry,
          ['__wywPreval'],
          readFileSync(secondEntry, 'utf-8')
        );
        const secondResult = await broker.evaluate(secondEntrypoint);
        const cachedDep = services.cache.get('entrypoints', dep) as
          | {
              exports?: Record<string, unknown>;
              evaluatedOnly?: string[];
            }
          | undefined;

        expect(result.values?.get('value')).toBe(42);
        expect(secondResult.values?.get('value')).toBe(2);
        expect(cachedDep).toBeDefined();
        expect(cachedDep?.exports?.serializable).toBe(41);
        expect(cachedDep?.exports && 'skipped' in cachedDep.exports).toBe(
          false
        );
        expect(cachedDep?.evaluatedOnly).not.toContain('*');
      } finally {
        broker.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('promotes statically evaluatable dependency modules to wildcard cache coverage', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        ['export const foo1 = "foo1";', 'export const foo2 = "foo2";'].join(
          '\n'
        )
      );
      writeFileSync(
        entry,
        [
          "import { foo1 } from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => foo1,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }

        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);
      const cachedDep = services.cache.get('entrypoints', dep) as
        | {
            exports?: Record<string, unknown>;
            evaluatedOnly?: string[];
          }
        | undefined;

      expect(result.values?.get('value')).toBe('foo1');
      expect(cachedDep?.evaluatedOnly).toContain('*');
      expect(cachedDep?.exports?.foo1).toBe('foo1');
      expect(cachedDep?.exports?.foo2).toBe('foo2');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('does not reuse wildcard cached exports for subsequent __wywPreval requests', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        [
          'export const normal = 41;',
          'export const __wywPreval = {',
          '  value: () => normal + 1,',
          '};',
        ].join('\n')
      );
      writeFileSync(
        entry,
        [
          "import { normal } from './dep.js';",
          'export const __wywPreval = {',
          '  value: () => normal,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }

        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const firstResult = await broker.evaluate(entrypoint);
      const cachedDep = services.cache.get('entrypoints', dep) as
        | {
            evaluatedOnly?: string[];
            exports?: Record<string, unknown>;
          }
        | undefined;
      const depEntrypoint = Entrypoint.createRoot(
        services,
        dep,
        ['__wywPreval'],
        readFileSync(dep, 'utf-8')
      );
      const secondResult = await broker.evaluate(depEntrypoint);

      expect(firstResult.values?.get('value')).toBe(41);
      expect(cachedDep?.evaluatedOnly).toContain('*');
      expect(cachedDep?.exports?.normal).toBe(41);
      expect(cachedDep?.exports && '__wywPreval' in cachedDep.exports).toBe(
        false
      );
      expect(secondResult.values?.get('value')).toBe(42);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('builds direct proxy modules for requested exports from mixed re-export barrels', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'entry.js');
      const barrel = join(root, 'barrel.js');
      const main = join(root, 'main.js');
      const used = join(root, 'used.js');
      const unused = join(root, 'unused.js');

      writeFileSync(main, 'export default 1;');
      writeFileSync(used, 'export default 41;');
      writeFileSync(
        unused,
        'throw new Error("unused export should stay cold");'
      );
      writeFileSync(
        barrel,
        [
          "import main from './main.js';",
          "export { default as used } from './used.js';",
          "export { default as unused } from './unused.js';",
          'export default main;',
        ].join('\n')
      );
      writeFileSync(
        entry,
        [
          "import { used } from './barrel.js';",
          'export const __wywPreval = {',
          '  value: () => used,',
          '};',
        ].join('\n')
      );

      const asyncResolve = jest.fn(async (what: string, importer: string) => {
        if (what.startsWith('.')) {
          return resolve(dirname(importer), what);
        }
        return null;
      });
      const services = createServices(root, entry);
      const broker = new EvalBroker(services, asyncResolve);
      const privateBroker = getPrivateBroker(broker);

      privateBroker.onlyByModule.set(barrel, ['used']);
      const prepared = await privateBroker.loadModule({
        id: barrel,
        importerId: entry,
        request: './barrel.js',
      });

      expect(prepared.code).toContain('./used.js');
      expect(prepared.code).not.toContain('./unused.js');
      expect(prepared.code).not.toContain('./main.js');

      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      const result = await broker.evaluate(entrypoint);

      expect(result.values?.get('value')).toBe(41);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('widens shared dependency export surface from cached parent requests', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const first = join(root, 'first.js');
      const second = join(root, 'second.js');
      const dep = join(root, 'dep.js');

      writeFileSync(
        dep,
        [
          'const values = (() => ({ foo: "foo", bar: "bar" }))();',
          'export const foo = values.foo;',
          'export const bar = values.bar;',
        ].join('\n')
      );
      writeFileSync(
        first,
        ["import { foo } from './dep.js';", 'export const value = foo;'].join(
          '\n'
        )
      );
      writeFileSync(
        second,
        ["import { bar } from './dep.js';", 'export const value = bar;'].join(
          '\n'
        )
      );
      const services = createServices(root, first);
      services.cache.add('entrypoints', first, {
        dependencies: new Map([
          [
            './dep.js',
            {
              only: ['foo'],
              resolved: dep,
              source: './dep.js',
            },
          ],
        ]),
      } as any);
      services.cache.add('entrypoints', second, {
        dependencies: new Map([
          [
            './dep.js',
            {
              only: ['bar'],
              resolved: dep,
              source: './dep.js',
            },
          ],
        ]),
      } as any);

      const broker = new EvalBroker(
        services,
        jest.fn(async (what: string, importer: string) => {
          if (what.startsWith('.')) {
            return resolve(dirname(importer), what);
          }
          return null;
        })
      );
      const privateBroker = getPrivateBroker(broker);
      privateBroker.onlyByModule.set(dep, ['foo']);

      const loaded = await privateBroker.loadModule({
        id: dep,
        importerId: first,
        request: './dep.js',
      });

      expect(loaded.only).toEqual(expect.arrayContaining(['foo', 'bar']));
      expect(loaded.code).toContain('foo');
      expect(loaded.code).toContain('bar');

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });
  });

  it('evaluates a cyclic module graph via runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'a.js');
    const dep = join(root, 'b.js');

    writeFileSync(
      entry,
      [
        "import { valueB } from './b.js';",
        'export const valueA = 40;',
        'export const __wywPreval = {',
        '  value: () => valueA + valueB,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      dep,
      ["import { valueA } from './a.js';", 'export const valueB = 2;'].join(
        '\n'
      )
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entry);
    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('applies importOverrides when resolving external packages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const mock = join(root, 'mock.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(dep, 'module.exports = { value: 41 };');
    writeFileSync(mock, 'export default { value: 1 };');
    writeFileSync(
      entry,
      [
        "import fake from 'fake';",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what === 'fake') {
        return dep;
      }
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });

    const services = createServices(root, entry, {
      importOverrides: {
        fake: {
          mock: './mock.js',
        },
      },
    });

    const broker = new EvalBroker(services, asyncResolve);
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not corrupt IPC when an external module logs to console', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(
      dep,
      [
        "console.log('hello from external');",
        'module.exports = { value: 42 };',
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "const fake = require('fake');",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const warnings: string[] = [];
    const services = createServices(root, entry);
    services.emitWarning = (message) => warnings.push(message);

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(42);
    expect(
      warnings.some((message) =>
        message.includes('[wyw-eval-runner] Failed to parse message:')
      )
    ).toBe(false);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('warns once when require fallback is used during eval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(dep, 'module.exports = { value: 41 };');
    writeFileSync(
      entry,
      [
        "const fake = require('fake');",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const warnings: Array<{ code: string; specifier?: string }> = [];
    const services = createServices(root, entry, {
      eval: {
        require: 'warn-and-run',
        onWarn: (warning) => warnings.push(warning),
      },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const first = await broker.evaluate(entrypoint);
    const second = await broker.evaluate(entrypoint);

    expect(first.values?.get('value')).toBe(41);
    expect(second.values?.get('value')).toBe(41);
    expect(warnings.filter((w) => w.code === 'require-fallback')).toHaveLength(
      1
    );
    expect(warnings[0].specifier).toBe('fake');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('suppresses require fallback warnings when importOverrides match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const mock = join(root, 'mock.cjs');
    const nodeModulesDir = join(root, 'node_modules', 'fake');
    const dep = join(nodeModulesDir, 'index.js');

    mkdirSync(nodeModulesDir, { recursive: true });
    writeFileSync(dep, 'module.exports = { value: 41 };');
    writeFileSync(mock, 'module.exports = { value: 1 };');
    writeFileSync(
      entry,
      [
        "const fake = require('fake');",
        'export const __wywPreval = {',
        '  value: () => fake.value,',
        '};',
      ].join('\n')
    );

    const warnings: Array<{ code: string }> = [];
    const services = createServices(root, entry, {
      eval: {
        require: 'warn-and-run',
        onWarn: (warning) => warnings.push(warning),
      },
      importOverrides: {
        fake: {
          mock: './mock.cjs',
        },
      },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    const result = await broker.evaluate(entrypoint);

    expect(result.values?.get('value')).toBe(1);
    expect(warnings.filter((w) => w.code === 'require-fallback')).toHaveLength(
      0
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('throws on non-literal require in strict mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');

    writeFileSync(
      entry,
      [
        "const name = 'fake';",
        'const fake = require(name);',
        'export const __wywPreval = {',
        '  value: () => fake?.value ?? 0,',
        '};',
      ].join('\n')
    );

    const services = createServices(root, entry, {
      eval: {
        mode: 'strict',
      },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const entrypoint = Entrypoint.createRoot(
      services,
      entry,
      ['__wywPreval'],
      readFileSync(entry, 'utf-8')
    );

    await expect(broker.evaluate(entrypoint)).rejects.toThrow(
      'Non-literal require() is not supported during eval'
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('collectModuleExports does not crash on TDZ exports from re-prepared modules', async () => {
    // Reproduces: ReferenceError: Cannot access 'X' before initialization
    //
    // Session 1: entry-a imports {space} from barrel. Barrel re-exports from
    // layout.js AND colors.js. colors.js → filter.js → generator.js → leaf.js.
    // leaf.js exports `const core = {...}`. The broker prepares leaf.js with
    // only:["core"]. The runner loads all modules, links, evaluates. leaf.js's
    // `core` is initialized. moduleOnly accumulates leaf.js.
    //
    // Session 2: entry-b imports {theme} from barrel. Barrel → theme.js →
    // generator.js (already cached). generator.js → leaf.js (already cached,
    // hash match → reuses SourceTextModule). But if the broker re-prepares
    // leaf.js with a wider only-set, resetSingleModuleState creates a NEW
    // SourceTextModule. This new module is linked into the current graph.
    // When evaluate() runs, all linked modules evaluate, including the new
    // leaf.js SourceTextModule. So `core` should be initialized.
    //
    // The TDZ crash happens when the runner caches a module that was linked but
    // whose parent's evaluation threw BEFORE the module itself was evaluated.
    // collectModuleExports then iterates moduleOnly and hits the TDZ binding.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // leaf.js — deeply nested module with a const export
    writeFileSync(join(root, 'leaf.js'), 'export const core = { x: 1 };');

    // generator.js — imports leaf
    writeFileSync(
      join(root, 'generator.js'),
      "import { core } from './leaf.js';\nexport const gen = () => core;"
    );

    // broken.js — references an export that doesn't exist (link error)
    writeFileSync(
      join(root, 'broken.js'),
      "import { nonExistent } from './leaf.js';\nexport const value = nonExistent;"
    );

    // entry-a — imports generator (normal, succeeds)
    writeFileSync(
      join(root, 'entry-a.js'),
      [
        "import { gen } from './generator.js';",
        'export const __wywPreval = { v: () => gen().x };',
      ].join('\n')
    );

    // entry-b — imports broken (throws during eval, leaf.js may be linked but
    // not evaluated if the error propagates before the VM reaches it)
    writeFileSync(
      join(root, 'entry-b.js'),
      [
        "import { value } from './broken.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );

    // entry-c — imports generator again (leaf.js cached from session 1,
    // but moduleOnly still has leaf.js from sessions 1+2)
    writeFileSync(
      join(root, 'entry-c.js'),
      [
        "import { gen } from './generator.js';",
        'export const __wywPreval = { v: () => gen().x };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-a.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: succeeds
    const epA = Entrypoint.createRoot(
      services,
      join(root, 'entry-a.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-a.js'), 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('v')).toBe(1);

    // Session 2: broken.js throws — leaf.js may be linked but not evaluated
    const epB = Entrypoint.createRoot(
      services,
      join(root, 'entry-b.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-b.js'), 'utf-8')
    );
    await expect(broker.evaluate(epB)).rejects.toThrow();

    // Session 3: should not crash on TDZ in collectModuleExports
    const epC = Entrypoint.createRoot(
      services,
      join(root, 'entry-c.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-c.js'), 'utf-8')
    );
    const resultC = await broker.evaluate(epC);
    expect(resultC.values?.get('v')).toBe(1);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('collectModuleExports skips errored modules from prior failed eval sessions', async () => {
    // Reproduces: ReferenceError: Cannot access 'neutralCore' before initialization
    //
    // Mechanism: reuseModules=true keeps moduleOnly/moduleCache/moduleData across
    // eval sessions. If session N evaluates a module whose preamble runs (sets
    // moduleData) but whose body throws (const binding in TDZ, module "errored"),
    // the stale entry persists. Session N+1 evaluates a different entrypoint
    // successfully, then collectModuleExports iterates ALL moduleOnly entries.
    // Object.keys(namespace) on the "errored" module triggers TDZ.
    //
    // Fix: guard with `module.status !== 'evaluated'` in collectModuleExports.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // thrower.js — preamble runs (moduleData created), then body throws.
    // The `core` binding stays in TDZ (never initialized).
    writeFileSync(
      join(root, 'thrower.js'),
      [
        'const boom = (() => { throw new Error("kaboom"); })();',
        'export const core = boom;',
      ].join('\n')
    );

    // entry-fail.js — imports thrower → evaluation fails
    writeFileSync(
      join(root, 'entry-fail.js'),
      [
        "import { core } from './thrower.js';",
        'export const __wywPreval = { v: () => core };',
      ].join('\n')
    );

    // entry-ok.js — no relation to thrower, evaluates fine
    writeFileSync(
      join(root, 'entry-ok.js'),
      'export const __wywPreval = { v: () => 42 };'
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-fail.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: thrower.js's preamble runs → moduleData set.
    // thrower.js body throws → module status "errored", `core` in TDZ.
    // moduleOnly/moduleCache/moduleData all have thrower.js entries.
    const epFail = Entrypoint.createRoot(
      services,
      join(root, 'entry-fail.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-fail.js'), 'utf-8')
    );
    await expect(broker.evaluate(epFail)).rejects.toThrow();

    // Session 2: different entrypoint succeeds. collectModuleExports must
    // NOT crash when iterating the stale thrower.js entry.
    const epOk = Entrypoint.createRoot(
      services,
      join(root, 'entry-ok.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-ok.js'), 'utf-8')
    );
    const result = await broker.evaluate(epOk);
    expect(result.values?.get('v')).toBe(42);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('link failure against errored module includes root cause in error.cause', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // thrower.js — body throws during evaluation
    writeFileSync(
      join(root, 'thrower.js'),
      [
        'const boom = (() => { throw new Error("kaboom"); })();',
        'export const value = boom;',
      ].join('\n')
    );

    // entry-fail.js — imports thrower → evaluation fails
    writeFileSync(
      join(root, 'entry-fail.js'),
      [
        "import { value } from './thrower.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );

    // consumer.js — also imports thrower → will link-fail in session 2
    writeFileSync(
      join(root, 'consumer.js'),
      [
        "import { value } from './thrower.js';",
        'export const __wywPreval = { v: () => value };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-fail.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: thrower.js errors during evaluation
    const epFail = Entrypoint.createRoot(
      services,
      join(root, 'entry-fail.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-fail.js'), 'utf-8')
    );
    await expect(broker.evaluate(epFail)).rejects.toThrow();

    // Session 2: consumer.js tries to link against the cached errored thrower.js
    const epConsumer = Entrypoint.createRoot(
      services,
      join(root, 'consumer.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'consumer.js'), 'utf-8')
    );

    try {
      await broker.evaluate(epConsumer);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const error = err as Error;
      expect(error.message).toMatch(/errored module/);
      expect(error.message).toMatch(/Root cause:.*kaboom/);
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toBe('kaboom');
    }

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('concurrent sibling dependencies importing different exports from same barrel succeed', async () => {
    // Reproduces: when two dependency modules concurrently link and both import
    // the same barrel file (for different named exports), the runner's loadInFlight
    // dedup causes the second importer to piggyback on the first's LOAD request.
    // If the broker hasn't merged both importers' needs into onlyByModule yet,
    // the barrel is prepared with a narrow only set → second importer's link fails
    // with "does not provide an export named 'X'".

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // Use a non-trivial re-export barrel so broker cannot promote it to
    // only:["*"] and accidentally mask narrow prepared code.
    writeFileSync(
      join(root, 'barrel.js'),
      [
        "export { fontWeight } from './typography.js';",
        "export { iconSize } from './layout.js';",
      ].join('\n')
    );
    writeFileSync(
      join(root, 'typography.js'),
      ['const base = 100;', 'export const fontWeight = base * 4;'].join('\n')
    );
    writeFileSync(
      join(root, 'layout.js'),
      ['const unit = 8;', 'export const iconSize = unit * 3;'].join('\n')
    );

    // consumer-a.js — uses fontWeight from barrel
    writeFileSync(
      join(root, 'consumer-a.js'),
      [
        "import { fontWeight } from './barrel.js';",
        'export const a = fontWeight;',
      ].join('\n')
    );

    // consumer-b.js — uses iconSize from barrel
    writeFileSync(
      join(root, 'consumer-b.js'),
      [
        "import { iconSize } from './barrel.js';",
        'export const b = iconSize;',
      ].join('\n')
    );

    // entry.js — imports both consumers, __wywPreval depends on both
    writeFileSync(
      join(root, 'entry.js'),
      [
        "import { a } from './consumer-a.js';",
        "import { b } from './consumer-b.js';",
        'export const __wywPreval = { a: () => a, b: () => b };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry.js'));
    const broker = new EvalBroker(services, asyncResolve);

    const ep = Entrypoint.createRoot(
      services,
      join(root, 'entry.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry.js'), 'utf-8')
    );
    const result = await broker.evaluate(ep);
    expect(result.values?.get('a')).toBe(400);
    expect(result.values?.get('b')).toBe(24);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('nested sibling dependencies can widen a shared source module during link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    writeFileSync(join(root, 'flag.js'), 'export const flag = 2;');
    writeFileSync(
      join(root, 'shared.js'),
      [
        "import { flag } from './flag.js';",
        'export const narrow = flag * 10;',
        'export const wide = flag * 20;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'direct.js'),
      [
        "import { narrow } from './shared.js';",
        'export const direct = narrow;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'nested.js'),
      [
        "import { wide } from './shared.js';",
        'export const nested = wide;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'parent.js'),
      [
        "import { direct } from './direct.js';",
        "import { nested } from './nested.js';",
        'export const parent = direct + nested;',
      ].join('\n')
    );
    writeFileSync(
      join(root, 'entry.js'),
      [
        "import { parent } from './parent.js';",
        'export const __wywPreval = { parent: () => parent };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry.js'));
    const broker = new EvalBroker(services, asyncResolve);

    const ep = Entrypoint.createRoot(
      services,
      join(root, 'entry.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry.js'), 'utf-8')
    );
    const result = await broker.evaluate(ep);
    expect(result.values?.get('parent')).toBe(60);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('cross-session barrel widening: second session needing different exports re-prepares', async () => {
    // Reproduces stale-only issue across sessions with reuseModules.
    // Session 1: barrel prepared with only:["fontWeight"].
    // Session 2: different entrypoint needs iconSize from the same barrel.
    // The runner's resolveCache persists across sessions, so the broker may
    // not receive a fresh RESOLVE for the barrel. The broker must still
    // detect that the cached barrel is too narrow and re-prepare.

    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    // barrel.js — two exports
    writeFileSync(
      join(root, 'barrel.js'),
      ['export const fontWeight = 400;', 'export const iconSize = 24;'].join(
        '\n'
      )
    );

    // entry-a.js — only needs fontWeight
    writeFileSync(
      join(root, 'entry-a.js'),
      [
        "import { fontWeight } from './barrel.js';",
        'export const __wywPreval = { w: () => fontWeight };',
      ].join('\n')
    );

    // entry-b.js — needs iconSize (different export from barrel)
    writeFileSync(
      join(root, 'entry-b.js'),
      [
        "import { iconSize } from './barrel.js';",
        'export const __wywPreval = { s: () => iconSize };',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, join(root, 'entry-a.js'));
    const broker = new EvalBroker(services, asyncResolve);

    // Session 1: barrel gets prepared with only:["fontWeight"]
    const epA = Entrypoint.createRoot(
      services,
      join(root, 'entry-a.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-a.js'), 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('w')).toBe(400);

    // Session 2: different entrypoint needs iconSize from the same barrel
    const epB = Entrypoint.createRoot(
      services,
      join(root, 'entry-b.js'),
      ['__wywPreval'],
      readFileSync(join(root, 'entry-b.js'), 'utf-8')
    );
    const resultB = await broker.evaluate(epB);
    expect(resultB.values?.get('s')).toBe(24);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reuses evaluated variant modules when broker sends narrow serialized exports', async () => {
    // Regression test for cache poisoning:
    //
    // Session 1 evaluates dep.js as a module variant (only includes __wywPreval,
    // so isFullModuleLoad is false). The variant has all exports (x, y).
    //
    // Session 2 only needs `x` from dep.js. The broker sends serialized exports
    // { x: ... } (narrow slice). The runner must NOT create a narrow
    // SyntheticModule — it should reuse the evaluated variant that has both x and y.
    //
    // Session 3 needs both x and y from dep.js. If the runner created a narrow
    // SyntheticModule in session 2 and returned it, session 3's link would fail
    // because the SyntheticModule doesn't have y. With the fix, the evaluated
    // variant is returned instead.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const dep = join(root, 'dep.js');
    writeFileSync(dep, 'export const x = 10;\nexport const y = 20;\n');

    const barrel = join(root, 'barrel.js');
    writeFileSync(
      barrel,
      "export { x, y } from './dep.js';\n"
    );

    // Session 1: imports both x and y → forces full eval of dep.js
    const entryA = join(root, 'entry-a.js');
    writeFileSync(
      entryA,
      [
        "import { x, y } from './barrel.js';",
        'export const __wywPreval = {',
        '  sum: () => x + y,',
        '};',
      ].join('\n')
    );

    // Session 2: imports only x → broker can serve serialized exports
    const entryB = join(root, 'entry-b.js');
    writeFileSync(
      entryB,
      [
        "import { x } from './barrel.js';",
        'export const __wywPreval = {',
        '  val: () => x,',
        '};',
      ].join('\n')
    );

    // Session 3: imports both x and y again → must not fail
    const entryC = join(root, 'entry-c.js');
    writeFileSync(
      entryC,
      [
        "import { x, y } from './barrel.js';",
        'export const __wywPreval = {',
        '  diff: () => y - x,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entryA);
    const broker = new EvalBroker(services, asyncResolve);

    const epA = Entrypoint.createRoot(
      services,
      entryA,
      ['__wywPreval'],
      readFileSync(entryA, 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('sum')).toBe(30);

    const epB = Entrypoint.createRoot(
      services,
      entryB,
      ['__wywPreval'],
      readFileSync(entryB, 'utf-8')
    );
    const resultB = await broker.evaluate(epB);
    expect(resultB.values?.get('val')).toBe(10);

    const epC = Entrypoint.createRoot(
      services,
      entryC,
      ['__wywPreval'],
      readFileSync(entryC, 'utf-8')
    );
    const resultC = await broker.evaluate(epC);
    expect(resultC.values?.get('diff')).toBe(10);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not create narrow SyntheticModule when barrel re-exports more than importer needs', async () => {
    // Reproduces the real-world failure: design-system.ts (barrel) re-exports
    // fontFamily+fontWeight+textStyles from typography.ts. Session A evaluates
    // the full chain. Session B's entrypoint only needs fontWeight+textStyles,
    // so the broker may serve serialized exports for typography with just those
    // 2 keys. But the barrel's SourceTextModule still has
    // `import { fontFamily, fontWeight, textStyles } from './typography.js'`
    // — it needs fontFamily too. If the runner creates a narrow SyntheticModule
    // for typography, the barrel's link fails.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const typography = join(root, 'typography.js');
    writeFileSync(
      typography,
      [
        'export const fontFamily = "sans-serif";',
        'export const fontWeight = 400;',
        'export const textStyles = { body: "14px" };',
      ].join('\n')
    );

    const barrel = join(root, 'barrel.js');
    writeFileSync(
      barrel,
      [
        "export { fontFamily, fontWeight, textStyles } from './typography.js';",
        'export const layout = { gap: 8 };',
      ].join('\n')
    );

    // Session A: imports fontFamily + fontWeight + textStyles from barrel
    // → typography.js is prepared with all 3 exports, evaluated as variant
    const entryA = join(root, 'entry-a.js');
    writeFileSync(
      entryA,
      [
        "import { fontFamily, fontWeight, textStyles } from './barrel.js';",
        'export const __wywPreval = {',
        '  font: () => `${fontFamily} ${fontWeight} ${JSON.stringify(textStyles)}`,',
        '};',
      ].join('\n')
    );

    // Session B: imports only fontWeight + textStyles from barrel
    // → broker may serve serialized exports for typography (only fontWeight, textStyles)
    // → barrel's code still imports fontFamily from typography → must not fail
    const entryB = join(root, 'entry-b.js');
    writeFileSync(
      entryB,
      [
        "import { fontWeight, textStyles } from './barrel.js';",
        'export const __wywPreval = {',
        '  weight: () => fontWeight,',
        '};',
      ].join('\n')
    );

    // Session C: imports fontFamily again → must not fail
    const entryC = join(root, 'entry-c.js');
    writeFileSync(
      entryC,
      [
        "import { fontFamily, fontWeight } from './barrel.js';",
        'export const __wywPreval = {',
        '  info: () => `${fontFamily}/${fontWeight}`,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entryA, {
      features: { staticImportValues: true },
    });
    const broker = new EvalBroker(services, asyncResolve);

    const epA = Entrypoint.createRoot(
      services,
      entryA,
      ['__wywPreval'],
      readFileSync(entryA, 'utf-8')
    );
    const resultA = await broker.evaluate(epA);
    expect(resultA.values?.get('font')).toMatchInlineSnapshot(
      `"sans-serif 400 {"body":"14px"}"`
    );

    const epB = Entrypoint.createRoot(
      services,
      entryB,
      ['__wywPreval'],
      readFileSync(entryB, 'utf-8')
    );
    const resultB = await broker.evaluate(epB);
    expect(resultB.values?.get('weight')).toBe(400);

    const epC = Entrypoint.createRoot(
      services,
      entryC,
      ['__wywPreval'],
      readFileSync(entryC, 'utf-8')
    );
    const resultC = await broker.evaluate(epC);
    expect(resultC.values?.get('info')).toMatchInlineSnapshot(
      `"sans-serif/400"`
    );

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not reuse a narrower evaluated variant for wider serialized exports', async () => {
    // Mirrors the 4df6e915 Fibery dump:
    //
    // 1. typography.js is evaluated as a narrow variant with fontWeight only.
    // 2. typography.js is evaluated as a wider variant with fontFamily,
    //    fontWeight and textStyles.
    // 3. A later load gets serialized exports for that wider set, with a hash
    //    that is not itself cached as a SourceTextModule variant.
    //
    // The runner must not satisfy step 3 by returning the first evaluated
    // variant for the source path if that variant lacks the serialized export
    // set.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const typography = join(root, 'typography.js');
    const entryNarrow = join(root, 'entry-narrow.js');
    const entryWide = join(root, 'entry-wide.js');
    const entrySerializedWide = join(root, 'entry-serialized-wide.js');

    writeFileSync(
      entryNarrow,
      [
        "import { fontWeight } from './typography.js';",
        'export const __wywPreval = {',
        '  value: () => fontWeight,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      entryWide,
      [
        "import { fontFamily, fontWeight, textStyles } from './typography.js';",
        'export const __wywPreval = {',
        '  value: () => `${fontFamily}:${fontWeight}:${textStyles.body}`,',
        '};',
      ].join('\n')
    );
    writeFileSync(
      entrySerializedWide,
      [
        "import { fontFamily, fontWeight, textStyles } from './typography.js';",
        'export const __wywPreval = {',
        '  value: () => `${fontFamily}/${fontWeight}/${textStyles.body}`,',
        '};',
      ].join('\n')
    );

    const asyncResolve = jest.fn(async (what: string, importer: string) => {
      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }
      return null;
    });
    const services = createServices(root, entryNarrow, {
      features: { staticImportValues: true },
    });
    const broker = new EvalBroker(services, asyncResolve);
    const privateBroker = getPrivateBroker(broker);
    const originalLoadModule = privateBroker.loadModule.bind(privateBroker);
    const loadCalls: Array<{
      id: string;
      importerId?: string | null;
      request?: string | null;
    }> = [];

    privateBroker.loadModule = jest.fn(async (payload) => {
      loadCalls.push(payload);

      const withImports = (
        id: string,
        result: {
          code: string;
          imports: Map<string, string[]> | null;
          only: string[];
          hash: string;
          exports?: Record<string, ReturnType<typeof serializeValue>>;
        }
      ) => {
        privateBroker.ensureImportsMapping(id, result.imports);
        return result;
      };

      if (payload.id === entryNarrow) {
        return withImports(entryNarrow, {
          code: readFileSync(entryNarrow, 'utf-8'),
          imports: new Map([['./typography.js', ['fontWeight']]]),
          only: ['__wywPreval'],
          hash: 'entry-narrow',
        });
      }

      if (payload.id === entryWide) {
        return withImports(entryWide, {
          code: readFileSync(entryWide, 'utf-8'),
          imports: new Map([
            ['./typography.js', ['fontFamily', 'fontWeight', 'textStyles']],
          ]),
          only: ['__wywPreval'],
          hash: 'entry-wide',
        });
      }

      if (payload.id === entrySerializedWide) {
        return withImports(entrySerializedWide, {
          code: readFileSync(entrySerializedWide, 'utf-8'),
          imports: new Map([
            ['./typography.js', ['fontFamily', 'fontWeight', 'textStyles']],
          ]),
          only: ['__wywPreval'],
          hash: 'entry-serialized-wide',
        });
      }

      if (payload.id === typography && payload.importerId === entryNarrow) {
        return withImports(typography, {
          code: 'export const fontWeight = 400;',
          imports: null,
          only: ['fontWeight'],
          hash: 'typography-narrow-font-weight',
        });
      }

      if (payload.id === typography && payload.importerId === entryWide) {
        return withImports(typography, {
          code: [
            'export const fontFamily = "Inter";',
            'export const fontWeight = 400;',
            'export const textStyles = { body: "14px" };',
          ].join('\n'),
          imports: null,
          only: ['fontFamily', 'fontWeight', 'textStyles'],
          hash: 'typography-wide-source',
        });
      }

      if (
        payload.id === typography &&
        payload.importerId === entrySerializedWide
      ) {
        return withImports(typography, {
          code: '',
          imports: null,
          only: ['fontFamily', 'fontWeight', 'textStyles'],
          hash: 'typography-wide-serialized-exports',
          exports: {
            fontFamily: serializeValue('Inter'),
            fontWeight: serializeValue(400),
            textStyles: serializeValue({ body: '14px' }),
          },
        });
      }

      return originalLoadModule(payload);
    });

    try {
      const narrow = Entrypoint.createRoot(
        services,
        entryNarrow,
        ['__wywPreval'],
        readFileSync(entryNarrow, 'utf-8')
      );
      const narrowResult = await broker.evaluate(narrow);
      expect(narrowResult.values?.get('value')).toBe(400);

      const wide = Entrypoint.createRoot(
        services,
        entryWide,
        ['__wywPreval'],
        readFileSync(entryWide, 'utf-8')
      );
      const wideResult = await broker.evaluate(wide);
      expect(wideResult.values?.get('value')).toBe('Inter:400:14px');

      const serializedWide = Entrypoint.createRoot(
        services,
        entrySerializedWide,
        ['__wywPreval'],
        readFileSync(entrySerializedWide, 'utf-8')
      );
      const serializedWideResult = await broker.evaluate(serializedWide);
      expect(serializedWideResult.values?.get('value')).toBe(
        'Inter/400/14px'
      );
      expect(loadCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: typography,
            importerId: entrySerializedWide,
          }),
        ])
      );
    } finally {
      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps wide barrel dependency imports when a later narrow variant finishes', async () => {
    // Models the Fibery failure shape:
    //
    // - design-system.ts is a barrel that can be prepared as multiple variants.
    // - A wide variant imports fontFamily/fontWeight/textStyles from typography.
    // - A later narrow variant of the same source imports only fontWeight.
    // - Because importsByModule is keyed only by source path, the narrow map can
    //   replace the wide map while the wide SourceTextModule is still linking.
    // - When that wide module then loads typography, the dependency must still
    //   be prepared with the wide export set.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));

    const entry = join(root, 'entry.js');
    const barrel = join(root, 'design-system.js');
    const typography = join(root, 'typography.js');
    const theme = join(root, 'theme.js');

    writeFileSync(
      theme,
      [
        'export const themeVars = globalThis.__wywThemeVars || { text: "black" };',
      ].join('\n')
    );
    writeFileSync(
      typography,
      [
        "import { themeVars } from './theme.js';",
        'export const fontFamily = "Inter";',
        'export const fontWeight = 400;',
        'export const textStyles = { body: themeVars.text };',
      ].join('\n')
    );
    writeFileSync(
      barrel,
      [
        "export { fontFamily, fontWeight, textStyles } from './typography.js';",
      ].join('\n')
    );
    writeFileSync(
      entry,
      [
        "import { fontFamily, fontWeight, textStyles } from './design-system.js';",
        'export const __wywPreval = {',
        '  value: () => `${fontFamily}:${fontWeight}:${textStyles.body}`,',
        '};',
      ].join('\n')
    );

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => null)
    );
    const privateBroker = getPrivateBroker(broker);

    privateBroker.importsByModule.set(
      entry,
      new Map([
        ['./design-system.js', ['fontFamily', 'fontWeight', 'textStyles']],
      ])
    );

    const wideBarrel = await privateBroker.loadModule({
      id: barrel,
      importerId: entry,
      request: './design-system.js',
    });

    expect(wideBarrel.imports?.get('./typography.js')).toEqual([
      'fontFamily',
      'fontWeight',
      'textStyles',
    ]);

    // Simulate a concurrent/narrow barrel variant completing after the wide
    // variant. Current code replaces the source-path import map with this
    // narrower map, which can make the still-linking wide variant load a
    // typography module that is missing fontFamily/textStyles.
    privateBroker.ensureImportsMapping(
      barrel,
      new Map([['./typography.js', ['fontWeight']]])
    );

    const typographyForWideBarrel = await privateBroker.loadModule({
      id: typography,
      importerId: barrel,
      request: './typography.js',
    });

    expect(typographyForWideBarrel.only).toEqual(
      expect.arrayContaining(['fontFamily', 'fontWeight', 'textStyles'])
    );
    expect(typographyForWideBarrel.code).toContain('fontFamily');
    expect(typographyForWideBarrel.code).toContain('textStyles');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('skips re-shipping LoadResult code when runner already has matching hash', async () => {
    // Multiple importers asking for the same dependency in one runner session
    // produce identical prepared variants (same hash, same `only`). The first
    // LOAD must ship code; subsequent LOADs must ship `code: ''` so the
    // runner's hash-match short-circuit (runner.js:1834) reuses its cached
    // SourceTextModule instead of re-parsing identical bytes.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const importerA = join(root, 'a.js');
    const importerB = join(root, 'b.js');
    const dep = join(root, 'dep.js');

    const customLoader = jest.fn(async () => ({
      code: 'export const value = 1;',
    }));
    const services = createServices(root, importerA, {
      eval: { customLoader },
    });

    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = broker as unknown as {
      handleLoad: (
        id: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      onlyByModule: Map<string, string[]>;
      runnerInputQueue: unknown;
      sendMessage: (message: unknown) => Promise<void>;
    };

    type CapturedLoadResult = {
      id: string;
      payload: { code?: string; hash?: string; only?: string[] };
    };
    const captured: CapturedLoadResult[] = [];
    privateBroker.runnerInputQueue = {
      write: () => Promise.resolve(),
    };
    privateBroker.sendMessage = async (message: unknown) => {
      const m = message as { type: string } & CapturedLoadResult;
      if (m.type === 'LOAD_RESULT') {
        captured.push({ id: m.id, payload: m.payload });
      }
    };

    privateBroker.onlyByModule.set(dep, ['*']);

    await privateBroker.handleLoad('msg-1', {
      id: dep,
      importerId: importerA,
      request: null,
    });
    await privateBroker.handleLoad('msg-2', {
      id: dep,
      importerId: importerB,
      request: null,
    });

    expect(captured).toHaveLength(2);
    const [first, second] = captured;
    expect(first.payload.code).toBe('export const value = 1;');
    expect(first.payload.hash).toBeTruthy();
    expect(second.payload.code).toBe('');
    expect(second.payload.hash).toBe(first.payload.hash);

    // Third LOAD with a wider `only` (forces a new prepared variant via the
    // loadCache miss path) must ship code again.
    const widerLoader = jest.fn(async () => ({
      code: 'export const value = 1;\nexport const extra = 2;',
    }));
    services.options.pluginOptions.eval = { customLoader: widerLoader };
    privateBroker.onlyByModule.set(dep, ['*', 'extra']);

    await privateBroker.handleLoad('msg-3', {
      id: dep,
      importerId: importerA,
      request: null,
    });

    expect(captured).toHaveLength(3);
    expect(captured[2].payload.code).toContain('extra');
    expect(captured[2].payload.hash).not.toBe(first.payload.hash);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not carry shipped-code coverage across different load hashes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entry = join(root, 'entry.js');
    const dep = join(root, 'dep.js');
    writeFileSync(entry, 'export const __wywPreval = {};');

    const services = createServices(root, entry);
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = broker as unknown as {
      handleLoad: (
        id: string,
        payload: {
          id: string;
          importerId: string | null;
          request: string | null;
        }
      ) => Promise<void>;
      loadModule: jest.Mock;
      runnerInputQueue: unknown;
      sendMessage: (message: unknown) => Promise<void>;
    };

    type CapturedLoadResult = {
      id: string;
      payload: { code?: string; hash?: string; only?: string[] };
    };
    const captured: CapturedLoadResult[] = [];
    privateBroker.runnerInputQueue = {
      write: () => Promise.resolve(),
    };
    privateBroker.sendMessage = async (message: unknown) => {
      const m = message as { type: string } & CapturedLoadResult;
      if (m.type === 'LOAD_RESULT') {
        captured.push({ id: m.id, payload: m.payload });
      }
    };

    privateBroker.loadModule = jest
      .fn()
      .mockResolvedValueOnce({
        code: 'export const first = 1;',
        imports: null,
        only: ['*'],
        hash: 'hash-a',
      })
      .mockResolvedValueOnce({
        code: 'export const value = 1;',
        imports: null,
        only: ['value'],
        hash: 'hash-b',
      })
      .mockResolvedValueOnce({
        code: 'export const value = 1;',
        imports: null,
        only: ['*'],
        hash: 'hash-b',
      });

    await privateBroker.handleLoad('msg-1', {
      id: dep,
      importerId: entry,
      request: null,
    });
    await privateBroker.handleLoad('msg-2', {
      id: dep,
      importerId: entry,
      request: null,
    });
    await privateBroker.handleLoad('msg-3', {
      id: dep,
      importerId: entry,
      request: null,
    });

    expect(captured).toHaveLength(3);
    expect(captured[0].payload.code).toContain('first');
    expect(captured[1].payload.code).toContain('value');
    // The second load stored hash-b as a module variant. The prior wildcard
    // coverage from hash-a must not make the broker believe hash-b also exists
    // in the runner's primary module cache.
    expect(captured[2].payload.code).toContain('value');

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps shipped-code mirror across evaluate() boundaries with stable globals/happyDOM', async () => {
    // Real workflows reuse the runner across many entrypoints. The runner
    // only resets its moduleCache when globals or happyDOM change
    // (runner.js:2116). When those are stable, INIT just rebinds entrypoint
    // metadata and the runner keeps every cached module — so the broker's
    // shipped-code mirror must survive cross-entrypoint INITs.
    const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
    const entryA = join(root, 'a.js');
    const entryB = join(root, 'b.js');
    const dep = join(root, 'dep.js');
    writeFileSync(entryA, 'export const __wywPreval = {};');
    writeFileSync(entryB, 'export const __wywPreval = {};');

    const customLoader = jest.fn(async () => ({
      code: 'export const value = 1;',
    }));
    const services = createServices(root, entryA, {
      eval: { customLoader },
    });
    const broker = new EvalBroker(
      services,
      jest.fn(async () => dep)
    );
    const privateBroker = broker as unknown as {
      ensureRunner: () => Promise<void>;
      handleLoad: (
        id: string,
        payload: { id: string; importerId: string | null; request: string | null }
      ) => Promise<void>;
      initRunner: (entrypoint: Entrypoint) => Promise<void>;
      lastInitKey: string | null;
      lastHappyDomEnabled: boolean;
      lastSentLoadByModule: Map<string, { hash: string; only: string[] }>;
      onlyByModule: Map<string, string[]>;
      request: (
        type: string,
        payload: unknown,
        timeoutMs?: number
      ) => Promise<unknown>;
      runnerInputQueue: unknown;
      sendMessage: (message: unknown) => Promise<void>;
    };
    privateBroker.ensureRunner = jest.fn(async () => {});
    privateBroker.request = jest.fn(async () => ({}));

    type CapturedLoadResult = {
      id: string;
      payload: { code?: string; hash?: string };
    };
    const captured: CapturedLoadResult[] = [];
    privateBroker.runnerInputQueue = {
      write: () => Promise.resolve(),
    };
    privateBroker.sendMessage = async (message: unknown) => {
      const m = message as { type: string } & CapturedLoadResult;
      if (m.type === 'LOAD_RESULT') {
        captured.push({ id: m.id, payload: m.payload });
      }
    };

    privateBroker.onlyByModule.set(dep, ['*']);

    const entrypointA = Entrypoint.createRoot(
      services,
      entryA,
      ['__wywPreval'],
      readFileSync(entryA, 'utf-8')
    );
    const entrypointB = Entrypoint.createRoot(
      services,
      entryB,
      ['__wywPreval'],
      readFileSync(entryB, 'utf-8')
    );

    await privateBroker.initRunner(entrypointA);
    await privateBroker.handleLoad('msg-1', {
      id: dep,
      importerId: entryA,
      request: null,
    });

    // Switch to a different entrypoint — initKey changes but globals/happyDOM
    // are identical, so the runner keeps moduleCache and our mirror must too.
    await privateBroker.initRunner(entrypointB);
    expect(privateBroker.lastSentLoadByModule.size).toBeGreaterThan(0);

    await privateBroker.handleLoad('msg-2', {
      id: dep,
      importerId: entryB,
      request: null,
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].payload.code).toBe('export const value = 1;');
    expect(captured[1].payload.code).toBe('');
    expect(captured[1].payload.hash).toBe(captured[0].payload.hash);

    broker.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  describe('evaluate batching', () => {
    type BatchPrivateBroker = {
      ensureRunner: () => Promise<void>;
      initRunner: (entrypoint: Entrypoint) => Promise<void>;
      onlyByModule: Map<string, string[]>;
      pendingEvals: unknown[];
      request: (
        type: string,
        payload: unknown,
        timeoutMs?: number
      ) => Promise<unknown>;
    };

    const stubBatchInternals = (
      broker: EvalBroker,
      onEval: (id: string) => Promise<{
        values: Record<string, unknown> | null;
        modules?: Record<string, unknown>;
      }>
    ) => {
      const pb = broker as unknown as BatchPrivateBroker;
      pb.ensureRunner = jest.fn(async () => {});
      pb.initRunner = jest.fn(async () => {});
      pb.request = jest.fn(async (type, payload) => {
        if (type !== 'EVAL') {
          throw new Error(`unexpected request type: ${type}`);
        }
        const { id } = payload as { id: string };
        return onEval(id);
      });
      return pb;
    };

    it('coalesces concurrent evaluate() calls into one runner pass', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entries = ['a', 'b', 'c'].map((n) => join(root, `${n}.js`));
      entries.forEach((p) => writeFileSync(p, 'export const __wywPreval = {};'));

      const services = createServices(root, entries[0]);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoints = entries.map((p) =>
        Entrypoint.createRoot(services, p, ['__wywPreval'], readFileSync(p, 'utf-8'))
      );

      const evalOrder: string[] = [];
      const onlySnapshots: Record<string, string[] | undefined> = {};
      const pb = stubBatchInternals(broker, async (id) => {
        evalOrder.push(id);
        // Capture the broker's onlyByModule for this entrypoint at the moment
        // EVAL is sent — proves per-entrypoint state-clear runs between
        // members of the batch.
        onlySnapshots[id] = pb.onlyByModule.get(id);
        return {
          values: { v: serializeValue(`from-${id}`, { allowFunctions: true }) },
        };
      });

      const initSpy = pb.initRunner as jest.Mock;
      const ensureSpy = pb.ensureRunner as jest.Mock;

      const promises = entrypoints.map((ep) => broker.evaluate(ep));
      const results = await Promise.all(promises);

      expect(evalOrder).toEqual(entries);
      results.forEach((r, i) => {
        expect(r.values?.get('v')).toBe(`from-${entries[i]}`);
      });
      entries.forEach((p) => {
        expect(onlySnapshots[p]).toEqual(['__wywPreval']);
      });
      // One ensureRunner across the batch; initRunner still per-member
      // (cheap on the runner side via canReuseContext).
      expect(ensureSpy).toHaveBeenCalledTimes(1);
      expect(initSpy).toHaveBeenCalledTimes(3);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('isolates batch-member failures', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entries = ['a', 'b', 'c'].map((n) => join(root, `${n}.js`));
      entries.forEach((p) => writeFileSync(p, 'export const __wywPreval = {};'));

      const services = createServices(root, entries[0]);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoints = entries.map((p) =>
        Entrypoint.createRoot(services, p, ['__wywPreval'], readFileSync(p, 'utf-8'))
      );

      stubBatchInternals(broker, async (id) => {
        if (id === entries[1]) {
          throw new Error('middle-fail');
        }
        return { values: { v: serializeValue(id, { allowFunctions: true }) } };
      });

      const settled = await Promise.allSettled(
        entrypoints.map((ep) => broker.evaluate(ep))
      );
      expect(settled[0].status).toBe('fulfilled');
      expect(settled[1].status).toBe('rejected');
      expect(settled[2].status).toBe('fulfilled');
      if (settled[1].status === 'rejected') {
        expect(String(settled[1].reason)).toContain('middle-fail');
      }

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });

    it('single evaluate() call still runs (batch of one is a no-op)', async () => {
      const root = mkdtempSync(join(tmpdir(), 'wyw-eval-broker-'));
      const entry = join(root, 'a.js');
      writeFileSync(entry, 'export const __wywPreval = {};');

      const services = createServices(root, entry);
      const broker = new EvalBroker(
        services,
        jest.fn(async () => null)
      );
      const entrypoint = Entrypoint.createRoot(
        services,
        entry,
        ['__wywPreval'],
        readFileSync(entry, 'utf-8')
      );

      stubBatchInternals(broker, async (id) => ({
        values: { v: serializeValue(id, { allowFunctions: true }) },
      }));

      const result = await broker.evaluate(entrypoint);
      expect(result.values?.get('v')).toBe(entry);

      broker.dispose();
      rmSync(root, { recursive: true, force: true });
    });
  });
});
