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
});
