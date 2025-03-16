import { join } from 'path';

import { transformSync } from '@babel/core';
import dedent from 'dedent';

import { preeval } from '../plugins/preeval';

const run = (code: TemplateStringsArray) => {
  const filename = join(__dirname, 'source.tsx');
  const formattedCode = dedent(code);

  const transformed = transformSync(formattedCode, {
    babelrc: false,
    configFile: false,
    filename,
    plugins: [
      [
        '@babel/plugin-syntax-typescript',
        {
          isTSX: true,
        },
      ],
      [
        preeval,
        {
          codeRemover: {
            componentTypes: {
              react: ['...'],
              'some-other-lib': ['Cmp'],
            },
            hocs: {
              redux: ['connect'],
            },
          },
          evaluate: true,
          features: {
            dangerousCodeRemover: true,
          },
        },
      ],
    ],
  });

  if (!transformed) {
    throw new Error(`Something went wrong with ${filename}`);
  }

  return {
    code: transformed.code,
  };
};

describe('preeval', () => {
  it('should keep getGlobal but remove window-related code', () => {
    const { code } = run`
      function getGlobal() {
        if (typeof globalThis !== "undefined") {
          return globalThis;
        }

        if (typeof window !== "undefined") {
          return window;
        }

        if (typeof global !== "undefined") {
          return global;
        }

        if (typeof self !== "undefined") {
          return self;
        }

        return mockGlobal;
      }
    `;

    expect(code).toMatchSnapshot();
  });

  it('should remove usages of window scoped identifiers', () => {
    const { code } = run`
      $RefreshReg$("Container");
      if (import.meta.hot) {
        window.$RefreshReg$ = () => {};
      }

      $RefreshReg$("Header");
    `;

    expect(code).toMatchSnapshot();
  });

  it('should not remove "location" in types only because it looks like a global variable', () => {
    const { code } = run`
      interface IProps {
        fn: (location: string) => void;
      }
    `;

    expect(code).toMatchSnapshot();
  });

  it('should keep object members that look like window globals', () => {
    const { code } = run`
      class Test {
        fetch: typeof global.fetch;
        constructor(options) {
          this.fetch = options.fetch;
        }
      }
    `;

    expect(code).toMatchSnapshot();
  });

  it('should keep type parameters that look like window globals', () => {
    const { code } = run`
      const blah = window.Foo;
      type FooType = Generic<Foo>;
    `;

    expect(code).toMatchSnapshot();
  });

  it('should simplify react component', () => {
    const { code } = run`
      const Component = () => <div>Children</div>;
    `;

    expect(code).toMatchSnapshot();
  });

  it('should simplify react component based on its type 1', () => {
    const { code } = run`
      import type React from "react";
      const Component: React.FC<{ children: string }> = ({ children }) => children;
    `;

    expect(code).toMatchSnapshot();
  });

  it('should simplify react component based on its type 2', () => {
    const { code } = run`
      import type { Cmp } from "some-other-lib";
      const Component: Cmp<{ children: string }> = ({ children }) => children;
    `;

    expect(code).toMatchSnapshot();
  });

  it('should keep component as is for unknown type', () => {
    const { code } = run`
      import type { OtherCmp } from "some-other-lib";
      const Component: OtherCmp<{ children: string }> = ({ children }) => children;
    `;

    expect(code).toMatchSnapshot();
  });

  it('should remove specified HOCs', () => {
    const { code } = run`
      import { connect } from "redux";
      import { MyComponent } from "ui-kit";

      const mapStateToProps = (state) => ({ todos: state.todos })
      const Component = connect(mapStateToProps)(MyComponent);
    `;

    expect(code).toMatchSnapshot();
  });

  it('should remove HOC imported with namespace', () => {
    const { code } = run`
      import Redux from "redux";
      import { MyComponent } from "ui-kit";

      const mapStateToProps = (state) => ({ todos: state.todos })
      const Component = Redux.connect(mapStateToProps)(MyComponent);
    `;

    expect(code).toMatchSnapshot();
  });
});
