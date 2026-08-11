import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const run = async (root: string, entryFile: string) =>
  transform(
    {
      cache: new TransformCacheCollection(),
      eventEmitter: new EventEmitter(
        () => {},
        () => 0,
        () => {}
      ),
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          eval: { strategy: 'static' },
          tagResolver: (source, tag) =>
            source === 'test-css-processor' && tag === 'css'
              ? processorFile
              : null,
        },
      },
    },
    readFileSync(entryFile, 'utf8'),
    async (what: string) =>
      what === 'test-css-processor'
        ? processorFile
        : join(root, `${what.replace(/^\.\//, '')}.ts`)
  );

describe('static strategy with a css class imported from another module', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wyw-imported-css-class-'));

    writeFileSync(
      join(root, 'tokens.ts'),
      'export const space = { s2: 2, s18: 18 } as const;\n'
    );

    // A css tag evaluated in its own module and re-used by the entry file.
    writeFileSync(
      join(root, 'typography.ts'),
      dedent`
        import { css } from 'test-css-processor';

        export const textClasses = {
          small: css\`
            font-size: 12px;
          \`,
        } as const;
      `
    );
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('resolves every interpolation when no css class is imported', async () => {
    const entryFile = join(root, 'without-class.ts');
    writeFileSync(
      entryFile,
      dedent`
        import { css, cx } from 'test-css-processor';
        import { space } from './tokens';

        export const kbdCss = css\`
          min-width: ${'${space.s18}'}px;
        \`;

        export const Group = () =>
          cx(css\`
            gap: ${'${space.s2}'}px;
          \`);
      `
    );

    await expect(run(root, entryFile)).resolves.toBeDefined();
  });

  // The wrapping cx() call is a mutation hazard seed, so without the
  // processor-managed-argument exemption it marks `space` as mutated. Every
  // later interpolation reached through the deferred-execution path then loses
  // that import, is never enumerated as a static candidate, and is reported
  // unresolved with no reason attached.
  it('resolves interpolations that follow a cx()-wrapped tag', async () => {
    const entryFile = join(root, 'with-class.ts');
    writeFileSync(
      entryFile,
      dedent`
        import { css, cx } from 'test-css-processor';
        import { space } from './tokens';
        import { textClasses } from './typography';

        export const kbdCss = cx(
          textClasses.small,
          css\`
            min-width: ${'${space.s18}'}px;
          \`
        );

        export const Group = () =>
          cx(css\`
            gap: ${'${space.s2}'}px;
          \`);
      `
    );

    await expect(run(root, entryFile)).resolves.toBeDefined();
  });

  // The @fibery/ui-kit hints.tsx shape: the later tag is at module scope
  // rather than inside a component.
  it('resolves a later module-scope tag after a cx()-wrapped tag', async () => {
    const entryFile = join(root, 'module-scope-after.ts');
    writeFileSync(
      entryFile,
      dedent`
        import { css, cx } from 'test-css-processor';
        import { space } from './tokens';
        import { textClasses } from './typography';

        export const hintsCss = cx(
          textClasses.small,
          css\`
            padding: ${'${space.s18}'}px;
          \`
        );

        export const hintCss = css\`
          gap: ${'${space.s2}'}px;
        \`;
      `
    );

    await expect(run(root, entryFile)).resolves.toBeDefined();
  });
});
