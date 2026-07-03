/* eslint-env jest */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as shared from '@wyw-in-js/shared';

import { getProcessorForImport } from '../processors/processorLookup';

const processorFixturePath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

const createPackageFixture = (packageName: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'wyw-processor-lookup-'));
  const packageDir = path.join(root, 'node_modules', packageName);

  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        main: './index.js',
        'wyw-in-js': {
          tags: {
            css: './processor.js',
          },
        },
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(packageDir, 'processor.js'),
    `module.exports = require(${JSON.stringify(processorFixturePath)});\n`
  );
  writeFileSync(path.join(packageDir, 'index.js'), 'module.exports = {};\n');

  return root;
};

describe('getProcessorForImport', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    tempRoots.splice(0).forEach((root) => {
      rmSync(root, { force: true, recursive: true });
    });
  });

  it('skips package lookup for clearly non-package sources without tagResolver', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');

    const [processor, tagSource] = getProcessorForImport(
      {
        imported: 'css',
        source: '@/styles/textStyles',
      },
      null,
      { tagResolver: undefined }
    );

    expect(processor).toBeNull();
    expect(tagSource).toEqual({
      imported: 'css',
      source: '@/styles/textStyles',
    });
    expect(findPackageJSONSpy).not.toHaveBeenCalled();
  });

  it('still lets tagResolver resolve clearly non-package sources', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');
    const tagResolver = jest.fn(() => processorFixturePath);

    const [processor] = getProcessorForImport(
      {
        imported: 'css',
        source: '@/styles/local-processor',
      },
      '/tmp/source.tsx',
      { tagResolver }
    );

    expect(processor?.name).toBe('CssProcessor');
    expect(tagResolver).toHaveBeenCalledWith(
      '@/styles/local-processor',
      'css',
      expect.objectContaining({
        sourceFile: '/tmp/source.tsx',
      })
    );
    expect(findPackageJSONSpy).not.toHaveBeenCalled();
  });

  it('skips package lookup after a tagResolver miss on non-package sources', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');
    const tagResolver = jest.fn(() => null);

    const [processor] = getProcessorForImport(
      {
        imported: 'css',
        source: './local-styles',
      },
      '/tmp/source.tsx',
      { tagResolver }
    );

    expect(processor).toBeNull();
    expect(tagResolver).toHaveBeenCalledTimes(1);
    expect(findPackageJSONSpy).not.toHaveBeenCalled();
  });

  it('keeps package-backed processor lookup behavior for bare package imports', () => {
    const findPackageJSONSpy = jest.spyOn(shared, 'findPackageJSON');
    const packageName = 'test-package-lookup-contract';
    const root = createPackageFixture(packageName);
    tempRoots.push(root);

    const [processor] = getProcessorForImport(
      {
        imported: 'css',
        source: packageName,
      },
      path.join(root, 'entry.tsx'),
      { tagResolver: undefined }
    );

    expect(processor?.name).toBe('CssProcessor');
    expect(findPackageJSONSpy).toHaveBeenCalledWith(
      packageName,
      path.join(root, 'entry.tsx')
    );
  });
});
