/* eslint-env jest */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { getProcessorForImport } from '../processorLookup';
import { loadProcessorManifest, resolveProcessorReference } from '../manifest';

const processorFixturePath = path.resolve(
  __dirname,
  '..',
  '..',
  '__tests__',
  '__fixtures__',
  'test-css-processor.js'
);

const writeJson = (filename: string, value: unknown): void => {
  writeFileSync(filename, JSON.stringify(value, null, 2));
};

describe('processor manifest loader', () => {
  const tempRoots: string[] = [];
  let packageId = 0;

  const createTempRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-processor-manifest-'));
    tempRoots.push(root);
    return root;
  };

  const createManifestPackage = (): { packageName: string; root: string } => {
    const root = createTempRoot();
    const packageName = `test-processor-manifest-${process.pid}-${packageId}`;
    const packageDir = path.join(root, 'node_modules', packageName);
    const distDir = path.join(packageDir, 'dist');

    packageId += 1;

    mkdirSync(distDir, { recursive: true });
    writeJson(path.join(packageDir, 'package.json'), {
      name: packageName,
      main: './index.js',
      'wyw-in-js': {
        tags: {
          css: './dist/css.processor.json',
        },
      },
    });
    writeJson(path.join(distDir, 'css.processor.json'), {
      version: 1,
      name: packageName,
      implementation: './css-processor.js',
      semantics: {
        kind: 'css-template',
        outputs: ['class-name', 'css-text'],
        runtimeDependencies: 'explicit',
        staticInterpolations: ['serializable', 'class-name', 'selector-chain'],
      },
    });
    writeFileSync(
      path.join(distDir, 'css-processor.js'),
      `module.exports = require(${JSON.stringify(processorFixturePath)});\n`
    );
    writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {};\n');

    return { packageName, root };
  };

  afterEach(() => {
    jest.restoreAllMocks();
    tempRoots.splice(0).forEach((root) => {
      rmSync(root, { force: true, recursive: true });
    });
  });

  it('keeps direct JS-like processor references as implementation paths', () => {
    const processorPath = path.join(createTempRoot(), 'processor.js');

    expect(resolveProcessorReference(processorPath)).toEqual({
      implementationPath: processorPath,
      manifest: null,
    });
  });

  it('loads supported manifests without executing the JS implementation', () => {
    const root = createTempRoot();
    const distDir = path.join(root, 'dist');
    const manifestPath = path.join(distDir, 'css.processor.json');
    const implementationPath = path.join(distDir, 'throws-if-required.js');

    mkdirSync(distDir, { recursive: true });
    writeFileSync(
      implementationPath,
      'throw new Error("implementation was executed");\n'
    );
    writeJson(manifestPath, {
      version: 1,
      name: '@wyw-in-js/test-css',
      implementation: './throws-if-required.js',
      tags: ['css'],
      semantics: {
        kind: 'css-template',
      },
    });

    expect(loadProcessorManifest(manifestPath)).toEqual({
      implementationPath,
      manifest: {
        version: 1,
        name: '@wyw-in-js/test-css',
        implementation: './throws-if-required.js',
        tags: ['css'],
        semantics: {
          kind: 'css-template',
        },
      },
    });
  });

  it('rejects malformed supported manifests', () => {
    const root = createTempRoot();
    const missingVersionPath = path.join(
      root,
      'missing-version.processor.json'
    );
    const missingNamePath = path.join(root, 'missing-name.processor.json');
    const unknownFieldPath = path.join(root, 'unknown-field.processor.json');

    writeJson(missingVersionPath, {
      implementation: './processor.js',
    });
    writeJson(missingNamePath, {
      version: 1,
      implementation: './processor.js',
    });
    writeJson(unknownFieldPath, {
      version: 1,
      name: '@wyw-in-js/test-css',
      implementation: './processor.js',
      unsupported: true,
    });

    expect(() => loadProcessorManifest(missingVersionPath)).toThrow(
      'Processor manifest "version" must be a number'
    );
    expect(() => loadProcessorManifest(missingNamePath)).toThrow(
      'Processor manifest "name" must be a string'
    );
    expect(() => loadProcessorManifest(unknownFieldPath)).toThrow(
      'Unknown processor manifest field "unsupported"'
    );
  });

  it('falls back to implementation for unsupported manifest versions with a warning', () => {
    const root = createTempRoot();
    const manifestPath = path.join(root, 'future.processor.json');
    const implementationPath = path.join(root, 'processor.js');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    writeJson(manifestPath, {
      version: 999,
      implementation: './processor.js',
      futureField: true,
    });

    expect(resolveProcessorReference(manifestPath)).toEqual({
      implementationPath,
      manifest: null,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'Unsupported processor manifest version 999'
    );
  });

  it('resolves package tag manifests relative to the package root and implementation relative to the manifest', () => {
    const { packageName, root } = createManifestPackage();

    const [processor, tagSource, manifest] = getProcessorForImport(
      {
        imported: 'css',
        source: packageName,
      },
      path.join(root, 'entry.tsx'),
      { tagResolver: undefined }
    );

    expect(processor?.name).toBe('CssProcessor');
    expect(tagSource).toEqual({
      imported: 'css',
      source: packageName,
    });
    expect(manifest).toEqual(
      expect.objectContaining({
        name: packageName,
        semantics: {
          kind: 'css-template',
          outputs: ['class-name', 'css-text'],
          runtimeDependencies: 'explicit',
          staticInterpolations: [
            'serializable',
            'class-name',
            'selector-chain',
          ],
        },
      })
    );
  });

  it('loads styled-target semantics as manifest metadata', () => {
    const root = createTempRoot();
    const manifestPath = path.join(root, 'styled.processor.json');
    const implementationPath = path.join(root, 'styled-processor.js');

    writeJson(manifestPath, {
      version: 1,
      name: '@wyw-in-js/test-styled',
      implementation: './styled-processor.js',
      tags: ['styled'],
      semantics: {
        kind: 'styled-target',
        targets: ['class-name', 'selector-chain', 'opaque-component'],
      },
    });

    expect(loadProcessorManifest(manifestPath)).toEqual({
      implementationPath,
      manifest: {
        version: 1,
        name: '@wyw-in-js/test-styled',
        implementation: './styled-processor.js',
        tags: ['styled'],
        semantics: {
          kind: 'styled-target',
          targets: ['class-name', 'selector-chain', 'opaque-component'],
        },
      },
    });
  });
});
