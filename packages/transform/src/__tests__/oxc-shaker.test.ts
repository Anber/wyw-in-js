/* eslint-env jest */
import { join } from 'path';
import vm from 'vm';

import dedent from 'dedent';

import { emitOxcCommonJS } from '../utils/oxcEmit';
import { shakeOxcToESM } from '../utils/oxcShaker';

const filename = join(__dirname, 'source.tsx');

const run = (onlyExports: string[], code: string) =>
  shakeOxcToESM(dedent(code), filename, {
    onlyExports,
  });

const runSourceWidth = (input: string): { code: string; width: number } => {
  const { code } = run(['source'], input);
  const emitted = emitOxcCommonJS(code, filename);
  const exports: Record<string, unknown> = {};
  const module = { exports };
  vm.runInNewContext(emitted.code, { exports, module });
  return {
    code,
    width: (module.exports.source as { width: number }).width,
  };
};

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

  it('keeps alias mutations that can affect a surviving destructured value', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        const alias = source;
        const { selected = alias } = {};
        selected.width = 400;
        const { width } = source;
        const _exp = () => width;

        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('const alias = source');
    expect(code).toContain('const { selected = alias }');
    expect(code).toContain('selected.width = 400');
    expect(code).toContain('const { width } = source');
  });

  it('keeps top-level mutations through a local alias of a surviving export', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        export const source = { width: 304 };
        const alias = source;
        const nestedAlias = alias;
        nestedAlias.width = 400;
        const { width } = source;
        const _exp = () => width;

        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('const source = { width: 304 }');
    expect(code).toContain('const alias = source');
    expect(code).toContain('const nestedAlias = alias');
    expect(code).toContain('nestedAlias.width = 400');
    expect(code).not.toContain('export const source');
  });

  it('keeps nested mutations through a shallow object-rest copy', () => {
    const { code } = run(
      ['source'],
      `
        const source = {
          nested: { width: 304 },
        };
        const { ...rest } = source;
        rest.nested.width = 400;

        export { source };
      `
    );

    expect(code).toContain('const { ...rest } = source');
    expect(code).toContain('rest.nested.width = 400');
  });

  it('keeps reads and calls through nested object-rest values', () => {
    const aliased = run(
      ['source'],
      `
        const source = {
          nested: { width: 304 },
        };
        const { ...rest } = source;
        const nested = rest.nested;
        nested.width = 400;

        export { source };
      `
    ).code;
    const called = run(
      ['source'],
      `
        const source = {
          nested: { width: 304 },
        };
        const { ...rest } = source;
        function mutate(value) {
          value.width = 400;
        }
        mutate(rest.nested);

        export { source };
      `
    ).code;

    expect(aliased).toContain('const nested = rest.nested');
    expect(aliased).toContain('nested.width = 400');
    expect(called).toContain('function mutate(value)');
    expect(called).toContain('mutate(rest.nested)');
  });

  it('prunes top-level replacements on a shallow object-rest copy', () => {
    const { code } = run(
      ['source'],
      `
        const source = {
          nested: { width: 304 },
        };
        const { ...rest } = source;
        rest.nested = { width: 400 };

        export { source };
      `
    );

    expect(code).not.toContain('const { ...rest } = source');
    expect(code).not.toContain('rest.nested =');
  });

  it('tracks nested array-rest values without aliasing the copied array', () => {
    const kept = run(
      ['source'],
      `
        const source = [{ width: 304 }];
        const [...tail] = source;
        tail[0].width = 400;

        export { source };
      `
    ).code;
    const pruned = run(
      ['source'],
      `
        const source = [{ width: 304 }];
        const [...tail] = source;
        tail[0] = { width: 400 };

        export { source };
      `
    ).code;

    expect(kept).toContain('const [...tail] = source');
    expect(kept).toContain('tail[0].width = 400');
    expect(pruned).not.toContain('const [...tail] = source');
    expect(pruned).not.toContain('tail[0] =');
  });

  it.each([
    ['delete', 'delete rest.nested.width;', 'delete rest.nested.width'],
    [
      'destructuring assignment',
      '({ width: rest.nested.width } = { width: 400 });',
      'width: rest.nested.width',
    ],
    [
      'loop assignment target',
      'for ({ width: rest.nested.width } of [{ width: 400 }]) {}',
      'width: rest.nested.width',
    ],
  ])('keeps nested object-rest effects from %s', (_name, effect, expected) => {
    const { code } = run(
      ['source'],
      `
        const source = {
          nested: { width: 304 },
        };
        const { ...rest } = source;
        ${effect}

        export { source };
      `
    );

    expect(code).toContain('const { ...rest } = source');
    expect(code).toContain(expected);
  });

  it.each([
    ['delete', 'delete rest.nested;', 'delete rest.nested'],
    [
      'destructuring assignment',
      '({ nested: rest.nested } = { nested: { width: 400 } });',
      'nested: rest.nested',
    ],
    [
      'loop assignment target',
      'for (rest.nested of [{ width: 400 }]) {}',
      'rest.nested of',
    ],
  ])(
    'prunes shallow object-rest replacements from %s',
    (_name, effect, expected) => {
      const { code } = run(
        ['source'],
        `
          const source = {
            nested: { width: 304 },
          };
          const { ...rest } = source;
          ${effect}

          export { source };
        `
      );

      expect(code).not.toContain('const { ...rest } = source');
      expect(code).not.toContain(expected);
    }
  );

  it('keeps an opaque imported call that can mutate a surviving sibling import', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { mutate, source } from './tokens';

        mutate();
        const { width } = source;
        const _exp = () => width;

        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain("import { mutate, source } from './tokens'");
    expect(code).toContain('mutate()');
    expect(imports.get('./tokens')).toEqual(['mutate', 'source']);
  });

  it('keeps opaque imported calls across root import sources', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';
        import { mutate } from './factory';

        mutate();
        const { width } = source;
        const _exp = () => width;

        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain("import { source } from './tokens'");
    expect(code).toContain("import { mutate } from './factory'");
    expect(code).toContain('mutate()');
    expect(imports.get('./tokens')).toEqual(['source']);
    expect(imports.get('./factory')).toEqual(['mutate']);
  });

  it('keeps an opaque imported call through a top-level callable alias', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { mutate, source } from './tokens';

        const fn = mutate;
        fn();
        const { width } = source;
        const _exp = () => width;

        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain("import { mutate, source } from './tokens'");
    expect(code).toContain('const fn = mutate');
    expect(code).toContain('fn()');
    expect(imports.get('./tokens')).toEqual(['mutate', 'source']);
  });

  it('prunes dormant aliases of imported callables', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { mutate, source } from './tokens';

        const unused = mutate;
        function dormant() {
          unused();
        }

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).not.toContain('const unused = mutate');
    expect(code).not.toContain('function dormant');
    expect(code).not.toContain('unused()');
    expect(imports.get('./tokens')).toEqual(['source']);
  });

  it('keeps a reached mutation of a selected local root', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function mutate(value) {
          value.width = 400;
        }
        mutate(source);

        export { source };
      `
    );

    expect(code).toContain('const source =');
    expect(code).toContain('function mutate(value)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('mutate(source)');
    expect(code).toContain('export { source }');
  });

  it('keeps a reached mutation through an alias of a selected local root', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const alias = source;

        function mutate(value) {
          value.width = 400;
        }
        mutate(alias);

        export { source };
      `
    );

    expect(code).toContain('const source =');
    expect(code).toContain('const alias = source');
    expect(code).toContain('function mutate(value)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('mutate(alias)');
    expect(code).toContain('export { source }');
  });

  it('keeps a reached local-root mutation through a local call chain', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function mutate(value) {
          value.width = 400;
        }
        function forward(value) {
          mutate(value);
        }
        function wrapper(value) {
          forward(value);
        }
        wrapper(source);

        export { source };
      `
    );

    expect(code).toContain('const source =');
    expect(code).toContain('function mutate(value)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('function forward(value)');
    expect(code).toContain('mutate(value)');
    expect(code).toContain('function wrapper(value)');
    expect(code).toContain('forward(value)');
    expect(code).toContain('wrapper(source)');
    expect(code).toContain('export { source }');
  });

  it('keeps a selected local-root mutation through a bound callable', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function mutate(value) {
          value.width = 400;
        }
        const bound = mutate.bind(null, source);
        bound();

        export { source };
      `
    );

    expect(code).toContain('function mutate(value)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('const bound = mutate.bind(null, source)');
    expect(code).toContain('bound()');
  });

  it('keeps a selected local-root mutation through a returned closure', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make(value) {
          return () => {
            value.width = 400;
          };
        }
        const bound = make(source);
        bound();

        export { source };
      `
    );

    expect(code).toContain('function make(value)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('const bound = make(source)');
    expect(code).toContain('bound()');
  });

  it('keeps a mutation captured by an argument-free returned closure', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        const bound = make();
        bound();

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const bound = make()');
    expect(code).toContain('bound()');
  });

  it('keeps a returned closure capture through a factory-local alias', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          const alias = source;
          return () => {
            alias.width = 400;
          };
        }
        const bound = make();
        bound();

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('const alias = source');
    expect(code).toContain('alias.width = 400');
    expect(code).toContain('const bound = make()');
    expect(code).toContain('bound()');
  });

  it('keeps a captured mutation through a returned callable identity', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function mutate() {
          source.width = 400;
        }
        function make() {
          return mutate;
        }
        const bound = make();
        bound();

        export { source };
      `
    );

    expect(code).toContain('function mutate()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('function make()');
    expect(code).toContain('return mutate');
    expect(code).toContain('const bound = make()');
    expect(code).toContain('bound()');
  });

  it('prunes an invoked returned closure that captures an unrelated root', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const unrelated = { width: 320 };

        function make() {
          return () => {
            unrelated.width = 400;
          };
        }
        const bound = make();
        bound();

        export { source };
      `
    );

    expect(code).not.toContain('const unrelated =');
    expect(code).not.toContain('function make()');
    expect(code).not.toContain('unrelated.width = 400');
    expect(code).not.toContain('const bound = make()');
    expect(code).not.toContain('bound()');
  });

  it('prunes an uninvoked returned closure that captures the selected root', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        const bound = make();

        export { source };
      `
    );

    expect(code).not.toContain('function make()');
    expect(code).not.toContain('source.width = 400');
    expect(code).not.toContain('const bound = make()');
  });

  it('keeps an invoked callable result stored in an object property', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        const box = { bound: make() };
        box.bound();

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const box = { bound: make() }');
    expect(code).toContain('box.bound()');
  });

  it('keeps an invoked callable result stored at a static array index', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        const box = [make()];
        box[0]();

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const box = [make()]');
    expect(code).toContain('box[0]()');
  });

  it('keeps an invoked callable result assigned to a static member', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        const box = {};
        box.bound = make();
        box.bound();

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const box = {}');
    expect(code).toContain('box.bound = make()');
    expect(code).toContain('box.bound()');
  });

  it('keeps an invoked callable result from object destructuring', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return {
            bound() {
              source.width = 400;
            },
          };
        }
        const { bound } = make();
        bound();

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const { bound } = make()');
    expect(code).toContain('bound()');
  });

  it('keeps an invoked callable result from array destructuring assignment', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        let bound;

        function make() {
          return [
            () => {
              source.width = 400;
            },
          ];
        }
        [bound] = make();
        bound();

        export { source };
      `
    );

    expect(code).toContain('let bound');
    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('[bound] = make()');
    expect(code).toContain('bound()');
  });

  it('keeps callable-result container paths independent', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const unrelated = { width: 320 };

        function makeSource() {
          return () => {
            source.width = 400;
          };
        }
        function makeUnrelated() {
          return () => {
            unrelated.width = 480;
          };
        }
        const box = {
          selected: makeSource(),
          invoked: makeUnrelated(),
        };
        box.invoked();

        export { source };
      `
    );

    expect(code).not.toContain('const unrelated =');
    expect(code).not.toContain('function makeSource()');
    expect(code).not.toContain('function makeUnrelated()');
    expect(code).not.toContain('const box =');
    expect(code).not.toContain('box.invoked()');
  });

  it('prunes an invoked callable-result container with an unrelated capture', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const unrelated = { width: 320 };

        function make() {
          return () => {
            unrelated.width = 400;
          };
        }
        const box = { bound: make() };
        box.bound();

        export { source };
      `
    );

    expect(code).not.toContain('const unrelated =');
    expect(code).not.toContain('function make()');
    expect(code).not.toContain('const box =');
    expect(code).not.toContain('box.bound()');
  });

  it('threads returned-callable provenance through aliases and call chains', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make(value) {
          return () => {
            value.width = 400;
          };
        }
        const returned = make(source);
        const alias = returned;
        function invoke(fn) {
          fn();
        }
        function wrapper(fn) {
          invoke(fn);
        }
        wrapper(alias);

        export { source };
      `
    );

    expect(code).toContain('function make(value)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('const returned = make(source)');
    expect(code).toContain('const alias = returned');
    expect(code).toContain('function invoke(fn)');
    expect(code).toContain('fn()');
    expect(code).toContain('function wrapper(fn)');
    expect(code).toContain('wrapper(alias)');
  });

  it('prunes invoked callable-result provenance unrelated to the selected root', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const dead = { width: 320 };

        function make(value) {
          return () => {
            value.width = 400;
          };
        }
        const bound = make(dead);
        bound();

        export { source };
      `
    );

    expect(code).not.toContain('const dead =');
    expect(code).not.toContain('function make(value)');
    expect(code).not.toContain('value.width = 400');
    expect(code).not.toContain('const bound = make(dead)');
    expect(code).not.toContain('bound()');
  });

  it('keeps a captured callback passed through a local invoker', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function invoke(callback) {
          callback();
        }
        invoke(() => {
          source.width = 400;
        });

        export { source };
      `
    );

    expect(code).toContain('function invoke(callback)');
    expect(code).toContain('callback()');
    expect(code).toContain('invoke(() =>');
    expect(code).toContain('source.width = 400');
  });

  it('keeps a captured callback passed through an inline invoker', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        ((callback) => callback())(() => {
          source.width = 400;
        });

        export { source };
      `
    );

    expect(code).toContain('((callback) => callback())');
    expect(code).toContain('source.width = 400');
  });

  it('keeps a captured callback passed to an opaque member consumer', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        [0].forEach(() => {
          source.width = 400;
        });

        export { source };
      `
    );

    expect(code).toContain('[0].forEach(() =>');
    expect(code).toContain('source.width = 400');
  });

  it('keeps a captured callback passed to an unresolved opaque consumer', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        queueMicrotask(() => {
          source.width = 400;
        });

        export { source };
      `
    );

    expect(code).toContain('queueMicrotask(() =>');
    expect(code).toContain('source.width = 400');
  });

  it('keeps named and aliased captured callbacks passed to opaque consumers', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        const callback = () => {
          source.width = 400;
        };
        const alias = callback;
        queueMicrotask(alias);

        export { source };
      `
    );

    expect(code).toContain('const callback = () =>');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const alias = callback');
    expect(code).toContain('queueMicrotask(alias)');
  });

  it('prunes opaque callbacks without an external captured root', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        queueMicrotask(() => 1);
        queueMicrotask(() => {
          const local = { width: 320 };
          local.width = 400;
        });
        queueMicrotask((source) => {
          source.width = 480;
        });

        export { source };
      `
    );

    expect(code).not.toContain('queueMicrotask');
    expect(code).not.toContain('const local =');
    expect(code).not.toContain('local.width = 400');
    expect(code).not.toContain('source.width = 480');
  });

  it('does not let a nested shadow suppress an outer callback capture', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        const callback = () => {
          source.width = 400;
          function inner(source) {
            return source.width;
          }
          void inner;
        };
        queueMicrotask(callback);

        export { source };
      `
    );

    expect(code).toContain('const callback = () =>');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('function inner(source)');
    expect(code).toContain('queueMicrotask(callback)');
  });

  it('prunes a callback whose apparent capture is nested-local shadowing', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        queueMicrotask(() => {
          function inner(source) {
            source.width = 400;
          }
          void inner;
        });

        export { source };
      `
    );

    expect(code).not.toContain('queueMicrotask');
    expect(code).not.toContain('function inner(source)');
    expect(code).not.toContain('source.width = 400');
  });

  it('keeps an invoked closure returned from an IIFE', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        const bound = (() => () => {
          source.width = 400;
        })();
        bound();

        export { source };
      `
    );

    expect(code).toContain('const bound = (() => () =>');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('bound()');
  });

  it('keeps a directly invoked closure returned from an IIFE', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        (() => () => {
          source.width = 400;
        })()();

        export { source };
      `
    );

    expect(code).toContain('source.width = 400');
    expect(code).toContain('})()()');
  });

  it('keeps a call-result callback passed directly to an opaque consumer', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        queueMicrotask(make());

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('queueMicrotask(make())');
  });

  it('keeps a stored call-result callback passed to an opaque consumer', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        const callback = make();
        queueMicrotask(callback);

        export { source };
      `
    );

    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const callback = make()');
    expect(code).toContain('queueMicrotask(callback)');
  });

  it('keeps an invoked callable result under a computed container key', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const key = 'bound';

        function make() {
          return () => {
            source.width = 400;
          };
        }
        const box = { [key]: make() };
        box[key]();

        export { source };
      `
    );

    expect(code).toContain("const key = 'bound'");
    expect(code).toContain('function make()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const box = { [key]: make() }');
    expect(code).toContain('box[key]()');
  });

  it('keeps an invoked inline callable stored in an array', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function mutate() {
          source.width = 400;
        }
        [() => mutate()][0]();

        export { source };
      `
    );

    expect(code).toContain('function mutate()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('[() => mutate()][0]()');
  });

  it('keeps an invoked inline callable assigned to a member', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const box = {};
        box.bound = () => {
          source.width = 400;
        };
        box.bound();

        export { source };
      `
    );

    expect(code).toContain('const box = {}');
    expect(code).toContain('box.bound = () =>');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('box.bound()');
  });

  it('keeps an invoked destructured inline callable', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const [bound] = [
          () => {
            source.width = 400;
          },
        ];
        bound();

        export { source };
      `
    );

    expect(code).toContain('const [bound] =');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('bound()');
  });

  it('keeps an invoked class static method that captures a selected root', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        class Holder {
          static mutate() {
            source.width = 400;
          }
        }
        Holder.mutate();

        export { source };
      `
    );

    expect(code).toContain('class Holder');
    expect(code).toContain('static mutate()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('Holder.mutate()');
  });

  it('keeps captured sequence, conditional, and logical callees', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function mutate() {
          source.width = 400;
        }
        (0, mutate)();
        (true ? mutate : () => {})();
        (false || mutate)();

        export { source };
      `
    );

    expect(code).toContain('function mutate()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('(0, mutate)()');
    expect(code).toContain('(true ? mutate : () => {})()');
    expect(code).toContain('(false || mutate)()');
  });

  it('prunes inline callable flows with only local mutations', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        [() => {
          const local = { width: 320 };
          local.width = 400;
        }][0]();

        class Holder {
          static mutate() {
            const local = { width: 320 };
            local.width = 480;
          }
        }
        Holder.mutate();

        export { source };
      `
    );

    expect(code).not.toContain('const local =');
    expect(code).not.toContain('local.width =');
    expect(code).not.toContain('class Holder');
    expect(code).not.toContain('Holder.mutate()');
  });

  it('does not invoke a returned closure merely by calling a compound factory callee', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function make() {
          return () => {
            source.width = 400;
          };
        }
        (0, make)();

        export { source };
      `
    );

    expect(code).not.toContain('function make()');
    expect(code).not.toContain('source.width = 400');
    expect(code).not.toContain('(0, make)()');
  });

  it('keeps a callback capture used by a switch discriminant before its case scope', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        const callback = () => {
          switch (source) {
            case null:
              let source = 1;
              return source;
            default:
              return 0;
          }
        };
        queueMicrotask(callback);

        export { source };
      `
    );

    expect(code).toContain('const callback = () =>');
    expect(code).toContain('switch (source)');
    expect(code).toContain('let source = 1');
    expect(code).toContain('queueMicrotask(callback)');
  });

  it('keeps an outer callback capture separate from a static-block binding', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        const callback = () => {
          const width = source.width;
          class Holder {
            static {
              let source = 1;
              void source;
            }
          }
          void Holder;
          return width;
        };
        queueMicrotask(callback);

        export { source };
      `
    );

    expect(code).toContain('const width = source.width');
    expect(code).toContain('static {');
    expect(code).toContain('let source = 1');
    expect(code).toContain('queueMicrotask(callback)');
  });

  it('keeps a reached getter effect from a direct property read', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const box = {
          get measured() {
            source.width = 400;
            return source.width;
          },
        };
        void box.measured;

        export { source };
      `
    );

    expect(code).toContain('const box =');
    expect(code).toContain('get measured()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('void box.measured');
  });

  it('keeps a reached getter effect from object destructuring', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const box = {
          get measured() {
            source.width = 400;
            return source.width;
          },
        };
        const { measured } = box;

        export { source };
      `
    );

    expect(code).toContain('const box =');
    expect(code).toContain('get measured()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const { measured } = box');
  });

  it('keeps getter effects from object Get and CopyDataProperties', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const { measured, ...rest } = {
          get measured() {
            source.width = 400;
            return source.width;
          },
          get copied() {
            source.height = 500;
            return source.height;
          },
        };

        export { source };
      `
    );

    expect(code).toContain('const { measured, ...rest } =');
    expect(code).toContain('get measured()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('get copied()');
    expect(code).toContain('source.height = 500');
  });

  it('keeps pattern evaluation through a proxy and a custom iterator', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const proxy = new Proxy(
          { measured: 1 },
          {
            get(target, key) {
              source.width = 400;
              return target[key];
            },
          }
        );
        const { measured } = proxy;

        const iterable = {
          [Symbol.iterator]() {
            source.height = 500;
            return [1][Symbol.iterator]();
          },
        };
        const [first] = iterable;

        export { source };
      `
    );

    expect(code).toContain('const proxy = new Proxy');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('const { measured } = proxy');
    expect(code).toContain('[Symbol.iterator]()');
    expect(code).toContain('source.height = 500');
    expect(code).toContain('const [first] = iterable');
  });

  it('preserves potentially abrupt unused object and array patterns', () => {
    const { code } = run(
      ['source'],
      `
        const { measured } = null;
        const [first] = {};
        const source = { width: 304 };

        export { source };
      `
    );

    expect(code).toContain('const { measured } = null');
    expect(code).toContain('const [first] = {}');
  });

  it('prunes proven-safe patterns and non-accessor property reads', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const box = {
          measured() {
            source.width = 400;
          },
          value: 1,
        };
        void box.measured;
        const { value } = { value: 1 };
        const [first] = [1];

        export { source };
      `
    );

    expect(code).not.toContain('const box =');
    expect(code).not.toContain('source.width = 400');
    expect(code).not.toContain('void box.measured');
    expect(code).not.toContain('const { value } =');
    expect(code).not.toContain('const [first] =');
  });

  it.each([
    [
      'a dynamically selected callable container slot',
      `
        const source = { width: 304 };
        const key = 0;
        const box = [() => {
          source.width = 400;
        }];
        box[key]();
        export { source };
      `,
    ],
    [
      'a reached instance method on a constructed class',
      `
        const source = { width: 304 };
        class Mutator {
          mutate() {
            source.width = 400;
          }
        }
        new Mutator().mutate();
        export { source };
      `,
    ],
    [
      'a computed object getter',
      `
        const source = { width: 304 };
        const key = 'm';
        const box = {
          get [key]() {
            source.width = 400;
            return 1;
          },
        };
        void box[key];
        export { source };
      `,
    ],
    [
      'an instance getter',
      `
        const source = { width: 304 };
        class Measured {
          get m() {
            source.width = 400;
            return 1;
          }
        }
        const box = new Measured();
        void box.m;
        export { source };
      `,
    ],
    [
      'a Proxy get trap',
      `
        const source = { width: 304 };
        const box = new Proxy({}, {
          get() {
            source.width = 400;
            return 1;
          },
        });
        void box.m;
        export { source };
      `,
    ],
    [
      'an accessor installed with Object.defineProperty',
      `
        const source = { width: 304 };
        const box = {};
        Object.defineProperty(box, 'm', {
          get() {
            source.width = 400;
            return 1;
          },
        });
        void box.m;
        export { source };
      `,
    ],
    [
      'a Proxy set trap',
      `
        const source = { width: 304 };
        const box = new Proxy({}, {
          set() {
            source.width = 400;
            return true;
          },
        });
        box.m = 1;
        export { source };
      `,
    ],
    [
      'a Proxy deleteProperty trap',
      `
        const source = { width: 304 };
        const box = new Proxy({}, {
          deleteProperty() {
            source.width = 400;
            return true;
          },
        });
        delete box.m;
        export { source };
      `,
    ],
    [
      'a Proxy has trap',
      `
        const source = { width: 304 };
        const box = new Proxy({}, {
          has() {
            source.width = 400;
            return false;
          },
        });
        void ('m' in box);
        export { source };
      `,
    ],
    [
      'a Proxy ownKeys trap',
      `
        const source = { width: 304 };
        const box = new Proxy({}, {
          ownKeys() {
            source.width = 400;
            return [];
          },
        });
        Object.keys(box);
        export { source };
      `,
    ],
    [
      'a Proxy GetIterator operation',
      `
        const source = { width: 304 };
        const box = new Proxy([], {
          get(target, key, receiver) {
            if (key === Symbol.iterator) {
              source.width = 400;
            }
            return Reflect.get(target, key, receiver);
          },
        });
        for (const value of box) {
          void value;
        }
        export { source };
      `,
    ],
    [
      'a plain-object setter',
      `
        const source = { width: 304 };
        const box = {
          set m(value) {
            source.width = value;
          },
        };
        box.m = 400;
        export { source };
      `,
    ],
    [
      'a custom iterator in for-of',
      `
        const source = { width: 304 };
        const iterable = {
          [Symbol.iterator]() {
            source.width = 400;
            return [][Symbol.iterator]();
          },
        };
        for (const value of iterable) {
          void value;
        }
        export { source };
      `,
    ],
    [
      'a custom iterator in array spread',
      `
        const source = { width: 304 };
        const iterable = {
          [Symbol.iterator]() {
            source.width = 400;
            return [][Symbol.iterator]();
          },
        };
        void [...iterable];
        export { source };
      `,
    ],
    [
      'a delegated generator iterator',
      `
        const source = { width: 304 };
        const iterable = {
          [Symbol.iterator]() {
            source.width = 400;
            return [][Symbol.iterator]();
          },
        };
        function* values() {
          yield* iterable;
        }
        void [...values()];
        export { source };
      `,
    ],
    [
      'an object-spread getter',
      `
        const source = { width: 304 };
        const box = {
          get m() {
            source.width = 400;
            return 1;
          },
        };
        void { ...box };
        export { source };
      `,
    ],
    [
      'an instance field initializer',
      `
        const source = { width: 304 };
        class Mutator {
          field = (source.width = 400);
        }
        new Mutator();
        export { source };
      `,
    ],
    [
      'an inline class constructor',
      `
        const source = { width: 304 };
        new (class {
          constructor() {
            source.width = 400;
          }
        })();
        export { source };
      `,
    ],
    [
      'an implicit derived constructor',
      `
        const source = { width: 304 };
        class Base {
          constructor() {
            source.width = 400;
          }
        }
        class Child extends Base {}
        new Child();
        export { source };
      `,
    ],
    [
      'an inherited getter during object projection',
      `
        const source = { width: 304 };
        const { x } = {
          __proto__: {
            get x() {
              source.width = 400;
              return 1;
            },
          },
        };
        void x;
        export { source };
      `,
    ],
    [
      'a mutated intrinsic array iterator during projection',
      `
        const source = { width: 304 };
        Array.prototype[Symbol.iterator] = function* iterator() {
          source.width = 400;
        };
        const [x] = [1];
        void x;
        export { source };
      `,
    ],
  ])('preserves selected-source effects through %s', (_name, input) => {
    const result = runSourceWidth(input);

    expect(result.width).toBe(400);
  });

  it('prunes proven plain-data receiver operations and unrelated dynamic callables', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        const key = 'm';
        const box = { m: 1 };
        void box[key];
        void ('m' in box);
        Object.keys(box);
        void { ...box };

        const writable = { m: 1 };
        writable.m = 2;
        const removable = { m: 1 };
        delete removable.m;

        const values = [1];
        for (const value of values) {
          void value;
        }
        void [...values];

        const callableKey = 0;
        const callables = [() => 1];
        callables[callableKey]();

        class LocalMutator {
          mutate() {
            const local = { width: 320 };
            local.width = 400;
          }
        }
        new LocalMutator().mutate();

        export { source };
      `
    );

    expect(code).not.toContain("const key = 'm'");
    expect(code).not.toContain('const box =');
    expect(code).not.toContain('const writable =');
    expect(code).not.toContain('const removable =');
    expect(code).not.toContain('const values =');
    expect(code).not.toContain('const callableKey =');
    expect(code).not.toContain('const callables =');
    expect(code).not.toContain('class LocalMutator');
  });

  it('keeps effects reached through direct, aliased, and member tags', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function direct() {
          source.width = 400;
        }
        direct\`direct\`;

        const mutate = () => {
          source.height = 500;
        };
        const alias = mutate;
        alias\`alias\`;

        const tags = {
          member() {
            source.depth = 600;
          },
        };
        tags.member\`member\`;

        export { source };
      `
    );

    expect(code).toContain('function direct()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('direct`direct`');
    expect(code).toContain('const alias = mutate');
    expect(code).toContain('source.height = 500');
    expect(code).toContain('alias`alias`');
    expect(code).toContain('const tags =');
    expect(code).toContain('source.depth = 600');
    expect(code).toContain('tags.member`member`');
  });

  it('prunes tag callables that are only referenced but never invoked', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        function mutate() {
          source.width = 400;
        }
        const tag = mutate;
        void tag;

        export { source };
      `
    );

    expect(code).not.toContain('function mutate()');
    expect(code).not.toContain('source.width = 400');
    expect(code).not.toContain('const tag = mutate');
    expect(code).not.toContain('void tag');
  });

  it('keeps effects reached through a local class constructor', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        class Mutate {
          constructor() {
            source.width = 400;
          }
        }
        new Mutate();

        export { source };
      `
    );

    expect(code).toContain('class Mutate');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('new Mutate()');
  });

  it('keeps effects reached through aliased and member constructors', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };

        function MutateWidth() {
          source.width = 400;
        }
        const Alias = MutateWidth;
        new Alias();

        const constructors = {
          MutateHeight: function MutateHeight() {
            source.height = 500;
          },
        };
        new constructors.MutateHeight();

        export { source };
      `
    );

    expect(code).toContain('function MutateWidth()');
    expect(code).toContain('const Alias = MutateWidth');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('new Alias()');
    expect(code).toContain('const constructors =');
    expect(code).toContain('source.height = 500');
    expect(code).toContain('new constructors.MutateHeight()');
  });

  it('prunes constructors that are never instantiated', () => {
    const { code } = run(
      ['source'],
      `
        const source = { width: 304 };
        class Mutate {
          constructor() {
            source.width = 400;
          }
        }
        const Alias = Mutate;
        void Alias;

        export { source };
      `
    );

    expect(code).not.toContain('class Mutate');
    expect(code).not.toContain('source.width = 400');
    expect(code).not.toContain('const Alias = Mutate');
    expect(code).not.toContain('void Alias');
  });

  it('keeps imported mutations reached through a local call chain', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        function mutate() {
          source.width = 400;
        }
        function middle() {
          mutate();
        }
        function wrapper() {
          middle();
        }
        wrapper();

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('function mutate()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('function middle()');
    expect(code).toContain('function wrapper()');
    expect(code).toContain('wrapper()');
  });

  it('threads local aliases and parameters through a local call chain', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        function mutate(value) {
          value.width = 400;
        }
        function middle(value) {
          const forwarded = value;
          const fn = mutate;
          fn(forwarded);
        }
        function wrapper() {
          const local = source;
          middle(local);
        }
        wrapper();

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('const local = source');
    expect(code).toContain('middle(local)');
    expect(code).toContain('const forwarded = value');
    expect(code).toContain('const fn = mutate');
    expect(code).toContain('fn(forwarded)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('wrapper()');
  });

  it('keeps an imported callable alias invoked inside a local wrapper', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { mutate, source } from './tokens';

        function wrapper() {
          const fn = mutate;
          fn();
        }
        wrapper();

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('const fn = mutate');
    expect(code).toContain('fn()');
    expect(code).toContain('wrapper()');
    expect(imports.get('./tokens')).toEqual(['mutate', 'source']);
  });

  it('threads invocation provenance through a recursive local cycle', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        let recurse = true;
        function visit(value) {
          if (recurse) {
            recurse = false;
            relay(value);
          }
        }
        function relay(value) {
          value.width = 400;
          visit(value);
        }
        function wrapper() {
          const local = source;
          visit(local);
        }
        wrapper();

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('function visit(value)');
    expect(code).toContain('function relay(value)');
    expect(code).toContain('value.width = 400');
    expect(code).toContain('visit(local)');
  });

  it('prunes a dormant local-provenance call graph', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        function mutate(value) {
          value.width = 400;
        }
        function wrapper() {
          const local = source;
          mutate(local);
        }

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).not.toContain('function mutate(value)');
    expect(code).not.toContain('function wrapper()');
    expect(code).not.toContain('value.width = 400');
  });

  it('keeps imported mutations reached through a local object method', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        const helpers = {
          mutate() {
            source.width = 400;
          },
        };
        helpers.mutate();

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('const helpers =');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('helpers.mutate()');
  });

  it('handles recursive local object-method cycles', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        let recurse = true;
        const helpers = {
          first() {
            if (recurse) {
              recurse = false;
              helpers.second();
            }
          },
          second() {
            source.width = 400;
            helpers.first();
          },
        };
        helpers.first();

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('first()');
    expect(code).toContain('second()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('helpers.first()');
  });

  it('prunes dormant local object methods with imported mutations', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        const helpers = {
          mutate() {
            source.width = 400;
          },
          wrapper() {
            helpers.mutate();
          },
        };

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).not.toContain('const helpers =');
    expect(code).not.toContain('source.width = 400');
    expect(code).not.toContain('helpers.mutate()');
  });

  it('handles recursive local-call cycles that reach an imported mutation', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        let recurse = true;
        function first() {
          if (recurse) {
            recurse = false;
            second();
          }
        }
        function second() {
          source.width = 400;
          first();
        }
        first();

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain('function first()');
    expect(code).toContain('function second()');
    expect(code).toContain('source.width = 400');
    expect(code).toContain('first()');
  });

  it('prunes a dormant local call graph with imported mutations', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        function mutate() {
          source.width = 400;
        }
        function wrapper() {
          mutate();
        }

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).not.toContain('function mutate()');
    expect(code).not.toContain('function wrapper()');
    expect(code).not.toContain('source.width = 400');
  });

  it('keeps cross-source imported mutations and opaque returned aliases', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';
        import { getSource, sibling } from './factory';

        sibling.width = 400;
        const alias = getSource();
        alias.height = 500;
        const { width, height } = source;
        const _exp = () => width + height;

        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain("import { source } from './tokens'");
    expect(code).toContain("import { getSource, sibling } from './factory'");
    expect(code).toContain('sibling.width = 400');
    expect(code).toContain('const alias = getSource()');
    expect(code).toContain('alias.height = 500');
  });

  it.each([
    [
      'a class static field',
      `
        class Holder {
          static value = source;
        }
        Holder.value.width = 400;
      `,
      'Holder.value.width = 400',
    ],
    [
      'an invoked parameter default',
      `
        ((value = source) => {
          value.width = 400;
        })();
      `,
      'value.width = 400',
    ],
    [
      'a for-of binding default',
      `
        for (const { value = source } of [{}]) {
          value.width = 400;
        }
      `,
      'value.width = 400',
    ],
    [
      'a for-of value alias',
      `
        for (const alias of [source]) {
          alias.width = 400;
        }
      `,
      'alias.width = 400',
    ],
    [
      'a thrown catch alias',
      `
        try {
          throw source;
        } catch (alias) {
          alias.width = 400;
        }
      `,
      'alias.width = 400',
    ],
    [
      'an argument passed to a local mutator',
      `
        const alias = source;
        function mutate(value) {
          value.width = 400;
        }
        mutate(alias);
      `,
      'mutate(alias)',
    ],
    [
      'a constructor argument',
      `
        class Mutator {
          constructor(value) {
            value.width = 400;
          }
        }
        new Mutator(source);
      `,
      'new Mutator(source)',
    ],
    [
      'a tagged-template interpolation',
      `
        function mutate(_strings, value) {
          value.width = 400;
        }
        mutate\`\${source}\`;
      `,
      'mutate`${source}`',
    ],
  ])('keeps module-executed mutations through %s', (_name, setup, effect) => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        ${setup}
        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).toContain(effect);
  });

  it('does not retain mutations inside dormant functions', () => {
    const { code } = run(
      ['__wywPreval'],
      `
        import { source } from './tokens';

        function dormant() {
          source.width = 400;
        }

        const { width } = source;
        const _exp = () => width;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).not.toContain('function dormant');
    expect(code).not.toContain('source.width = 400');
  });

  it('prunes an entirely dead imported effect cohort', () => {
    const { code, imports } = run(
      ['__wywPreval'],
      `
        import { dead } from './tokens';
        import { styled } from './styled';
        import SvgHelper from './icon.svg';

        dead.width = 400;
        styled(dead);
        SvgHelper();

        const _exp = () => 304;
        export const __wywPreval = {
          _exp,
        };
      `
    );

    expect(code).not.toContain('dead.width');
    expect(code).not.toContain('./styled');
    expect(code).not.toContain('./icon.svg');
    expect(imports.has('./tokens')).toBe(false);
    expect(imports.has('./styled')).toBe(false);
    expect(imports.has('./icon.svg')).toBe(false);
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
