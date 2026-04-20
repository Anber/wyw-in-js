import path from 'path';

import { asyncResolveFallback } from '@wyw-in-js/shared';

import { transform } from '../transform';

const diagnosticProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-diagnostic-processor.js'
);

describe('transform diagnostics', () => {
  it('surfaces processor diagnostics and keeps metadata manifests diagnostics-free', async () => {
    const root = __dirname;
    const filename = path.join(root, 'diagnostics-entry.tsx');
    const source = [
      "import { css } from './__fixtures__/diagnostic-tag';",
      '',
      'export const button = css`color: red;`;',
    ].join('\n');

    const result = await transform(
      {
        options: {
          filename,
          pluginOptions: {
            babelOptions: {
              babelrc: false,
              configFile: false,
            },
            configFile: false,
            outputMetadata: true,
            tagResolver: (importedSource, imported) => {
              if (
                importedSource === './__fixtures__/diagnostic-tag' &&
                imported === 'css'
              ) {
                return diagnosticProcessorPath;
              }

              return null;
            },
          },
          root,
        },
      },
      source,
      asyncResolveFallback
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: 'dx-style/raw-color',
        displayName: 'button',
        filename,
        message: 'Use a design token instead of a raw color.',
        severity: 'warning',
        start: expect.objectContaining({
          line: 3,
        }),
      }),
    ]);

    expect(result.metadata?.processors).toEqual([
      expect.objectContaining({
        artifacts: [expect.arrayContaining(['css'])],
      }),
    ]);
    expect(
      result.metadata?.processors.flatMap((processor) =>
        processor.artifacts.map(([type]) => type)
      )
    ).not.toContain('wyw-in-js:diagnostic');
  });
});
