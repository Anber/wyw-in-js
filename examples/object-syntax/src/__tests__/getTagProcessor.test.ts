import { join } from 'path';

import { parseSync } from '@babel/core';
import traverse from '@babel/traverse';
import dedent from 'dedent';

import type { BaseProcessor } from '@wyw-in-js/processor-utils';
import { getTagProcessor } from '@wyw-in-js/transform';

interface IRunOptions {
  ts?: boolean;
}

const run = (code: string, options: IRunOptions = {}): BaseProcessor | null => {
  const opts = {
    filename: join(__dirname, options.ts ? 'test.ts' : 'test.js'),
    root: '.',
    code: true,
    ast: true,
    presets: options.ts ? ['@babel/preset-typescript'] : [],
  };
  const rootNode = parseSync(code, opts)!;
  let result: BaseProcessor | null = null;
  traverse(rootNode, {
    Identifier(path) {
      const processor = getTagProcessor(path, opts, {
        displayName: true,
        evaluate: true,
      });

      if (processor) {
        result = processor;
      }
    },
  });

  return result;
};

function tagToString(processor: BaseProcessor | null): string | undefined {
  if (!processor) return undefined;
  return processor.toString();
}

describe('getTagProcessor', () => {
  it('should find correct import', () => {
    const result = run(
      dedent`
        import { makeStyles } from "@wyw-in-js/object-syntax";

        export const Square = makeStyles({});
      `
    );

    expect(tagToString(result)).toBe('makeStyles(…)');
    expect(result?.tagSource).toEqual({
      imported: 'makeStyles',
      source: '@wyw-in-js/object-syntax',
    });
  });

  it('renamed({})', () => {
    const result = run(
      dedent`
        import { makeStyles as renamed } from "@wyw-in-js/object-syntax";

        export const Square = renamed({});
      `
    );

    expect(tagToString(result)).toBe('renamed(…)');
    expect(result?.tagSource).toEqual({
      imported: 'makeStyles',
      source: '@wyw-in-js/object-syntax',
    });
  });

  it('(0, objectSyntax.makeStyles)()', () => {
    const result = run(
      dedent`
        const objectSyntax = require("@wyw-in-js/object-syntax");

        export const Square = (0, objectSyntax.makeStyles)({});
      `
    );

    expect(tagToString(result)).toBe('objectSyntax.makeStyles(…)');
    expect(result?.tagSource).toEqual({
      imported: 'makeStyles',
      source: '@wyw-in-js/object-syntax',
    });
  });

  it('imported from file', () => {
    const result = run(
      dedent`
        import { makeStyles } from '../makeStyles';


        export const square = makeStyles({});
      `
    );

    expect(tagToString(result)).toBe('makeStyles(…)');
    expect(result?.tagSource).toEqual({
      imported: 'makeStyles',
      source: '../makeStyles',
    });
  });

  it('require and access with prop', () => {
    const result = run(
      dedent`
        const renamed = require('@wyw-in-js/object-syntax').makeStyles;
        export const Square = renamed({});
      `
    );

    expect(tagToString(result)).toBe('renamed(…)');
  });

  it('require and destructing', () => {
    const result = run(
      dedent`
        const { makeStyles } = require('@wyw-in-js/object-syntax');
        export const Square = makeStyles({});
      `
    );

    expect(tagToString(result)).toBe('makeStyles(…)');
  });

  describe('invalid usage', () => {
    it('makeStyles``', () => {
      const runner = () =>
        run(
          dedent`import { makeStyles } from "@wyw-in-js/object-syntax"; export const square = makeStyles\`\`;`
        );

      expect(runner).toThrow('Invalid usage of `makeStyles` function');
    });

    it('makeStyles.div``', () => {
      const runner = () =>
        run(
          dedent`import { makeStyles } from "@wyw-in-js/object-syntax"; export const square = makeStyles.div\`\`;`
        );

      expect(runner).toThrow('Invalid usage of `makeStyles` function');
    });

    it('makeStyles("div")``', () => {
      const runner = () =>
        run(
          dedent`import { makeStyles } from "@wyw-in-js/object-syntax"; export const square = makeStyles("div")\`\`;`
        );

      expect(runner).toThrow('Invalid usage of `makeStyles` function');
    });

    it('do not throw if css is not a call', () => {
      const runner = () =>
        run(dedent`export { makeStyles } from "@wyw-in-js/object-syntax";`);

      expect(runner).not.toThrow();
    });
  });
});
