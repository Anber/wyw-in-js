import { join } from 'path';

import * as babel from '@babel/core';
import dedent from 'dedent';

import { shaker } from '../shaker';

const compile =
  (only: string[], extraConfig: Record<string, unknown> = {}) =>
  (code: TemplateStringsArray) => {
    const filename = join(__dirname, 'source.ts');
    const formattedCode = dedent(code);
    const parsed = babel.parseSync(formattedCode, {
      filename,
      parserOpts: {
        plugins: ['typescript', 'jsx'],
      },
    });

    return shaker(
      {
        filename,
        plugins: [],
      },
      parsed!,
      formattedCode,
      {
        features: {
          dangerousCodeRemover: true,
          globalCache: false,
          happyDOM: false,
          softErrors: false,
          useBabelConfigs: false,
          useWeakRefInEval: true,
        },
        highPriorityPlugins: [],
        onlyExports: only,
        ...extraConfig,
      },
      babel
    );
  };

const run = (only: string[]) => (code: TemplateStringsArray) =>
  compile(only)(code)[1];

describe('shaker', () => {
  it('should carefully shake used exports', () => {
    const code = run(['__wywPreval'])`
      export const activeClass = "s1gxjcbn";
      const _exp = /*#__PURE__*/() => activeClass;
      export const __wywPreval = {
        _exp: _exp,
      };
    `;

    expect(code).toMatchSnapshot();
  });

  it('should remove enum', () => {
    const code = run(['__wywPreval'])`
      export enum PanelKinds {
        DEFAULT = "default",
        TRANSPARENT = "transparent",
      }
      const _exp2 = /*#__PURE__*/() => "t2nn9pk";
      export const __wywPreval = {
        _exp2: _exp2,
      };
    `;

    expect(code).toMatchSnapshot();
  });

  it('should drop imports that become unused when keeping only __wywPreval (tsx)', () => {
    const code = run(['__wywPreval'])`
      import * as RAC from 'react-aria-components';
      import { jsx as _jsx } from 'react/jsx-runtime';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };

      export function Button(props) {
        return _jsx(RAC.Button, { ...props });
      }
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('react-aria-components');
    expect(code).not.toContain('react/jsx-runtime');
  });

  it('should exclude imports metadata when the binding became dead (tsx)', () => {
    const [, , imports] = compile(['__wywPreval'])`
      import * as RAC from 'react-aria-components';
      import { jsx as _jsx } from 'react/jsx-runtime';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };

      export function Button(props) {
        return _jsx(RAC.Button, { ...props });
      }
    `;

    expect(imports.size).toBe(0);
  });

  it('should drop imports that become unused when keeping only __wywPreval (tsx, const export)', () => {
    const code = run(['__wywPreval'])`
      import * as RAC from 'react-aria-components';
      import { jsx as _jsx } from 'react/jsx-runtime';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };

      export const Button = (props) => {
        return _jsx(RAC.Button, { ...props });
      };
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('react-aria-components');
    expect(code).not.toContain('react/jsx-runtime');
  });

  it('should not crash when dropping an anonymous default export', () => {
    const code = run(['foo'])`
      export const foo = 1;

      export default function(nodes) {
        return nodes;
      }
    `;

    expect(code).toContain('foo');
    expect(code).not.toContain('export default');
  });

  it('should exclude imports metadata when the const export becomes dead (tsx)', () => {
    const [, , imports] = compile(['__wywPreval'])`
      import * as RAC from 'react-aria-components';
      import { jsx as _jsx } from 'react/jsx-runtime';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };

      export const Button = (props) => {
        return _jsx(RAC.Button, { ...props });
      };
    `;

    expect(imports.size).toBe(0);
  });

  it('should drop unused named imports when keeping only __wywPreval (no other deletions)', () => {
    const [, code, imports] = compile(['__wywPreval'])`
      import { Tooltip } from '@radix-ui/react-tooltip';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('@radix-ui/react-tooltip');
    expect(imports.size).toBe(0);
  });

  it('should drop unused namespace imports when keeping only __wywPreval (no other deletions)', () => {
    const [, code, imports] = compile(['__wywPreval'])`
      import * as Tooltip from '@radix-ui/react-tooltip';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('@radix-ui/react-tooltip');
    expect(imports.size).toBe(0);
  });

  it('should drop side-effect imports when keeping only __wywPreval (no other deletions)', () => {
    const [, code, imports] = compile(['__wywPreval'])`
      import '@radix-ui/react-tooltip';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('@radix-ui/react-tooltip');
    expect(imports.size).toBe(0);
  });

  it('should keep side-effect imports when imported as side-effect', () => {
    const code = run(['side-effect'])`
      import '@radix-ui/react-tooltip';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };
    `;

    expect(code).toContain('@radix-ui/react-tooltip');
  });

  it('should keep side-effect imports when they have importOverrides', () => {
    const [, code, imports] = compile(['__wywPreval'], {
      importOverrides: {
        '@radix-ui/react-tooltip': { noShake: true },
      },
    })`
      import '@radix-ui/react-tooltip';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };
    `;

    expect(code).toContain('@radix-ui/react-tooltip');
    expect(imports.get('@radix-ui/react-tooltip')).toEqual(['side-effect']);
  });

  it('should drop property assignments for dead exports', () => {
    const code = run(['__wywPreval'])`
      const { expect } = __STORYBOOK_MODULE_TEST__;
      export const Primary = {};
      Primary.play = () => {
        expect(true).toBe(true);
      };
      Primary.parameters = {
        ...Primary.parameters,
        docs: {
          ...Primary.parameters?.docs,
        },
      };

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('__STORYBOOK_MODULE_TEST__');
    expect(code).not.toContain('Primary.play');
  });

  it('should drop imports when default and named exports share the same binding', () => {
    const code = run(['__wywPreval'])`
      import { jsxDEV as _jsxDEV } from 'react/jsx-dev-runtime';
      import SlButton from '@shoelace-style/shoelace/dist/react/button/index.js';

      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };

      export const App = () => {
        return _jsxDEV(SlButton, {});
      };

      export default App;
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('react/jsx-dev-runtime');
    expect(code).not.toContain('@shoelace-style/shoelace');
  });

  it('should drop unused exports with dynamic import when keeping only __wywPreval', () => {
    const code = run(['__wywPreval'])`
      export const __wywPreval = {
        value: () => 's1gxjcbn',
      };

      export async function getStaticData(lang) {
        return (await import('./i18n/' + lang + '.json')).default;
      }
    `;

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('getStaticData');
    expect(code).not.toContain('import(');
  });

  it('should keep bindings referenced via object shorthand', () => {
    const code = run(['Spring'])`
      export function spring() {
        return 'spring';
      }

      export function fallback(fallback) {
        return 'fallback';
      }

      export const Spring = {
        fallback,
        create: spring,
      };
    `;

    expect(code).toContain('exports.Spring');
    expect(code).toContain('function spring');
    expect(code).toContain('function fallback');
    expect(code).not.toContain('exports.fallback');
  });

  it('should keep declaration when a dead export is referenced by a surviving export', () => {
    // Regression: the shaker's outerReferences filter treats the init expression
    // of a dead export as a forDeleting candidate. When isDevMode's init
    // (`isDevHost || null`) is the candidate, `candidate.isAncestor(ref)` is
    // true for the reference to isDevHost inside it — so isDevHost appears to
    // have 0 blocking references and gets fully removed. But isDevMode survives
    // via stripExportKeepDeclaration (kept code references it), leaving a
    // dangling reference → ReferenceError: isDevHost is not defined.
    const code = run(['__wywPreval'])`
      export const isDevHost = window.location.hostname === 'localhost';
      export const isDevMode = isDevHost || null;

      const _exp = /*#__PURE__*/() => isDevMode ? 'dev-class' : 'prod-class';
      export const __wywPreval = {
        _exp: _exp,
      };
    `;

    // isDevHost declaration must survive — isDevMode references it
    expect(code).toContain('const isDevHost');
    // isDevMode declaration must survive — _exp references it
    expect(code).toContain('const isDevMode');
    // neither should be exported
    expect(code).not.toContain('exports.isDevHost');
    expect(code).not.toContain('exports.isDevMode');
  });

  it('should keep transitive chain of dead exports referenced by surviving code', () => {
    // Mirrors real-world flags.ts: a → b → c chain where only c is alive
    const code = run(['__wywPreval'])`
      const isFlagPresent = (flag) => false;
      export const isDevHost = window.location.hostname === 'localhost';
      export const isDevMode = (isDevHost || isFlagPresent("dev")) && !isFlagPresent("no-dev");
      export const someFeature = isDevMode && isFlagPresent("some-feature");

      const _exp = /*#__PURE__*/() => someFeature ? 'feature-class' : 'default-class';
      export const __wywPreval = {
        _exp: _exp,
      };
    `;

    // Entire chain must survive — someFeature → isDevMode → isDevHost
    expect(code).toContain('const isDevHost');
    expect(code).toContain('const isDevMode');
    expect(code).toContain('const someFeature');
    // none should be exported
    expect(code).not.toContain('exports.isDevHost');
    expect(code).not.toContain('exports.isDevMode');
    expect(code).not.toContain('exports.someFeature');
  });

  it('should keep enums local when a surviving export still references them', () => {
    const code = run(['__wywPreval'])`
      export enum Flags {
        Dev = 1,
      }

      export const mode = Flags.Dev;

      const _exp = /*#__PURE__*/() => globalThis.location?.hash === String(mode);
      export const __wywPreval = {
        _exp: _exp,
      };
    `;

    expect(code).toContain('var Flags');
    expect(code).toContain('const mode');
    expect(code).not.toContain('exports.Flags');
    expect(code).not.toContain('exports.mode');
  });

  it('should split multi-declarator exports when only one binding survives', () => {
    const code = run(['b'])`
      export const a = globalThis.location?.hostname || 'localhost', b = a + '-dev';
    `;

    expect(code).toContain('const a');
    expect(code).toContain('const b');
    expect(code).toContain('exports.b');
    expect(code).not.toContain('exports.a');
  });

  it('should fully remove dead export when nothing references it', () => {
    // Ensure the fix doesn't prevent removal of truly dead exports
    const code = run(['__wywPreval'])`
      export const unused = 'dead';
      export const alsoUnused = unused + '!';

      const _exp = /*#__PURE__*/() => 'static-class';
      export const __wywPreval = {
        _exp: _exp,
      };
    `;

    // Both should be fully removed — nothing in __wywPreval references them
    expect(code).not.toContain('unused');
    expect(code).not.toContain('alsoUnused');
  });
});
