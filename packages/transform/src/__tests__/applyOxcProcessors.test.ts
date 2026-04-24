/* eslint-env jest */
import path from 'path';

import type { StrictOptions } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';

import { applyOxcProcessors } from '../utils/applyOxcProcessors';

const processorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
);
const callProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-call-processor.js'
);
const runtimeDependencyCallProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-runtime-dependency-call-processor.js'
);
const arrowProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-pure-annotation-arrow-processor.js'
);
const pureCallProcessorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-pure-annotation-call-processor.js'
);
const linariaStyledProcessorPath = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'linaria',
  'packages',
  'react',
  'src',
  'processors',
  'styled.ts'
);

const fileContext = {
  filename: path.join(__dirname, 'source.js'),
  root: __dirname,
};

const options = (
  resolvedProcessorPath: string,
  importedTag = 'css'
): Pick<
  StrictOptions,
  'classNameSlug' | 'displayName' | 'extensions' | 'evaluate' | 'tagResolver'
> => ({
  displayName: false,
  evaluate: true,
  extensions: ['.js'],
  tagResolver: (source, imported) => {
    if (source !== 'test-package' || imported !== importedTag) {
      return null;
    }

    return resolvedProcessorPath;
  },
});

describe('applyOxcProcessors', () => {
  it('returns the original module when no imports resolve to processors', () => {
    const source = `
      import { notCss } from 'test-package';
      const a = notCss\`
        color: red;
      \`;
      export { a };
    `;

    const result = applyOxcProcessors(
      source,
      fileContext,
      options(processorPath),
      () => {}
    );

    expect(result.code).toBe(source);
    expect(result.processors).toEqual([]);
  });

  it('reuses processor lookup results for the same import tuple across runs', () => {
    let resolverCalls = 0;
    const cachedOptions: Pick<
      StrictOptions,
      'classNameSlug' | 'displayName' | 'extensions' | 'evaluate' | 'tagResolver'
    > = {
      displayName: false,
      evaluate: true,
      extensions: ['.js'],
      tagResolver: (source, imported) => {
        if (source === 'test-package-lookup-cache' && imported === 'css') {
          resolverCalls += 1;
          return processorPath;
        }

        return null;
      },
    };

    const source = `
      import { css } from 'test-package-lookup-cache';
      export const a = css\`
        color: red;
      \`;
    `;

    const first = applyOxcProcessors(source, fileContext, cachedOptions, () => {});
    const second = applyOxcProcessors(source, fileContext, cachedOptions, () => {});

    expect(first.processors).toHaveLength(1);
    expect(second.processors).toHaveLength(1);
    expect(resolverCalls).toBe(1);
  });

  it('creates tagged-template processors and preserves CSS extraction', () => {
    const cssText: string[] = [];
    const starts: unknown[] = [];

    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const a = css\`
          color: red;
        \`;
        export { a };
      `,
      fileContext,
      options(processorPath),
      (processor) => {
        processor.build(new Map());
        processor.artifacts.forEach((artifact) => {
          if (artifact[0] !== 'css') return;
          const [rules] = artifact[1];
          Object.values(rules).forEach((rule) => {
            cssText.push(rule.cssText);
            starts.push(rule.start);
          });
        });
      }
    );

    expect(result.processors[0]?.displayName).toBe('a');
    expect(result.processors[0]?.isReferenced).toBe(true);
    expect(result.processors[0]?.location?.start).toEqual({
      column: 18,
      line: 3,
    });
    expect(starts[0]).toEqual({ column: 18, line: 3 });
    expect(cssText.join('\n')).toContain('color: red');
  });

  it('derives displayName from object properties and JSX elements', () => {
    const objectResult = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const styles = {
          button: css\`
            color: red;
          \`,
        };
      `,
      fileContext,
      options(processorPath),
      () => {}
    );

    const jsxResult = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const node = <Box className={css\`
          color: red;
        \`} />;
      `,
      {
        ...fileContext,
        filename: path.join(__dirname, 'source.tsx'),
      },
      options(processorPath),
      () => {}
    );

    expect(objectResult.processors[0]?.displayName).toBe('button');
    expect(objectResult.processors[0]?.isReferenced).toBe(true);
    expect(jsxResult.processors[0]?.displayName).toBe('Box');
    expect(jsxResult.processors[0]?.isReferenced).toBe(true);
  });

  it('treats JSX component usages as references for assigned tags', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const Button = css\`
          color: red;
        \`;
        const view = <Button />;
      `,
      {
        ...fileContext,
        filename: path.join(__dirname, 'jsx-component.tsx'),
      },
      options(processorPath),
      (processor) => {
        processor.build(new Map());
      }
    );

    expect(result.processors[0]?.isReferenced).toBe(true);
    expect(result.processors[0]?.artifacts).toHaveLength(1);
    expect(result.processors[0]?.artifacts[0]?.[0]).toBe('css');
  });

  it('marks assigned tags as unreferenced when the binding has no references', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const a = css\`
          color: red;
        \`;
      `,
      fileContext,
      options(processorPath),
      () => {},
      true
    );

    expect(result.processors[0]?.isReferenced).toBe(false);
  });

  it('treats exported assigned tags as referenced', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        export const a = css\`
          color: red;
        \`;
      `,
      fileContext,
      options(processorPath),
      () => {},
      true
    );

    expect(result.processors[0]?.isReferenced).toBe(true);
  });

  it('hoists dependencies only for matched processor templates', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const color = 'red';
        const nonWyw = \`value ${'${color}'}\`;
        const a = css\`
          color: ${'${color}'};
          width: ${'${1}'}px;
        \`;
        export { a, nonWyw };
      `,
      fileContext,
      options(processorPath),
      () => {}
    );

    expect(result.code).toContain('const _exp = () => "red";');
    expect(result.code).toContain('const nonWyw = `value ${color}`;');
    expect(result.code).toContain('color: ${_exp()};');
    expect(result.code).toContain('width: ${1}px;');
    expect(result.processors[0]?.dependencies).toMatchObject([
      {
        ex: {
          name: '_exp',
          type: 'Identifier',
        },
        kind: ValueType.LAZY,
        source: 'color',
      },
      {
        kind: ValueType.CONST,
        source: '1',
        value: 1,
      },
    ]);
  });

  it('does not emit pure annotation for non-call replacements', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const a = css\`
          color: red;
        \`;
      `,
      fileContext,
      options(arrowProcessorPath),
      (processor) => processor.doRuntimeReplacement()
    );

    expect(result.code).not.toContain('/*#__PURE__*/');
  });

  it('emits pure annotation for call replacements', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const a = css\`
          color: red;
        \`;
      `,
      fileContext,
      options(pureCallProcessorPath),
      (processor) => processor.doRuntimeReplacement()
    );

    expect(result.code).toContain('/*#__PURE__*/x()');
  });

  it('creates call processors for direct and namespace usage', () => {
    const direct = applyOxcProcessors(
      `
        import { makeStyles } from 'test-package';
        const color = 'red';
        const styles = { root: { color } };
        export const useStyles = makeStyles(styles);
      `,
      fileContext,
      options(callProcessorPath, 'makeStyles'),
      (processor) => processor.doEvaltimeReplacement()
    );

    const namespace = applyOxcProcessors(
      `
        import * as pkg from 'test-package';
        export const useStyles = (0, pkg.makeStyles)({});
      `,
      fileContext,
      options(callProcessorPath, 'makeStyles'),
      () => {}
    );

    expect(direct.processors[0]?.toString()).toBe('makeStyles(…)');
    expect(direct.processors[0]?.tagSource).toEqual({
      imported: 'makeStyles',
      source: 'test-package',
    });
    expect(direct.processors[0]?.dependencies[0]?.ex).toMatchObject({
      name: '_exp',
      type: 'Identifier',
    });
    expect(direct.code).toContain(
      'const _exp = () => ({"root":{"color":"red"}});'
    );
    expect(direct.code).toContain('export const useStyles = null;');
    expect(namespace.processors[0]?.toString()).toBe('pkg.makeStyles(…)');
  });

  it('creates call processors for destructured namespace usage', () => {
    const result = applyOxcProcessors(
      `
        import * as pkg from 'test-package';
        const { makeStyles } = pkg;
        export const useStyles = makeStyles({});
      `,
      fileContext,
      options(callProcessorPath, 'makeStyles'),
      () => {}
    );

    expect(result.processors[0]?.toString()).toBe('makeStyles(…)');
    expect(result.processors[0]?.tagSource).toEqual({
      imported: 'makeStyles',
      source: 'test-package',
    });
  });

  it('removes unused shadowed locals after static template evaluation', () => {
    const result = applyOxcProcessors(
      `
        import React from 'react';
        import { css } from 'test-package';
        const outerColor = 'red';
        export default function Component() {
          const color = 'blue';
          const val = { color };
          return <div className={css\`
            background-color: ${'${val.color}'};
          \`} />;
        }
      `,
      {
        ...fileContext,
        filename: path.join(__dirname, 'shadowed.tsx'),
      },
      options(processorPath),
      (processor) => processor.doRuntimeReplacement(),
      true
    );

    expect(result.code).toContain("const outerColor = 'red';");
    expect(result.code).not.toContain("const color = 'blue';");
    expect(result.code).not.toContain('const val = { color };');
  });

  it('removes unused helper declarations consumed by static evaluation', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        function copyAndExtend(a, b) {
          return { ...a, ...b };
        }
        const obj = copyAndExtend({ a: 1 }, { a: 2 });
        export const title = css\`
          color: ${"${obj.a}"};
        \`;
      `,
      fileContext,
      options(processorPath),
      (processor) => processor.doRuntimeReplacement(),
      true
    );

    expect(result.code).not.toContain('function copyAndExtend');
    expect(result.code).not.toContain('const obj =');
  });

  it('removes empty top-level blocks after static template evaluation cleanup', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';

        {
          var days = 42;
        }

        export const title = css\`
          &:before {
            content: "${'${days}'}";
          }
        \`;
      `,
      fileContext,
      options(processorPath),
      (processor) => processor.doRuntimeReplacement(),
      true
    );

    expect(result.code).not.toContain('var days = 42');
    expect(result.code).not.toContain(`{\n        }`);
  });

  it('removes transitive root declarations used only through nested helper locals', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        const objects = { key: { fontSize: 12 } };
        const foo = (k) => {
          const obj = objects[k];
          return obj;
        };
        export const title = css\`
          font-size: ${"${foo('key').fontSize}"}px;
        \`;
      `,
      fileContext,
      options(processorPath),
      (processor) => processor.doRuntimeReplacement(),
      true
    );

    expect(result.code).not.toContain('const foo =');
    expect(result.code).not.toContain('const objects =');
  });

  it('removes helper closures while preserving directly exported aliases', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';
        import { foo3 } from './reexports';

        export const bar3 = foo3;

        export const title = css\`
          color: ${"${bar3('thing')}"};
        \`;
      `,
      fileContext,
      options(processorPath),
      (processor) => processor.doRuntimeReplacement(),
      true
    );

    expect(result.code).toContain('export const bar3 = foo3;');
    expect(result.code).not.toContain('const _exp');
  });

  it('keeps helper-call dependencies addressable by helper identifier names', () => {
    const result = applyOxcProcessors(
      `
        import { css } from 'test-package';

        const one = 1;
        const two = 2;
        const three = 3;
        const four = 4;
        const five = 5;
        const six = 6;
        const seven = 7;
        const eight = 8;

        export const classes = {
          a: css\`\`,
          b: css\`\`,
          c: css\`\`,
          d: css\`\`,
          e: css\`\`,
          f: css\`\`,
          g: css\`width: ${'${seven}'}px;\`,
          h: css\`width: ${'${eight}'}px;\`,
        };

        export const body = css\`
          color: ${'${one}'};
          background: ${'${two}'};
          border-width: ${'${three}'}px;
          padding: ${'${four}'}px;
          margin: ${'${five}'}px;
          opacity: ${'${six}'};
        \`;
      `,
      fileContext,
      options(processorPath),
      () => {}
    );

    const bodyProcessor = result.processors[result.processors.length - 1];

    expect(bodyProcessor?.dependencies.map((item) => item.ex.name)).toEqual([
      '_exp3',
      '_exp4',
      '_exp5',
      '_exp6',
      '_exp7',
      '_exp8',
    ]);
  });

  it('tracks wrapped styled-component dependencies for styled(Base) calls', () => {
    const result = applyOxcProcessors(
      `
        import { styled } from '@linaria/react';
        import Base from './base';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `,
      fileContext,
      {
        displayName: false,
        evaluate: true,
        extensions: ['.js', '.ts', '.tsx'],
        tagResolver: (source, imported) => {
          if (source === '@linaria/react' && imported === 'styled') {
            return linariaStyledProcessorPath;
          }

          return null;
        },
      },
      () => {}
    );

    expect(result.processors[0]?.dependencies.map((item) => item.ex.name)).toEqual(
      ['_exp']
    );
    expect(result.processors[0]?.dependencies[0]).toMatchObject({
      importedFrom: ['./base'],
      kind: ValueType.LAZY,
      source: 'Base',
    });
  });

  it('keeps helper declarations that remain referenced by surviving runtime dependency chains', () => {
    const result = applyOxcProcessors(
      `
        import { makeStyles } from 'test-package';
        var _interopRequireWildcard = require("@babel/runtime/helpers/interopRequireWildcard").default;
        var React = _interopRequireWildcard(require("react"));
        const Component = () => React.createElement('div');

        export const styles = makeStyles(Component);
      `,
      fileContext,
      options(runtimeDependencyCallProcessorPath, 'makeStyles'),
      (processor) => processor.doRuntimeReplacement(),
      true
    );

    expect(result.code).toContain(
      'var _interopRequireWildcard = require("@babel/runtime/helpers/interopRequireWildcard").default;'
    );
    expect(result.code).toContain(
      'var React = _interopRequireWildcard(require("react"));'
    );
    expect(result.code).toContain('const _exp = () => Component;');
    expect(result.code).toContain('export const styles = /*#__PURE__*/__callRuntime(_exp());');
  });

  it('keeps runtime helpers referenced only from function parameter defaults', () => {
    const result = applyOxcProcessors(
      `
        import React from 'react';
        import SelectOption from './SelectOption';
        import { css } from 'test-package';

        const formatOptionLabelDefault = ({ value }) => (
          <SelectOption>{value}</SelectOption>
        );

        export const DropdownSelector = ({
          formatOptionLabel = formatOptionLabelDefault,
        }) => (
          <div
            className={css\`
              color: red;
            \`}
          >
            {formatOptionLabel({ value: 'x' })}
          </div>
        );
      `,
      {
        ...fileContext,
        filename: path.join(__dirname, 'default-param.tsx'),
      },
      options(processorPath),
      (processor) => processor.doRuntimeReplacement(),
      true
    );

    expect(result.code).toContain(
      "import SelectOption from './SelectOption';"
    );
    expect(result.code).toContain('const formatOptionLabelDefault =');
    expect(result.code).toContain(
      'formatOptionLabel = formatOptionLabelDefault'
    );
  });

  it("throws when it cannot derive a display name from ownership or filename", () => {
    expect(() =>
      applyOxcProcessors(
        `
          import { css } from 'test-package';
          export default css\`
            color: red;
          \`;
        `,
        {
          ...fileContext,
          filename: path.join(__dirname, '.js'),
        },
        options(processorPath),
        () => {}
      )
    ).toThrow("Couldn't determine a name for the component");
  });
});
