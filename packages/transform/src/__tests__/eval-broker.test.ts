import * as babel from '@babel/core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
    resolveImport: (payload: {
      specifier: string;
      importerId: string;
      kind: 'import' | 'dynamic-import' | 'require';
    }) => Promise<{ resolvedId: string | null }>;
    loadModule: (payload: {
      id: string;
      importerId?: string | null;
      request?: string | null;
    }) => Promise<{ code: string }>;
    importsByModule: Map<string, Map<string, string[]>>;
    onlyByModule: Map<string, string[]>;
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
});
