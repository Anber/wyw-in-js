import path from 'path';

import * as babel from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';

import { applyProcessors } from '../utils/getTagProcessor';

const skipSymbolProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'skip-symbol-processor.js'
);

const skipIdentityProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'skip-identity-processor.js'
);

const fileContext = {
  filename: path.join(__dirname, 'skip-symbol-warning.js'),
  root: __dirname,
};

const runWithProcessor = (processorPath: string, callback: jest.Mock) => {
  const code = `
    import { css } from '@linaria/atomic';

    css\`
      color: red;
    \`;
  `;

  const options: Pick<
    StrictOptions,
    'classNameSlug' | 'displayName' | 'extensions' | 'evaluate' | 'tagResolver'
  > = {
    displayName: false,
    evaluate: true,
    extensions: ['.js'],
    tagResolver: (source, imported) => {
      if (source !== '@linaria/atomic' || imported !== 'css') {
        return null;
      }

      return processorPath;
    },
  };

  babel.transformSync(code, {
    filename: fileContext.filename,
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    plugins: [
      () => ({
        visitor: {
          Program(programPath) {
            applyProcessors(programPath, fileContext, options, callback);
          },
        },
      }),
    ],
  });
};

describe('getTagProcessor (skip symbol warning)', () => {
  it('treats Symbol("skip") as SKIP and warns once', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const callback = jest.fn();

    runWithProcessor(skipSymbolProcessorPath, callback);
    runWithProcessor(skipSymbolProcessorPath, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("Symbol('skip')");

    warnSpy.mockRestore();
  });

  it('does not warn for BaseProcessor.SKIP identity', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const callback = jest.fn();

    runWithProcessor(skipIdentityProcessorPath, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
