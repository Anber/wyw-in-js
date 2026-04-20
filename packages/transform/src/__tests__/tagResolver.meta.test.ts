import path from 'path';

import * as babel from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';

import { applyProcessors } from '../utils/getTagProcessor';

const processorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const linariaWrapperPath = path.resolve(
  __dirname,
  '__fixtures__',
  'tag-resolver',
  'linaria.js'
);

describe('tagResolver meta', () => {
  it('passes sourceFile and resolvedSource for local wrapper imports', () => {
    const code = `
      import { css } from './__fixtures__/tag-resolver/linaria';

      export const a = css\`
        color: red;
      \`;
    `;

    const fileContext = {
      filename: path.join(__dirname, 'tag-resolver-source.js'),
      root: __dirname,
    };

    let received: {
      meta: { resolvedSource?: string; sourceFile: string | null | undefined };
      source: string;
      tag: string;
    } | null = null;

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
      tagResolver: (source, tag, meta) => {
        received = { source, tag, meta };
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

    expect(received).not.toBeNull();
    expect(received?.source).toBe('./__fixtures__/tag-resolver/linaria');
    expect(received?.tag).toBe('css');
    expect(received?.meta.sourceFile).toBe(fileContext.filename);
    expect(received?.meta.resolvedSource).toBe(linariaWrapperPath);
  });
});
