import { join } from 'path';

import dedent from 'dedent';

import type { BaseProcessor } from '@wyw-in-js/processor-utils';
import { applyOxcProcessors } from '../../../../packages/transform/src/utils/applyOxcProcessors';

interface IRunOptions {
  ts?: boolean;
}

const run = (code: string, options: IRunOptions = {}): BaseProcessor | null => {
  const fileContext = {
    filename: join(__dirname, '..', options.ts ? 'test.ts' : 'test.js'),
    root: '.',
  };
  let result: BaseProcessor | null = null;
  applyOxcProcessors(
    code,
    fileContext,
    {
      displayName: true,
      extensions: ['.js', '.ts'],
      tagResolver: (source, imported) =>
        source === '../makeStyles' && imported === 'makeStyles'
          ? join(__dirname, '..', 'processors', 'makeStyles.ts')
          : null,
    },
    (p) => {
      result = p;
    }
  );

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
        import * as objectSyntax from "@wyw-in-js/object-syntax";

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

  it('namespace and destructuring', () => {
    const result = run(
      dedent`
        import * as objectSyntax from '@wyw-in-js/object-syntax';
        const { makeStyles } = objectSyntax;
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
