import fs from 'fs';
import os from 'os';
import path from 'path';

import * as babel from '@babel/core';
import dedent from 'dedent';

import { logger } from '@wyw-in-js/shared';
import type { StrictOptions } from '@wyw-in-js/shared';

import { TransformCacheCollection } from '../cache';
import { Module } from '../module';
import { Entrypoint } from '../transform/Entrypoint';
import type { LoadAndParseFn } from '../transform/Entrypoint.types';
import type { Services } from '../transform/types';
import { EventEmitter } from '../utils/EventEmitter';

const pluginOptions: StrictOptions = {
  babelOptions: {
    babelrc: false,
    configFile: false,
    presets: [
      ['@babel/preset-env', { loose: true }],
      '@babel/preset-typescript',
    ],
  },
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
  rules: [],
};

const createServices = (
  cache: TransformCacheCollection,
  filename: string
): Services => {
  const loadAndParseFn: LoadAndParseFn = (services, name, loadedCode) => ({
    get ast() {
      return services.babel.parseSync(loadedCode ?? '', {
        filename: name,
        presets: [
          ['@babel/preset-env', { loose: true }],
          '@babel/preset-typescript',
        ],
      })!;
    },
    code: loadedCode!,
    evaluator: jest.fn(),
    evalConfig: {},
  });

  return {
    babel,
    cache,
    emitWarning: jest.fn(),
    loadAndParseFn,
    log: logger,
    eventEmitter: EventEmitter.dummy,
    options: {
      filename,
      pluginOptions,
    },
  };
};

const createErrnoError = (
  code: string,
  message = code
): NodeJS.ErrnoException => {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
};

describe('stale dependency detection in watch mode', () => {
  it('getEntrypoint detects stale evaluated entrypoint when file changed on disk', () => {
    // Directly tests the getEntrypoint short-circuit at module.ts:477.
    // When an entrypoint is cached as evaluated with sufficient evaluatedOnly,
    // getEntrypoint should re-read the file from disk to verify freshness
    // before returning the cached result.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-getep-'));
    const parentFile = path.join(root, 'parent.ts');
    const depFile = path.join(root, 'dep.ts');

    fs.writeFileSync(depFile, dedent`export const val = 'old';`);
    fs.writeFileSync(
      parentFile,
      dedent`
        import { val } from './dep';
        export const result = val;
      `
    );

    const cache = new TransformCacheCollection();

    // Create and evaluate dep (simulates a previous compilation)
    const depServices = createServices(cache, depFile);
    const depCode = fs.readFileSync(depFile, 'utf-8');
    const depEntrypoint = Entrypoint.createRoot(
      depServices,
      depFile,
      ['val'],
      depCode
    );
    depEntrypoint.setTransformResult({
      code: '"use strict";\nexports.val = "old";',
      metadata: null,
    });

    const depModule = new Module(depServices, depEntrypoint);
    depModule.evaluate();
    depEntrypoint.createEvaluated();

    // Verify dep is cached as evaluated
    const cachedDep = cache.get('entrypoints', depFile);
    expect(cachedDep?.evaluated).toBe(true);

    // Change dep on disk
    fs.writeFileSync(depFile, dedent`export const val = 'new';`);

    // Create a parent module that will call getEntrypoint for dep
    const parentServices = createServices(cache, parentFile);
    const parentCode = fs.readFileSync(parentFile, 'utf-8');
    const parentEntrypoint = Entrypoint.createRoot(
      parentServices,
      parentFile,
      ['result'],
      parentCode
    );
    parentEntrypoint.setTransformResult({
      code: '"use strict";\nvar _dep = require("./dep");\nexports.result = _dep.val;',
      metadata: null,
    });
    const parentModule = new Module(parentServices, parentEntrypoint);

    // getEntrypoint should detect the dep changed on disk
    // Without fix: returns stale evaluated entrypoint (evaluated=true)
    // With fix: invalidates stale entry, falls through to re-read from disk
    const result = parentModule.getEntrypoint(depFile, ['val'], logger);
    expect(result?.evaluated).toBe(false);
  });

  it('getEntrypoint returns cached entrypoint when file unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-getep-fresh-'));
    const parentFile = path.join(root, 'parent.ts');
    const depFile = path.join(root, 'dep.ts');

    fs.writeFileSync(depFile, dedent`export const val = 'same';`);
    fs.writeFileSync(
      parentFile,
      dedent`
        import { val } from './dep';
        export const result = val;
      `
    );

    const cache = new TransformCacheCollection();

    const depServices = createServices(cache, depFile);
    const depCode = fs.readFileSync(depFile, 'utf-8');
    const depEntrypoint = Entrypoint.createRoot(
      depServices,
      depFile,
      ['val'],
      depCode
    );
    depEntrypoint.setTransformResult({
      code: '"use strict";\nexports.val = "same";',
      metadata: null,
    });

    const depModule = new Module(depServices, depEntrypoint);
    depModule.evaluate();
    depEntrypoint.createEvaluated();

    // File unchanged on disk — should return the cached evaluated entrypoint
    const parentServices = createServices(cache, parentFile);
    const parentCode = fs.readFileSync(parentFile, 'utf-8');
    const parentEntrypoint = Entrypoint.createRoot(
      parentServices,
      parentFile,
      ['result'],
      parentCode
    );
    parentEntrypoint.setTransformResult({
      code: '"use strict";\nvar _dep = require("./dep");\nexports.result = _dep.val;',
      metadata: null,
    });
    const parentModule = new Module(parentServices, parentEntrypoint);

    const result = parentModule.getEntrypoint(depFile, ['val'], logger);
    expect(result?.evaluated).toBe(true);
  });

  it('checkFreshness rethrows non-missing filesystem errors', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-getep-eacces-'));
    const depFile = path.join(root, 'dep.ts');

    fs.writeFileSync(depFile, dedent`export const val = 'same';`);

    const cache = new TransformCacheCollection();
    cache.add('entrypoints', depFile, {
      name: depFile,
      initialCode: 'export const val = "same";',
      dependencies: new Map(),
      invalidationDependencies: new Map(),
      invalidateOnDependencyChange: new Set(),
      generation: 1,
      evaluated: true,
      evaluatedOnly: ['val'],
      only: ['val'],
      ignored: false,
      exports: {},
      log: logger,
    } as any);

    const eacces = createErrnoError(
      'EACCES',
      `EACCES: permission denied, stat '${depFile}'`
    );
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation((pathArg) => {
      if (pathArg === depFile) {
        throw eacces;
      }

      throw new Error(`Unexpected statSync call: ${String(pathArg)}`);
    });

    try {
      expect(() => cache.checkFreshness(depFile, depFile)).toThrow(eacces);
      expect(cache.has('entrypoints', depFile)).toBe(true);
    } finally {
      statSpy.mockRestore();
    }
  });
});
