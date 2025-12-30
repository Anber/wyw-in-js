import * as babel from '@babel/core';

import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { Entrypoint } from '../transform/Entrypoint';
import { prepareCode } from '../transform/generators/transform';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';

describe('declare class fields', () => {
  const testCases = [
    {
      name: 'top-level preset',
      babelOptions: {
        presets: ['@babel/preset-typescript'],
      },
    },
    {
      name: 'overrides preset',
      babelOptions: {
        overrides: [
          {
            test: /\.tsx?$/,
            presets: ['@babel/preset-typescript'],
          },
        ],
      },
    },
    {
      name: 'env preset',
      babelOptions: {
        plugins: ['@babel/plugin-syntax-typescript'],
        env: {
          'wyw-in-js': {
            presets: ['@babel/preset-typescript'],
          },
        },
      },
    },
  ] as const;

  testCases.forEach(({ name, babelOptions }) => {
    it(`does not crash TypeScript transform (${name})`, () => {
      const pluginOptions = loadWywOptions({
        configFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          ...babelOptions,
        },
      });

      const filename = `${__dirname}/declare-fields.ts`;
      const sourceCode = `
        export class X {
          declare foo: string;
        }
      `;

      const services = withDefaultServices({
        babel,
        options: {
          root: __dirname,
          filename,
          pluginOptions,
        },
      });

      const entrypoint = Entrypoint.createRoot(
        services,
        filename,
        ['__wywPreval'],
        sourceCode
      );

      if (entrypoint.ignored) {
        throw new Error('Entrypoint is ignored');
      }

      expect(() =>
        prepareCode(services, entrypoint, entrypoint.loadedAndParsed.ast)
      ).not.toThrow();
    });
  });
});
