/* eslint-env jest */
import { stripTypesAndJsxWithOxc } from '../utils/oxcEmit';
import {
  addRequireFallbackWithOxc,
  removeDangerousCodeWithOxc,
  replaceImportMetaEnvWithOxc,
  rewriteDynamicImportsWithOxc,
} from '../utils/oxcPreevalTransforms';

const filename = '/test.ts';

describe('oxc preeval transforms', () => {
  describe('import.meta.env rewrite', () => {
    it('replaces Vite-style import.meta.env object access', () => {
      expect(
        replaceImportMetaEnvWithOxc(
          'const { MODE } = import.meta.env; const dev = import.meta.env.DEV;',
          filename
        )
      ).toBe(
        'const { MODE } = __wyw_import_meta_env; const dev = __wyw_import_meta_env.DEV;'
      );
    });

    it('does not replace computed import.meta access', () => {
      expect(
        replaceImportMetaEnvWithOxc('const env = import.meta["env"];', filename)
      ).toBe('const env = import.meta["env"];');
    });
  });

  describe('dynamic import rewrite', () => {
    it('unwraps TS assertion for string literal specifier', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo() { import("./foo" as any).then(() => null); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo").then');
    });

    it('keeps TS assertion for non-string-like specifier', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import(locale as any).then(() => null); }',
          filename
        )
      ).toContain('__wyw_dynamic_import(locale as any).then');
    });

    it('unwraps TS assertion for string concatenation', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import(("./foo/" + locale) as any); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo/" + locale)');
    });

    it('unwraps TS assertion for concat call', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import(("./foo/".concat(locale, ".json")) as any); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo/".concat(locale, ".json"))');
    });

    it('unwraps TS assertion for template literal', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo(locale: unknown) { import((`./foo/${locale}` as any)); }',
          filename
        )
      ).toContain('__wyw_dynamic_import("./foo/" + locale)');
    });

    it('does not treat conditional expression as string-like', () => {
      expect(
        rewriteDynamicImportsWithOxc(
          'function foo() { import((Math.random() > 0.5 ? "a" : "b") as any); }',
          filename
        )
      ).toContain(
        '__wyw_dynamic_import((Math.random() > 0.5 ? "a" : "b") as any)'
      );
    });
  });

  describe('require fallback rewrite', () => {
    it('does not change literal require calls', () => {
      expect(addRequireFallbackWithOxc("require('./dep')", filename)).toBe(
        "require('./dep')"
      );
    });

    it('does not change no-expression template literal require calls', () => {
      expect(addRequireFallbackWithOxc('require(`./dep`)', filename)).toBe(
        'require(`./dep`)'
      );
    });

    it('adds fallback marker for non-literal require calls', () => {
      expect(addRequireFallbackWithOxc('require(dep)', filename)).toBe(
        'require(dep, true)'
      );
    });

    it('inlines statically evaluable string require calls', () => {
      expect(
        addRequireFallbackWithOxc(
          [
            'const url = "./__fixtures__/FOO";',
            'require(url.toLowerCase());',
          ].join('\n'),
          filename
        )
      ).toBe(
        ['const url = "./__fixtures__/FOO";', 'require("./__fixtures__/foo");'].join(
          '\n'
        )
      );
    });

    it('keeps fallback marker for statically evaluable bare package requires', () => {
      expect(
        addRequireFallbackWithOxc(
          ['const pkg = "fake";', 'require(pkg);'].join('\n'),
          filename
        )
      ).toBe(['const pkg = "fake";', 'require(pkg, true);'].join('\n'));
    });

    it('preserves local require shadowing', () => {
      expect(
        addRequireFallbackWithOxc(
          'function load() { const require = makeRequire(); require(dep); }',
          filename
        )
      ).toBe(
        'function load() { const require = makeRequire(); require(dep); }'
      );
    });
  });

  describe('dangerous code removal', () => {
    it('replaces SSR typeof checks with undefined literals', () => {
      expect(
        removeDangerousCodeWithOxc(
          'if (typeof window !== "undefined") { doBrowserWork(); }',
          filename
        )
      ).toContain('"undefined" !== "undefined"');
    });

    it('removes browser-global statements', () => {
      const code = removeDangerousCodeWithOxc(
        'const first = fetch; const second = window.fetch; const keep = 1;',
        filename
      );

      expect(code).not.toContain('fetch');
      expect(code).not.toContain('first');
      expect(code).not.toContain('second');
      expect(code).toContain('keep');
    });

    it('removes queued globals when matching window members appear later', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const first = fetch;',
          'const second = fetch;',
          'const third = window.fetch;',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('fetch');
      expect(code).not.toContain('first');
      expect(code).not.toContain('second');
      expect(code).not.toContain('third');
    });

    it('removes exported browser-global declarations without leaving dangling export syntax', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export const isApple = /Mac|iPhone|iPad/.test(navigator.platform);',
          'export const isMac = navigator.platform.toLocaleLowerCase().includes("mac");',
          'export const keep = 1;',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('navigator');
      expect(code).not.toContain('export ;');
      expect(code).not.toContain('export \n');
      expect(code).toContain('export const keep = 1;');
    });

    it('removes class fields initialized from browser globals without leaving invalid member expressions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export class Model {',
          '  private readonly input = document.createElement("input");',
          '  readonly keep = 1;',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('document.createElement');
      expect(code).not.toContain('= .createElement');
      expect(code).toContain('readonly keep = 1;');
    });

    it('removes browser-global aliases without leaving invalid control flow', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export const removeLoader = () => {',
          '  const loader = document.getElementById("preloader");',
          '  if (loader) document.body.removeChild(loader);',
          '};',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('document.getElementById');
      expect(code).not.toContain('removeChild(loader)');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves valid default export syntax when a browser-bound component is sanitized', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const InitialLoader = () => {',
          '  document.getElementById("preloader");',
          '  return <div />;',
          '};',
          'export default InitialLoader;',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).not.toContain('export default ;');
      expect(code).toContain('export default InitialLoader;');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('preserves generated processor helper closures that reference sanitized bindings', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const CommonModal = () => {',
          '  document.body.style.overflowY = "hidden";',
          '  return <div />;',
          '};',
          'const _exp = () => CommonModal;',
          'export default { __wyw_meta: { extends: _exp() } };',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('const _exp = () => CommonModal;');
      expect(code).not.toContain('"extends": ()');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('preserves object-property references to sanitized local bindings', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const Body = () => {',
          '  document.body.style.overflowY = "hidden";',
          '  return <div />;',
          '};',
          'export default { body: Body };',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('export default { body: Body };');
      expect(code).not.toContain('body: ,');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('replaces object spread references to removed local bindings with empty objects', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const details = (() => {',
          '  document.body.style.overflowY = "hidden";',
          '  return { Panel: { body: 1 } };',
          '})();',
          'export default { ...details.Panel };',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('export default { ...{} };');
      expect(code).not.toContain('....Panel');
      expect(() => stripTypesAndJsxWithOxc(code, '/test.tsx')).not.toThrow();
    });

    it('removes transitive aliases of browser-global values without leaving dangling references', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'function read(version) {',
          '  const raw = localStorage.getItem("key");',
          '  const parsed = JSON.parse(raw);',
          '  if (parsed.version !== version) {',
          '    return null;',
          '  }',
          '  return parsed.value;',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('localStorage');
      expect(code).not.toContain('parsed.version');
      expect(code).not.toContain('parsed.value');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('removes loops tied to browser globals without leaving invalid for syntax', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'function clear(prefix) {',
          '  for (let i = localStorage.length - 1; i >= 0; i--) {',
          '    const key = localStorage.key(i);',
          '    if (key && key.startsWith(prefix)) {',
          '      localStorage.removeItem(key);',
          '    }',
          '  }',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('localStorage.length');
      expect(code).not.toContain('for (;');
      expect(code).not.toContain('localStorage.removeItem');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('removes local React refresh helpers and their direct aliases', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'var _s = $RefreshSig$();',
          'function Component() { _s(); return null; }',
          '$RefreshReg$(Component, "Component");',
          'function $RefreshReg$(type, id) { return type; }',
          'function $RefreshSig$() { return () => () => {}; }',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('$RefreshReg$');
      expect(code).not.toContain('$RefreshSig$');
      expect(code).not.toContain('_s(');
      expect(code).toContain('function Component()');
    });

    it('removes promise callback chains using forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          "const base = Promise.resolve('ok');",
          'base.then(() => setTimeout(() => {}));',
          'const keep = 1;',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('.then');
      expect(code).not.toContain('setTimeout');
      expect(code).toContain('keep');
    });

    it('replaces JSX with null', () => {
      const code = removeDangerousCodeWithOxc(
        'const Component = () => <div>Children</div>;',
        '/test.tsx'
      );

      expect(code).toBe('const Component = () => { return null; };');
    });

    it('replaces React runtime component bodies with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import { jsx as _jsx } from "react/jsx-runtime";',
          'const Component = (props) => _jsx("div", props);',
        ].join('\n'),
        '/test.tsx'
      );

      expect(code).toContain('const Component = () => { return null; };');
    });

    it('replaces transpiled CommonJS React createElement component bodies with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'var _interopRequireWildcard = require("@babel/runtime/helpers/interopRequireWildcard").default;',
          'var React = _interopRequireWildcard(require("react"));',
          'const Component = (props) => React.createElement("div", props);',
        ].join('\n'),
        filename
      );

      expect(code).toContain('const Component = () => { return null; };');
      expect(code).not.toContain('React.createElement');
    });

    it('replaces components matched by configured type imports', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import type React from "react";',
          'import type { Cmp } from "some-other-lib";',
          'const First: React.FC<{ children: string }> = ({ children }) => children;',
          'const Second: Cmp<{ children: string }> = ({ children }) => children;',
          'const Third = ({ children }) => children;',
        ].join('\n'),
        '/test.tsx',
        {
          componentTypes: {
            react: ['...'],
            'some-other-lib': ['Cmp'],
          },
        }
      );

      expect(code).toContain(
        'const First: React.FC<{ children: string }> = () => null;'
      );
      expect(code).toContain(
        'const Second: Cmp<{ children: string }> = () => null;'
      );
      expect(code).toContain('const Third = ({ children }) => children;');
    });

    it('replaces configured HOC calls with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'import { connect } from "redux";',
          'import Redux from "redux";',
          'const First = connect(mapStateToProps)(MyComponent);',
          'const Second = Redux.connect(mapStateToProps)(MyComponent);',
        ].join('\n'),
        filename,
        {
          hocs: {
            redux: ['connect'],
          },
        }
      );

      expect(code).toContain('const First = () => null;');
      expect(code).toContain('const Second = () => null;');
    });

    it('replaces class render components with null-returning functions', () => {
      const code = removeDangerousCodeWithOxc(
        'class Component { render() { return <div />; } }',
        '/test.tsx'
      );

      expect(code).toBe('function Component() { return null; }');
    });

    it('preserves class methods whose name matches a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export class Api {',
          '  fetch() { return 1; }',
          '  setTimeout() { return 2; }',
          '  keep() { return 3; }',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('fetch() { return 1; }');
      expect(code).toContain('setTimeout() { return 2; }');
      expect(code).toContain('keep() { return 3; }');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves class fields whose name matches a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'export class Api {',
          '  fetch = 1;',
          '  setTimeout = 2;',
          '  keep = 3;',
          '}',
        ].join('\n'),
        filename
      );

      expect(code).toContain('fetch = 1;');
      expect(code).toContain('setTimeout = 2;');
      expect(code).toContain('keep = 3;');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('preserves object property keys whose name matches a forbidden global', () => {
      const code = removeDangerousCodeWithOxc(
        'export default { fetch: 1, setTimeout: 2, keep: 3 };',
        filename
      );

      expect(code).toContain('fetch: 1');
      expect(code).toContain('setTimeout: 2');
      expect(code).toContain('keep: 3');
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });

    it('does not skip computed property keys that reference forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'const dangerous = { [fetch]: 1 };',
          'const keep = 1;',
        ].join('\n'),
        filename
      );

      expect(code).not.toContain('[fetch]');
      expect(code).not.toContain('dangerous');
      expect(code).toContain('const keep = 1;');
    });

    it('preserves shorthand re-exports of locally-bound helpers transitively touching forbidden globals', () => {
      const code = removeDangerousCodeWithOxc(
        [
          'let initEventListener = () => {',
          '  window.addEventListener("message", (event) => {',
          '    setTimeout(() => notify(event.data), 50);',
          '  });',
          '  initEventListener = () => {};',
          '};',
          'const listeners = new Set();',
          'const subscribe = (fn) => { initEventListener(); listeners.add(fn); };',
          'const unsubscribe = (fn) => { listeners.delete(fn); };',
          'export default { subscribe, unsubscribe };',
        ].join('\n'),
        filename
      );

      expect(code).toContain('export default { subscribe, unsubscribe }');
      expect(code).not.toMatch(/\{\s*,/);
      expect(() => stripTypesAndJsxWithOxc(code, filename)).not.toThrow();
    });
  });
});
