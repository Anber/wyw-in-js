import * as babel from '@babel/core';
import {
  mkdirSync,
  mkdtempSync,
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
import { EvalBroker } from '../eval/broker';

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

const getPrivateBroker = (broker: EvalBroker) =>
  broker as unknown as {
    happyDomDisabled: boolean;
    initIsolatedRunner: (
      payload: unknown,
      timeoutMs: number
    ) => Promise<unknown>;
    initRunner: (entrypoint: Entrypoint) => Promise<void>;
    importsByModule: Map<string, Map<string, string[]>>;
    lastHappyDomEnabled: boolean;
    lastInitKey: string | null;
    loadModule: (payload: {
      id: string;
      importerId?: string | null;
      request?: string | null;
    }) => Promise<{
      code: string;
      imports: Map<string, string[]> | null;
      only: string[];
    }>;
    onlyByModule: Map<string, string[]>;
    resolveImport: (payload: {
      importerId: string;
      kind: 'import' | 'dynamic-import' | 'require';
      specifier: string;
    }) => Promise<{ resolvedId: string | null }>;
    request: (
      type: 'INIT' | 'EVAL',
      payload: unknown,
      timeoutMs?: number
    ) => Promise<unknown>;
    runner: unknown;
  };

describe('EvalBroker', () => {
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

  it('strips browser globals from prepared output for __wywPreval-only loads', async () => {
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

    expect(loaded.code).not.toContain('document');
    expect(loaded.code).not.toContain('window');

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

    it('does not reuse non-serializable dependency modules across entrypoints when overrideContext is enabled', async () => {
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

      expect(result.values?.get('value')).toBe(42);
      expect(cachedDep).toBeDefined();
      expect(cachedDep?.exports?.serializable).toBe(41);
      expect(cachedDep?.exports && 'skipped' in cachedDep.exports).toBe(false);

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
      writeFileSync(unused, 'throw new Error("unused export should stay cold");');
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
});
