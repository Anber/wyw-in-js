import dedent from 'dedent';
import { compile, middleware, serialize, stringify } from 'stylis';

import {
  createStylisPreprocessor,
  createStylisUrlReplacePlugin,
  stylisGlobalPlugin,
} from '../createStylisPreprocessor';

describe('createStylisPreprocessor', () => {
  const preprocessor = createStylisPreprocessor({
    filename: '/path/to/src/file.js',
    outputFilename: '/path/to/assets/file.css',
  });

  const compileRule = (rule: string) => preprocessor('.foo', rule);

  it('should understand namespace ref', () => {
    expect(compileRule('&:not(.bar) { color: red }')).toMatchInlineSnapshot(
      `".foo:not(.bar){color:red;}"`
    );

    expect(compileRule(':not(.bar)>& { color: red }')).toMatchInlineSnapshot(
      `":not(.bar)>.foo{color:red;}"`
    );
  });

  describe('keyframes', () => {
    it('should add suffix to @keyframes', () => {
      expect(
        compileRule('@keyframes bar { from { color: red } }')
      ).toMatchInlineSnapshot(
        `"@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );
    });

    it('should add suffix to animation', () => {
      expect(
        compileRule(
          '& { animation: bar 0s forwards; } @keyframes bar { from { color: red } }'
        )
      ).toMatchInlineSnapshot(
        `".foo{animation:bar-foo 0s forwards;}@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );
    });

    it('should add suffix to animation-name', () => {
      // Usage before definition
      expect(
        compileRule(
          '& { animation-name: bar; } @keyframes bar { from { color: red } }'
        )
      ).toMatchInlineSnapshot(
        `".foo{animation-name:bar-foo;}@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}"`
      );

      // Usage after definition
      expect(
        compileRule(
          '@keyframes bar { from { color: red } } & { animation-name: bar; }'
        )
      ).toMatchInlineSnapshot(
        `"@-webkit-keyframes bar-foo{from{color:red;}}@keyframes bar-foo{from{color:red;}}.foo{animation-name:bar-foo;}"`
      );
    });

    it('should ignore unknown keyframes', () => {
      expect(compileRule('& { animation-name: bar; }')).toMatchInlineSnapshot(
        `".foo{animation-name:bar;}"`
      );
    });

    describe('should unwrap global', () => {
      it('in @keyframes', () => {
        expect(
          compileRule('@keyframes :global(bar) { from { color: red } }')
        ).toMatchInlineSnapshot(
          `"@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}"`
        );
      });

      it('in animation', () => {
        expect(
          compileRule('& { animation: :global(bar) 0s forwards; }')
        ).toMatchInlineSnapshot(`".foo{animation:bar 0s forwards;}"`);
      });

      it('in animation-name', () => {
        expect(
          compileRule('& { animation-name: :global(bar); }')
        ).toMatchInlineSnapshot(`".foo{animation-name:bar;}"`);
      });

      it('in @keyframes and animation-name simultaneously', () => {
        expect(
          compileRule(
            '@keyframes :global(bar) { from { color: red } } & { animation-name: :global(bar); }'
          )
        ).toMatchInlineSnapshot(
          `"@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}.foo{animation-name:bar;}"`
        );

        expect(
          compileRule(
            '& { animation-name: :global(bar); } @keyframes :global(bar) { from { color: red } }'
          )
        ).toMatchInlineSnapshot(
          `".foo{animation-name:bar;}@-webkit-keyframes bar{from{color:red;}}@keyframes bar{from{color:red;}}"`
        );
      });
    });
  });
});

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

    it('multi-level nested selector', () => {
      expect(
        compileRule(
          '.component :global() { .global { .nested { color: red } } }'
        )
      ).toMatchInlineSnapshot(`".global .nested {color:red;}"`);

      expect(
        compileRule(':global() { body { .someClassName { color: red; } } }')
      ).toMatchInlineSnapshot(`"body .someClassName {color:red;}"`);
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
