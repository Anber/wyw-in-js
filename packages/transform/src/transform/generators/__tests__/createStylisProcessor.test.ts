import dedent from 'dedent';
import { compile, middleware, serialize, stringify } from 'stylis';

import {
  createStylisUrlReplacePlugin,
  stylisGlobalPlugin,
} from '../createStylisPreprocessor';

describe('stylisUrlReplacePlugin', () => {
  const filename = '/path/to/src/file.js';
  const outputFilename = '/path/to/assets/file.css';

  const stylisUrlReplacePlugin = createStylisUrlReplacePlugin(
    filename,
    outputFilename
  );

  function compileRule(rule: string): string {
    return serialize(
      compile(rule),
      middleware([stylisUrlReplacePlugin, stringify])
    );
  }

  it('should replace relative paths in url() expressions', () => {
    expect(
      compileRule('.component { background-image: url(./image.png) }')
    ).toMatchInlineSnapshot(
      `".component{background-image:url(../src/image.png);}"`
    );
  });
});

describe('stylisGlobalPlugin', () => {
  function compileRule(rule: string): string {
    return serialize(
      compile(rule),
      middleware([stylisGlobalPlugin, stringify])
    );
  }

  describe('inner part of :global()', () => {
    it('single selector', () => {
      expect(
        compileRule('.component :global(.global) { color: red }')
      ).toMatchInlineSnapshot(`".global {color:red;}"`);

      expect(
        compileRule('.component &:global(.global) { color: red }')
      ).toMatchInlineSnapshot(`".global.component {color:red;}"`);

      expect(
        compileRule('.component & :global(.global) { color: red }')
      ).toMatchInlineSnapshot(`".global .component {color:red;}"`);
    });

    it('multiple selectors', () => {
      expect(
        compileRule('.component :global(.globalA.globalB) { color: red }')
      ).toMatchInlineSnapshot(`".globalA.globalB {color:red;}"`);

      expect(
        compileRule('.component &:global(.globalA.globalB) { color: red }')
      ).toMatchInlineSnapshot(`".globalA.globalB.component {color:red;}"`);

      expect(
        compileRule('.component & :global(.globalA.globalB) { color: red }')
      ).toMatchInlineSnapshot(`".globalA.globalB .component {color:red;}"`);
    });

    it('data selector', () => {
      expect(
        compileRule('.component :global([data-global-style]) { color: red }')
      ).toMatchInlineSnapshot(`"[data-global-style] {color:red;}"`);

      expect(
        compileRule('.component &:global([data-global-style]) { color: red }')
      ).toMatchInlineSnapshot(`"[data-global-style].component {color:red;}"`);

      expect(
        compileRule('.component & :global([data-global-style]) { color: red }')
      ).toMatchInlineSnapshot(`"[data-global-style] .component {color:red;}"`);
    });
  });

  describe('nested part of :global()', () => {
    it('single selector', () => {
      expect(
        compileRule('.component :global() { .global { color: red } }')
      ).toMatchInlineSnapshot(`".global {color:red;}"`);

      expect(
        compileRule('.component &:global() { .global { color: red } }')
      ).toMatchInlineSnapshot(`".global.component {color:red;}"`);

      expect(
        compileRule('.component & :global() { .global { color: red } }')
      ).toMatchInlineSnapshot(`".global .component {color:red;}"`);
    });

    it('multiple selectors', () => {
      const cssRuleA = dedent(`
        .component :global() {
          .globalA { color: red }
          .globalB { color: blue }
        }
      `);
      const cssRuleB = dedent(`
        .component &:global() {
          .globalA { color: red }
          .globalB { color: blue }
        }
      `);
      const cssRuleC = dedent(`
        .component & :global() {
          .globalA { color: red }
          .globalB { color: blue }
        }
      `);

      expect(compileRule(cssRuleA)).toMatchInlineSnapshot(
        `".globalA {color:red;}.globalB {color:blue;}"`
      );
      expect(compileRule(cssRuleB)).toMatchInlineSnapshot(
        `".globalA.component {color:red;}.globalB.component {color:blue;}"`
      );
      expect(compileRule(cssRuleC)).toMatchInlineSnapshot(
        `".globalA .component {color:red;}.globalB .component {color:blue;}"`
      );
    });
  });
});
