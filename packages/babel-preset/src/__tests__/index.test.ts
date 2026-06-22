import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import * as babel from '@babel/core';

import wywInJS from '../index';

const processorPath = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'transform',
  'src',
  '__tests__',
  '__fixtures__',
  'test-css-processor.js'
);

const extractCssText = (result: babel.BabelFileResult | null): string => {
  const processors = result?.metadata?.wywInJS?.processors ?? [];

  return processors
    .flatMap((processor) => processor.artifacts ?? [])
    .filter((artifact) => artifact[0] === 'css')
    .flatMap((artifact) => Object.values(artifact[1][0] ?? {}))
    .map((rule) => String((rule as { cssText?: unknown }).cssText ?? ''))
    .join('\n');
};

const runTransform = (
  code: string,
  filename: string,
  pluginOptions: Record<string, unknown>
) =>
  babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    presets: [[wywInJS, pluginOptions]],
    root: path.dirname(filename),
    sourceType: 'module',
  });

describe('@wyw-in-js/babel-preset Oxc compatibility wrapper', () => {
  it('warns once that the preset is a deprecated compatibility wrapper', () => {
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});

    try {
      runTransform('export const answer = 42;', '/tmp/wyw-babel-warning-a.js', {
        configFile: false,
      });
      runTransform('export const answer = 21;', '/tmp/wyw-babel-warning-b.js', {
        configFile: false,
      });

      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
      expect(String(emitWarningSpy.mock.calls[0][0])).toContain(
        'deprecated compatibility wrapper'
      );
    } finally {
      emitWarningSpy.mockRestore();
    }
  });

  it('loads function-valued config file options inside the sync runner', () => {
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-babel-preset-'));
    const entryFile = path.join(root, 'entry.js');
    const configFile = path.join(root, 'wyw-in-js.config.mjs');

    writeFileSync(
      configFile,
      [
        'export default {',
        '  tagResolver(source, tag) {',
        `    if (source === 'test-css-processor' && tag === 'css') return ${JSON.stringify(
          processorPath
        )};`,
        '    return null;',
        '  },',
        '  overrideContext(context) {',
        "    return { ...context, THEME_COLOR: 'royalblue' };",
        '  },',
        '};',
        '',
      ].join('\n')
    );

    const code = [
      "import { css } from 'test-css-processor';",
      'export const className = css`',
      '  color: ${THEME_COLOR};',
      '`;',
    ].join('\n');

    try {
      const result = runTransform(code, entryFile, {
        configFile,
      });

      expect(emitWarningSpy).toHaveBeenCalledTimes(1);
      expect(String(emitWarningSpy.mock.calls[0][0])).toContain(
        'loads .mjs/.mts WyW config files synchronously'
      );
      expect(extractCssText(result)).toContain('royalblue');
      expect(result?.code).toContain('export const className =');
      expect(result?.code).not.toContain('css`');
    } finally {
      emitWarningSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects inline non-serializable plugin options with an actionable error', () => {
    expect(() =>
      runTransform('const answer = 42;', '/tmp/babel-inline-option.js', {
        configFile: false,
        eval: {
          customResolver: async () => null,
        },
      })
    ).toThrow('customResolver');

    expect(() =>
      runTransform('const answer = 42;', '/tmp/babel-inline-option.js', {
        configFile: false,
        eval: {
          customResolver: async () => null,
        },
      })
    ).toThrow('Move it into a WyW config file');
  });

  it('supports inline eval.globals through the dedicated payload channel', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-babel-preset-'));
    const entryFile = path.join(root, 'entry.js');
    const configFile = path.join(root, 'wyw-in-js.config.cjs');

    writeFileSync(
      configFile,
      [
        'module.exports = {',
        '  tagResolver(source, tag) {',
        `    if (source === 'test-css-processor' && tag === 'css') return ${JSON.stringify(
          processorPath
        )};`,
        '    return null;',
        '  },',
        '};',
        '',
      ].join('\n')
    );

    const code = [
      "import { css } from 'test-css-processor';",
      'export const className = css`',
      '  color: ${GET_COLOR()};',
      '`;',
    ].join('\n');

    try {
      const result = runTransform(code, entryFile, {
        configFile,
        eval: {
          globals: {
            GET_COLOR: () => 'mediumseagreen',
          },
        },
      });

      expect(extractCssText(result)).toContain('mediumseagreen');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses TypeScript from sibling Babel presets without Babel config discovery', () => {
    const emitWarningSpy = jest
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});
    const code = 'const a: number = 1;\n';
    const filename = '/tmp/wyw-babel-preset-typescript.ts';
    const cases = [
      {
        pluginOptions: { configFile: false },
      },
      {
        pluginOptions: {
          configFile: false,
          features: { useBabelConfigs: false },
        },
      },
    ];

    try {
      cases.forEach(({ pluginOptions }) => {
        const result = babel.transformSync(code, {
          babelrc: false,
          configFile: false,
          filename,
          presets: ['@babel/preset-typescript', [wywInJS, pluginOptions]],
          sourceType: 'module',
        });

        expect(result?.code).toContain('const a = 1;');
        expect(result?.code).not.toContain(': number');
        expect(result?.metadata?.wywInJS).toBeUndefined();
      });
    } finally {
      emitWarningSpy.mockRestore();
    }
  });
});
