import { join } from 'path';

import * as babel from '@babel/core';
import dedent from 'dedent';

import { shaker } from '../shaker';

const run = (only: string[]) => (code: TemplateStringsArray) => {
  const filename = join(__dirname, 'source.ts');
  const formattedCode = dedent(code);
  const parsed = babel.parseSync(formattedCode, {
    filename,
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
      },
      highPriorityPlugins: [],
      onlyExports: only,
    },
    babel
  )[1];
};

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
});
