import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

import * as babel from '@babel/core';

import babelTransformPlugin from '../plugins/babel-transform';

const processorPath = path.resolve(
  __dirname,
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
    filename,
    root: path.dirname(filename),
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    plugins: [[babelTransformPlugin, pluginOptions]],
  });

describe('babelTransformPlugin sync runner', () => {
  it('loads function-valued config file options inside the sync runner', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-babel-transform-'));
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

      expect(extractCssText(result)).toContain('royalblue');
    } finally {
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
    ).toThrow('Move it into a config file');
  });

  it('supports inline eval.globals through the dedicated payload channel', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wyw-babel-transform-'));
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
});
