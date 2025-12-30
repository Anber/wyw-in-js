import path from 'path';

import * as babel from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';

import { applyProcessors } from '../utils/getTagProcessor';

const processorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);

describe('getTagProcessor', () => {
  it('emits CSS for named function expressions', () => {
    const code = `
      import { css } from '@linaria/atomic';

      export const a = function a() {
        return css\`
          color: red;
        \`;
      };

      export const b = function () {
        return css\`
          font-size: 20px;
        \`;
      };

      a();
      b();
    `;

    const fileContext = {
      filename: path.join(__dirname, 'named-function-expression.js'),
      root: __dirname,
    };

    const options: Pick<
      StrictOptions,
      | 'classNameSlug'
      | 'displayName'
      | 'extensions'
      | 'evaluate'
      | 'tagResolver'
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

    const cssText: string[] = [];

    babel.transformSync(code, {
      filename: fileContext.filename,
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      plugins: [
        () => ({
          visitor: {
            Program(programPath) {
              applyProcessors(
                programPath,
                fileContext,
                options,
                (processor) => {
                  processor.build(new Map());
                  processor.artifacts.forEach((artifact) => {
                    if (artifact[0] !== 'css') return;
                    const [rules] = artifact[1];
                    Object.values(rules).forEach((rule) => {
                      cssText.push(rule.cssText);
                    });
                  });
                }
              );
            },
          },
        }),
      ],
    });

    expect(cssText.join('\n')).toContain('color: red');
    expect(cssText.join('\n')).toContain('font-size: 20px');
  });
});
