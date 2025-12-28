import { join } from 'path';

import * as babel from '@babel/core';
import dedent from 'dedent';

import { shaker } from '../shaker';

const compile = (only: string[]) => (code: TemplateStringsArray) => {
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
    },
    babel
  );
};

const run = (only: string[]) => (code: TemplateStringsArray) =>
  compile(only)(code)[1];

describe('shaker', () => {
  it('should carefully shake used exports', () => {
    const code = run(['__wywPreval'])`
      "use strict";

      Object.defineProperty(exports, "__esModule", {
        value: true
      });
      exports.activeClass = void 0;
      exports.activeClass = "s1gxjcbn";
      const _exp = /*#__PURE__*/() => exports.activeClass;
      exports.__wywPreval = {
        _exp: _exp,
      };
    `;

    expect(code).toMatchSnapshot();
  });

  it('should remove enum', () => {
    const code = run(['__wywPreval'])`
      "use strict";

      var PanelKinds;
      (function (PanelKinds) {
        PanelKinds["DEFAULT"] = "default";
        PanelKinds["TRANSPARENT"] = "transparent";
      })(PanelKinds = exports.PanelKinds || (exports.PanelKinds = {}));
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

      exports.__wywPreval = {
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
});
