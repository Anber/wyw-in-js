import { join } from 'path';

import { parseSync } from '@babel/core';
import traverse from '@babel/traverse';
import dedent from 'dedent';

import type { BaseProcessor } from '@wyw-in-js/processor-utils';
import { applyProcessors } from '@wyw-in-js/transform';

interface IRunOptions {
  ts?: boolean;
}

const run = (code: string, options: IRunOptions = {}): BaseProcessor | null => {
  const opts = {
    filename: join(__dirname, '..', options.ts ? 'test.ts' : 'test.js'),
    root: '.',
    code: true,
    ast: true,
    presets: options.ts ? ['@babel/preset-typescript'] : [],
  };
  const rootNode = parseSync(code, opts)!;
  let result: BaseProcessor | null = null;
  traverse(rootNode, {
    Program(path) {
      applyProcessors(
        path,
        opts,
        {
          displayName: true,
          evaluate: true,
        },
        (p) => {
          result = p;
        }
      );
    },
  });

  return result;
};

function tagToString(processor: BaseProcessor | null): string | undefined {
  if (!processor) return undefined;
  return processor.toString();
}

describe('applyProcessors', () => {
  it('should find correct import', () => {
    const result = run(
      dedent`
        import { css } from "@wyw-in-js/template-tag-syntax";

        export const Square = css\`\`;
      `
    );

    expect(tagToString(result)).toBe('css`…`');
    expect(result?.tagSource).toEqual({
      imported: 'css',
      source: '@wyw-in-js/template-tag-syntax',
    });
  });

  it('renamed``', () => {
    const result = run(
      dedent`
        import { css as renamed } from "@wyw-in-js/template-tag-syntax";

        export const Square = renamed\`\`;
      `
    );

    expect(tagToString(result)).toBe('renamed`…`');
    expect(result?.tagSource).toEqual({
      imported: 'css',
      source: '@wyw-in-js/template-tag-syntax',
    });
  });

  it('(0, tagSyntax.css)``', () => {
    const result = run(
      dedent`
        const tagSyntax = require("@wyw-in-js/template-tag-syntax");

        export const Square = (0, tagSyntax.css)\`\`;
      `
    );

    expect(tagToString(result)).toBe('tagSyntax.css`…`');
    expect(result?.tagSource).toEqual({
      imported: 'css',
      source: '@wyw-in-js/template-tag-syntax',
    });
  });

  it('imported from file', () => {
    const result = run(
      dedent`
        import { css } from '../css';

        export const square = css\`\`;
      `
    );

    expect(tagToString(result)).toBe('css`…`');
    expect(result?.tagSource).toEqual({
      imported: 'css',
      source: '../css',
    });
  });

  it('require and access with prop', () => {
    const result = run(
      dedent`
        const renamedCss = require('@wyw-in-js/template-tag-syntax').css;
        export const Square = renamedCss\`\`;
      `
    );

    expect(tagToString(result)).toBe('renamedCss`…`');
  });

  it('require and destructing', () => {
    const result = run(
      dedent`
        const { css } = require('@wyw-in-js/template-tag-syntax');
        export const Square = css\`\`;
      `
    );

    expect(tagToString(result)).toBe('css`…`');
  });

  describe('invalid usage', () => {
    it('css.div``', () => {
      const runner = () =>
        run(
          dedent`import { css } from "@wyw-in-js/template-tag-syntax"; export const square = css.div\`\`;`
        );

      expect(runner).toThrow('Invalid usage of template tag');
    });

    it('css("div")``', () => {
      const runner = () =>
        run(
          dedent`import { css } from "@wyw-in-js/template-tag-syntax"; export const square = css("div")\`\`;`
        );

      expect(runner).toThrow('Invalid usage of template tag');
    });

    it('do not throw if css is not a tag', () => {
      const runner = () =>
        run(dedent`export { css } from "@wyw-in-js/template-tag-syntax";`);

      expect(runner).not.toThrow();
    });
  });
});
