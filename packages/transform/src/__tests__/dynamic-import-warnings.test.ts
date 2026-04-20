import { readFileSync } from 'fs';
import { join } from 'path';

import * as babel from '@babel/core';

import { shaker } from '../shaker';
import { Entrypoint } from '../transform/Entrypoint';
import { parseFile } from '../transform/Entrypoint.helpers';
import { prepareCode } from '../transform/generators/transform';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';

const rules = [
  {
    test: () => true,
    action: shaker,
  },
];

const pluginOptions = loadWywOptions({
  configFile: false,
  rules,
  babelOptions: {
    babelrc: false,
    configFile: false,
    presets: [
      ['@babel/preset-env', { loose: true }],
      '@babel/preset-react',
      '@babel/preset-typescript',
    ],
  },
});

const pluginOptionsWithGlobOverrides = loadWywOptions({
  configFile: false,
  rules,
  babelOptions: {
    babelrc: false,
    configFile: false,
    presets: [
      ['@babel/preset-env', { loose: true }],
      '@babel/preset-react',
      '@babel/preset-typescript',
    ],
  },
  importOverrides: {
    '@uiw/*': {
      mock: './src/__mocks__/uiw-react-codemirror.ts',
    },
  },
});

describe('dynamic import warnings', () => {
  const originalWarningsFlag = process.env.WYW_WARN_DYNAMIC_IMPORTS;

  afterEach(() => {
    if (originalWarningsFlag === undefined) {
      delete process.env.WYW_WARN_DYNAMIC_IMPORTS;
    } else {
      process.env.WYW_WARN_DYNAMIC_IMPORTS = originalWarningsFlag;
    }
  });

  it('includes importOverrides mock hint', () => {
    process.env.WYW_WARN_DYNAMIC_IMPORTS = '1';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = join(
        __dirname,
        '__fixtures__',
        'prepare-code-test-cases',
        'dynamic-import'
      );
      const inputFilePath = join(root, 'input.ts');
      const input = readFileSync(inputFilePath, 'utf8');
      const [firstLine, ...restLines] = input.split('\n');
      const only = firstLine
        .slice(2)
        .split(',')
        .map((s) => s.trim());

      const sourceCode = restLines.join('\n');
      const services = withDefaultServices({
        babel,
        options: { root, filename: inputFilePath, pluginOptions },
      });
      const entrypoint = Entrypoint.createRoot(
        services,
        inputFilePath,
        only,
        sourceCode
      );

      if (entrypoint.ignored) {
        throw new Error('Unexpected ignored entrypoint in test fixture');
      }

      const ast = parseFile(babel, inputFilePath, sourceCode, {
        root,
      });

      prepareCode(services, entrypoint, ast);

      const warning = warnSpy.mock.calls
        .map((call) => String(call[0]))
        .find((message) =>
          message.includes('Dynamic imports reached prepare stage')
        );

      expect(warning).toContain('importOverrides');
      expect(warning).toContain("mock: './path/to/mock'");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when dynamic import is overridden', () => {
    process.env.WYW_WARN_DYNAMIC_IMPORTS = '1';

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const root = __dirname;
      const inputFilePath = join(root, 'inline.ts');
      const sourceCode = `
export function foo() {
  import('@uiw/react-codemirror');
}
`;
      const services = withDefaultServices({
        babel,
        options: {
          root,
          filename: inputFilePath,
          pluginOptions: pluginOptionsWithGlobOverrides,
        },
      });
      const entrypoint = Entrypoint.createRoot(
        services,
        inputFilePath,
        ['*'],
        sourceCode
      );

      if (entrypoint.ignored) {
        throw new Error('Unexpected ignored entrypoint in test');
      }

      const ast = parseFile(babel, inputFilePath, sourceCode, {
        root,
      });

      prepareCode(services, entrypoint, ast);

      const hasDynamicImportWarning = warnSpy.mock.calls.some((call) =>
        String(call[0]).includes('Dynamic imports reached prepare stage')
      );
      expect(hasDynamicImportWarning).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
