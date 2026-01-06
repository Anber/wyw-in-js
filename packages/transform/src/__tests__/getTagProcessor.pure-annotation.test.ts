import path from 'path';

import * as babel from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';

import { applyProcessors } from '../utils/getTagProcessor';

const arrowProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-pure-annotation-arrow-processor.js'
);

const callProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-pure-annotation-call-processor.js'
);

const transform = (code: string, processorPath: string) => {
  const fileContext = {
    filename: path.join(__dirname, 'source.js'),
    root: __dirname,
  };

  const options: Pick<
    StrictOptions,
    'classNameSlug' | 'displayName' | 'extensions' | 'evaluate' | 'tagResolver'
  > = {
    displayName: false,
    evaluate: true,
    extensions: ['.js'],
    tagResolver: (source, imported) => {
      if (source !== 'test-package' || imported !== 'css') {
        return null;
      }

      return processorPath;
    },
  };

  return babel.transformSync(code, {
    filename: fileContext.filename,
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    plugins: [
      () => ({
        visitor: {
          Program(programPath) {
            applyProcessors(programPath, fileContext, options, (processor) => {
              processor.doRuntimeReplacement();
            });
          },
        },
      }),
    ],
  })!;
};

describe('getTagProcessor', () => {
  it('does not emit PURE annotation for non-call/new replacements', () => {
    const code = `
      import { css } from 'test-package';

      const a = css\`
        color: red;
      \`;
    `;

    const { code: result } = transform(code, arrowProcessorPath);

    expect(result).not.toContain('/*#__PURE__*/');
  });

  it('emits PURE annotation for call expression replacements', () => {
    const code = `
      import { css } from 'test-package';

      const a = css\`
        color: red;
      \`;
    `;

    const { code: result } = transform(code, callProcessorPath);

    expect(result).toContain('/*#__PURE__*/');
  });
});
