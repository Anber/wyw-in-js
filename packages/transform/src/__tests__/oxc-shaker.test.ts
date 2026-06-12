/* eslint-env jest */
import { join } from 'path';

import dedent from 'dedent';

import { emitOxcCommonJS } from '../utils/oxcEmit';
import { shakeOxcToESM } from '../utils/oxcShaker';

const filename = join(__dirname, 'source.tsx');

const run = (onlyExports: string[], code: string) =>
  shakeOxcToESM(dedent(code), filename, {
    onlyExports,
  });

describe('shakeOxcToESM', () => {
  it('keeps transitive dependencies of __wywPreval and strips dead exports', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        export const activeClass = "s1gxjcbn";
        const _exp = /*#__PURE__*/() => activeClass;
        export const __wywPreval = {
          _exp: _exp,
        };
      `
    );

    expect(code).toContain('const activeClass = "s1gxjcbn"');
    expect(code).toContain('const _exp =');
    expect(code).toContain('export const __wywPreval');
    expect(code).not.toContain('export const activeClass');
  });

  it('drops imports that become unused when keeping only __wywPreval', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import * as RAC from 'react-aria-components';
        import { jsx as _jsx } from 'react/jsx-runtime';

        export const __wywPreval = {
          value: () => 's1gxjcbn',
        };

        export function Button(props) {
          return _jsx(RAC.Button, { ...props });
        }
      `
    );

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('react-aria-components');
    expect(code).not.toContain('react/jsx-runtime');
    expect(imports.size).toBe(0);
  });

  it('drops property assignments for dead exports', () => {
    const { code } = run(
      ['__wywPreval'],
      `
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
      `
    );

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('__STORYBOOK_MODULE_TEST__');
    expect(code).not.toContain('Primary.play');
    expect(code).not.toContain('Primary.parameters');
  });

  it('drops unused exports with dynamic import when keeping only __wywPreval', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        export const __wywPreval = {
          value: () => 's1gxjcbn',
        };

        export async function getStaticData(lang) {
          return (await import('./i18n/' + lang + '.json')).default;
        }
      `
    );

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('getStaticData');
    expect(code).not.toContain('import(');
  });

  it('does not crash when dropping an anonymous default export', () => {
    const { code } = run(
      ['foo'],
      `
        export const foo = 1;

        export default function(nodes) {
          return nodes;
        }
      `
    );

    expect(code).toContain('export const foo');
    expect(code).not.toContain('export default');
  });

  it('drops imports when default and named exports share the same binding', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { jsxDEV as _jsxDEV } from 'react/jsx-dev-runtime';
        import SlButton from '@shoelace-style/shoelace/dist/react/button/index.js';

        export const __wywPreval = {
          value: () => 's1gxjcbn',
        };

        export const App = () => {
          return _jsxDEV(SlButton, {});
        };

        export default App;
      `
    );

    expect(code).toContain('__wywPreval');
    expect(code).not.toContain('react/jsx-dev-runtime');
    expect(code).not.toContain('@shoelace-style/shoelace');
    expect(imports.size).toBe(0);
  });

  it('keeps CommonJS __wywPreval export assignments when shaking script sources', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        exports.Button = () => 'button';
        exports.__wywPreval = {
          Button: exports.Button,
        };
      `
    );

    expect(code).toContain('exports.__wywPreval =');
    expect(code).not.toContain("exports.Button = () => 'button'");
  });

  it('unwraps single exported const declarations used by surviving code', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        export const Button = () => 'button';

        export const __wywPreval = {
          value: Button,
        };
      `
    );

    expect(code).toContain('const Button =');
    expect(code).not.toContain('export const Button');
    expect(code).toContain('__wywPreval');
  });

  it('keeps local declarations referenced by export specifiers', () => {
    const { code } = run(
      ['Button'],
      `
        const Button = () => null;
        export { Button };
      `
    );

    expect(code).toContain('const Button = () => null');
    expect(code).toContain('export { Button }');
  });

  it('keeps wildcard reexports for requested names resolved by child modules', () => {
    const { code, imports } = run(
      ['fooStyles'],
      `
        export * from './foo';
        export const local = 'local';
      `
    );

    expect(code).toContain("export * from './foo'");
    expect(code).not.toContain('local');
    expect(imports.get('./foo')).toEqual(['*']);
  });

  it('keeps namespace imports referenced by surviving local export specifiers', () => {
    const { code, imports } = run(
      ['fooStyles'],
      `
        import * as fooStyles from './constants';
        export { fooStyles };
        export const local = 'local';
      `
    );

    expect(code).toContain("import * as fooStyles from './constants'");
    expect(code).toContain('export { fooStyles }');
    expect(code).not.toContain("export const local = 'local'");
    expect(imports.get('./constants')).toEqual(['*']);
  });

  it('drops unused sibling import specifiers from surviving eval imports', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { foo1, foo2 } from './foo';

        const _exp = () => foo1;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('import { foo1');
    expect(code).toContain("from './foo'");
    expect(code).not.toContain('foo2');
    expect(imports.get('./foo')).toEqual(['foo1']);
  });

  it('preserves the final surviving import specifier after pruning adjacent siblings', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { Horizontal, Spring, Vertical } from './flex';

        const _exp = () => Vertical;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain("import { Vertical } from './flex'");
    expect(code).not.toContain("import { ertical } from './flex'");
    expect(code).not.toContain('Horizontal');
    expect(code).not.toContain('Spring');
    expect(imports.get('./flex')).toEqual(['Vertical']);
  });

  it('keeps side-effect imports only when explicitly requested', () => {
    const dropped = run(
      ['__wywPreval'],
      `
        import '@radix-ui/react-tooltip';

        export const __wywPreval = {
          value: () => 's1gxjcbn',
        };
      `
    );
    const kept = run(
      ['side-effect'],
      `
        import '@radix-ui/react-tooltip';

        export const __wywPreval = {
          value: () => 's1gxjcbn',
        };
      `
    );

    expect(dropped.code).not.toContain('@radix-ui/react-tooltip');
    expect(dropped.imports.size).toBe(0);
    expect(kept.code).toContain('@radix-ui/react-tooltip');
    expect(kept.imports.get('@radix-ui/react-tooltip')).toEqual([
      'side-effect',
    ]);
  });

  it('keeps side-effect imports when importOverrides marks them noShake', () => {
    const result = shakeOxcToESM(
      dedent`
        import '@radix-ui/react-tooltip';

        export const __wywPreval = {
          value: () => 's1gxjcbn',
        };
      `,
      filename,
      {
        importOverrides: {
          '@radix-ui/react-tooltip': { noShake: true },
        },
        onlyExports: ['__wywPreval'],
      }
    );

    expect(result.code).toContain('@radix-ui/react-tooltip');
    expect(result.imports.get('@radix-ui/react-tooltip')).toEqual([
      'side-effect',
    ]);
  });

  it('keeps declaration chains referenced by surviving exports', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        const isFlagPresent = (flag) => false;
        export const isDevHost = window.location.hostname === 'localhost';
        export const isDevMode = (isDevHost || isFlagPresent("dev")) && !isFlagPresent("no-dev");
        export const someFeature = isDevMode && isFlagPresent("some-feature");

        const _exp = /*#__PURE__*/() => someFeature ? 'feature-class' : 'default-class';
        export const __wywPreval = {
          _exp: _exp,
        };
      `
    );

    expect(code).toContain('const isDevHost');
    expect(code).toContain('const isDevMode');
    expect(code).toContain('const someFeature');
    expect(code).not.toContain('export const isDevHost');
    expect(code).not.toContain('export const isDevMode');
    expect(code).not.toContain('export const someFeature');
  });

  it('keeps bindings referenced via object shorthand', () => {
    const { code } = run(
      ['Spring'],
      `
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
      `
    );

    expect(code).toContain('function spring');
    expect(code).toContain('function fallback');
    expect(code).toContain('export const Spring');
    expect(code).not.toContain('export function spring');
    expect(code).not.toContain('export function fallback');
  });

  it('keeps base classes local when a surviving export extends them', () => {
    const { code } = run(
      ['TaskNotFoundException'],
      `
        export class NotFoundException extends Error {
          constructor(message: string) {
            super(message);
            this.name = 'NotFoundException';
          }
        }

        export class TaskNotFoundException extends NotFoundException {
          constructor(message: string) {
            super(message);
            this.name = 'TaskNotFoundException';
          }
        }
      `
    );

    expect(code).toContain('class NotFoundException extends Error');
    expect(code).toContain(
      'export class TaskNotFoundException extends NotFoundException'
    );
    expect(code).not.toContain('export class NotFoundException');
  });

  it('splits multi-declarator exports when only one binding is exported', () => {
    const { code } = run(
      ['b'],
      `
        export const a = globalThis.location?.hostname || 'localhost', b = a + '-dev';
      `
    );

    expect(code).toContain('const a =');
    expect(code).toContain("b = a + '-dev'");
    expect(code).toContain('export { b };');
    expect(code).not.toContain('export const a');
  });

  it('drops type-only enum references when the enum is otherwise dead', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        export enum Flags {
          Dev = 1,
        }

        type Mode = Flags;

        const _exp = /*#__PURE__*/() => 'static-class';
        export const __wywPreval = {
          _exp: _exp,
        };
      `
    );

    expect(code).not.toContain('enum Flags');
    expect(code).toContain('__wywPreval');
  });

  it('keeps enums local when emitted CommonJS still references them', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        export enum Flags {
          Dev = 1,
        }

        export const mode = Flags.Dev;

        const _exp = /*#__PURE__*/() => globalThis.location?.hash === String(mode);
        export const __wywPreval = {
          _exp: _exp,
        };
      `
    );
    const emitted = emitOxcCommonJS(code, filename);

    expect(emitted.code).toContain('var Flags =');
    expect(emitted.code).toContain('const mode = Flags.Dev');
    expect(emitted.code).toContain('const __wywPreval = exports.__wywPreval =');
    expect(emitted.code).not.toContain('exports.Flags');
    expect(emitted.code).not.toContain('exports.mode');
  });

  it('fully removes dead exports when surviving code does not reference them', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        export const unused = 'dead';
        export const alsoUnused = unused + '!';

        const _exp = /*#__PURE__*/() => 'static-class';
        export const __wywPreval = {
          _exp: _exp,
        };
      `
    );

    expect(code).not.toContain('unused');
    expect(code).not.toContain('alsoUnused');
    expect(code).toContain('__wywPreval');
  });

  it('drops unreferenced helper declarations after component code is stripped', () => {
    const { code, imports } = run(
      ['default'],
      `
        import { ApolloError } from '@apollo/client';

        class ResolveError extends Error {}

        function getErrorData(error) {
          if (error instanceof ResolveError) {
            return getErrorData(error.innerError);
          }

          if (error instanceof ApolloError) {
            return null;
          }

          return null;
        }

        const BareEditor = function BareEditor() {
          return null;
        };

        const _exp = function _exp() {
          return BareEditor;
        };

        export default {
          displayName: 'Editor0',
          __wyw_meta: {
            className: 'editor',
            extends: _exp(),
          },
        };
      `
    );

    expect(code).toContain('__wyw_meta');
    expect(code).not.toContain('ApolloError');
    expect(code).not.toContain('ResolveError');
    expect(code).not.toContain('getErrorData');
    expect(imports.size).toBe(0);
  });

  it('keeps property mutations for live export bindings', () => {
    const { code } = run(
      ['default'],
      `
        const value = () => undefined;
        value.token = Math.random().toString(36).slice(2);
        export default value;
      `
    );

    expect(code).toContain('const value = () => undefined');
    expect(code).toContain('value.token = Math.random()');
    expect(code).toContain('export default value');
  });

  it('keeps Object.assign mutations for live export bindings', () => {
    const { code } = run(
      ['default'],
      `
        export const Suffix = () => null;
        const value = () => undefined;
        Object.assign(value, {
          Suffix,
        });
        export default value;
      `
    );

    expect(code).toContain('const value = () => undefined');
    expect(code).toContain('Object.assign(value, {');
    expect(code).toContain('Suffix');
    expect(code).toContain('export default value');
  });

  it('keeps imports referenced inside TS expression-wrapper nodes', () => {
    const { code, imports } = run(
      ['textStyles'],
      `
        import { themeVars } from './theme';
        import { transition } from './animation';

        export const textStyles = {
          base: {
            color: themeVars.textColor,
            transition: \`color \${transition}\`,
          },
        } as const;
      `
    );

    expect(code).toContain("import { themeVars } from './theme'");
    expect(code).toContain("import { transition } from './animation'");
    expect(imports.get('./theme')).toEqual(['themeVars']);
    expect(imports.get('./animation')).toEqual(['transition']);
  });

  it('keeps imports referenced inside TSSatisfiesExpression and TSNonNullExpression', () => {
    const { code } = run(
      ['result'],
      `
        import { config } from './config';
        import { maybe } from './maybe';

        export const result = {
          ok: config.value,
          must: maybe!.field,
        } satisfies Record<string, unknown>;
      `
    );

    expect(code).toContain("import { config } from './config'");
    expect(code).toContain("import { maybe } from './maybe'");
  });

  it('strips statement-level import type entirely', () => {
    const { code, imports } = run(
      ['value'],
      `
        import type { Foo } from './types';
        import { helper } from './utils';

        export const value: Foo = helper();
      `
    );

    expect(code).not.toContain('./types');
    expect(code).toContain("import { helper } from './utils'");
    expect(imports.has('./types')).toBe(false);
    expect(imports.get('./utils')).toEqual(['helper']);
  });

  it('preserves runtime import when using inline type modifier alongside value bindings', () => {
    const { code, imports } = run(
      ['value'],
      `
        import { type Foo, helper } from './mixed';

        export const value: Foo = helper();
      `
    );

    expect(code).toContain("from './mixed'");
    expect(code).toContain('helper');
    expect(imports.get('./mixed')).toEqual(['helper']);
  });

  it('strips import with only inline type bindings (no value bindings)', () => {
    const { code, imports } = run(
      ['value'],
      `
        import { type Foo, type Bar } from './types';
        import { helper } from './utils';

        export const value = helper();
      `
    );

    expect(code).not.toContain('./types');
    expect(code).toContain("import { helper } from './utils'");
    expect(imports.has('./types')).toBe(false);
  });
});
