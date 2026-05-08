/* eslint-env jest */
import path from 'path';

import type { StrictOptions } from '@wyw-in-js/shared';

import { EventEmitter } from '../utils/EventEmitter';
import { runOxcPreevalStage } from '../utils/oxcPreevalStage';
import { shakeOxcToESM } from '../utils/oxcShaker';

const processorPath = path.resolve(
  __dirname,
  '__fixtures__',
  'test-css-processor.js'
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
  filename: path.join(__dirname, 'source.tsx'),
  root: __dirname,
};

const options: Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'eval'
  | 'extensions'
  | 'features'
  | 'tagResolver'
> = {
  codeRemover: {},
  displayName: false,
  eval: { strategy: 'hybrid' },
  extensions: ['.tsx'],
  features: {
    dangerousCodeRemover: true,
  },
  tagResolver: (source, imported) => {
    if (source !== 'test-package' || imported !== 'css') {
      return null;
    }

    return processorPath;
  },
};

const linariaOptions: Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'extensions'
  | 'features'
  | 'tagResolver'
> = {
  ...options,
  extensions: ['.js', '.ts', '.tsx'],
  tagResolver: (source, imported) => {
    if (source === '@linaria/react' && imported === 'styled') {
      return linariaStyledProcessorPath;
    }

    return null;
  },
};

describe('runOxcPreevalStage', () => {
  it('uses eval.strategy to keep static values out of __wywPreval', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'hybrid' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.staticValueCache.get('_exp')).toBe('red');
    expect(result.code).toContain('export const __wywPreval = {};');
    expect(result.code).not.toContain('__wywPreval = { _exp: _exp }');
  });

  it('keeps static local values in __wywPreval when eval.strategy uses execute', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'execute' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.staticValueCache.has('_exp')).toBe(false);
    expect(result.dependencyNames).toEqual(['_exp']);
    expect(result.code).toContain('__wywPreval = { _exp: _exp }');
  });

  it('keeps only unresolved dependencies in __wywPreval for hybrid strategy', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        const spacing = getSpacing();
        export const a = css\`
          color: ${'${color}'};
          margin: ${'${spacing}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'hybrid' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.staticValueCache.get('_exp')).toBe('red');
    expect(result.dependencyNames).toEqual(['_exp2']);
    expect(result.code).toContain('__wywPreval = { _exp2: _exp2 }');
    expect(result.code).not.toContain('_exp: _exp');
  });

  it('keeps unresolved static-strategy dependencies for final validation', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = getColor();
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      {
        ...options,
        eval: { strategy: 'static' },
        features: {
          dangerousCodeRemover: true,
        },
      } as typeof options
    );

    expect(result.dependencyNames).toEqual(['_exp']);
    expect(result.code).toContain('__wywPreval = { _exp: _exp }');
  });

  it('applies eval-time replacement and synthesizes __wywPreval dependencies', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = import.meta.env.DEV ? 'red' : 'blue';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      options
    );

    expect(result.metadata?.processors).toHaveLength(1);
    expect(result.code).toContain('__wyw_import_meta_env.DEV');
    expect(result.code).toContain('export const __wywPreval = { _exp: _exp };');
    expect(result.code).not.toContain('css`');
  });

  it('adds empty __wywPreval for processor files without dependencies', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        export const a = css\`
          color: red;
        \`;
      `,
      fileContext,
      options
    );

    expect(result.metadata?.processors).toHaveLength(1);
    expect(result.code).toContain('export const __wywPreval = {};');
  });

  it('keeps statically evaluated local constants out of __wywPreval', () => {
    const result = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const color = 'red';
        export const a = css\`
          color: ${'${color}'};
        \`;
      `,
      fileContext,
      options
    );

    expect(result.staticValueCache.get('_exp')).toBe('red');
    expect(result.code).toContain('export const __wywPreval = {};');
    expect(result.code).not.toContain('__wywPreval = { _exp: _exp }');
  });

  it('still applies preeval syntax rewrites when no processors are present', () => {
    const result = runOxcPreevalStage(
      `
        const href = window.location.href;
        const mode = import.meta.env.MODE;
        import(dep);
        require(dep);
      `,
      fileContext,
      options
    );

    expect(result.metadata).toBeNull();
    expect(result.code).not.toContain('window.location');
    expect(result.code).toContain('__wyw_import_meta_env.MODE');
    expect(result.code).toContain('__wyw_dynamic_import(dep)');
    expect(result.code).toContain('require(dep, true)');
  });

  it('emits perf sublabels for the Oxc preeval substeps', () => {
    const methods: string[] = [];
    const eventEmitter = new EventEmitter(
      (labels, type) => {
        if (type === 'start' && typeof labels.method === 'string') {
          methods.push(labels.method);
        }
      },
      () => 0,
      () => {}
    );

    runOxcPreevalStage(
      `
        import { css } from 'test-package';
        const href = window.location.href;
        const mode = import.meta.env.MODE;
        const dep = './dep';
        export const a = css\`
          color: ${'${mode}'};
        \`;
        import(dep);
        require(dep);
      `,
      fileContext,
      {
        ...options,
        eventEmitter,
      }
    );

    expect(methods).toEqual(
      expect.arrayContaining([
        'transform:preeval:processTemplate',
        'transform:preeval:processTemplate:imports',
        'transform:preeval:processTemplate:imports:analysis',
        'transform:preeval:processTemplate:imports:lookup',
        'transform:preeval:processTemplate:usages',
        'transform:preeval:processTemplate:deps',
        'transform:preeval:processTemplate:usedNames',
        'transform:preeval:processTemplate:processors',
        'transform:preeval:importMetaEnv',
        'transform:preeval:removeDangerousCode',
        'transform:preeval:dynamicImport',
        'transform:preeval:requireFallback',
      ])
    );
  });

  it('feeds Oxc shaker with __wywPreval-only prepared code', () => {
    const preeval = runOxcPreevalStage(
      `
        import { css } from 'test-package';
        import runtimeOnly from 'runtime-only';

        const color = 'red';
        export const className = css\`
          color: ${'${color}'};
        \`;
        export const runtime = runtimeOnly;
      `,
      fileContext,
      options
    );
    const shaken = shakeOxcToESM(preeval.code, fileContext.filename, {
      onlyExports: ['__wywPreval'],
    });

    expect(shaken.code).toContain('export const __wywPreval');
    expect(shaken.code).not.toContain('const _exp =');
    expect(shaken.code).not.toContain('test-package');
    expect(shaken.code).not.toContain('runtime-only');
    expect(shaken.code).not.toContain('export const className');
    expect(shaken.imports.size).toBe(0);
  });

  it('keeps wrapped styled-component metadata dependencies through preeval and shaking', () => {
    const preeval = runOxcPreevalStage(
      `
        import { styled } from '@linaria/react';
        import Base from './base';

        export const Extended = styled(Base)\`
          font-size: 12px;
        \`;
      `,
      {
        ...fileContext,
        filename: path.join(__dirname, 'styled-wrap.tsx'),
      },
      linariaOptions
    );
    const shaken = shakeOxcToESM(
      preeval.code,
      path.join(__dirname, 'styled-wrap.tsx'),
      {
        onlyExports: ['__wywPreval'],
      }
    );

    expect(preeval.code).toContain(
      'export const __wywPreval = { _exp: _exp };'
    );
    expect(shaken.code).toContain('export const __wywPreval = { _exp: _exp };');
    expect(shaken.code).toContain('const _exp =');
  });

  it('expands shorthand properties when constant-substituting mixed object literals in css expressions', () => {
    // Reproduces: `{ width, ...textStyles.regular }` → `{ 500, ...textStyles.regular }`
    // when `width` is a constant and `textStyles` is an import.
    // The shorthand `width` must expand to `width: 500` to keep the object valid.
    const source = [
      "import { css } from 'test-package';",
      "import { textStyles } from './design-system';",
      'const width = 500;',
      'export const a = css`',
      '  ${{ width, ...textStyles.regular }}',
      '`;',
    ].join('\n');

    const result = runOxcPreevalStage(source, fileContext, options);

    expect(result.code).toContain('width: 500');
    expect(result.code).not.toMatch(/\{\s*500\s*,/);
  });

  it('expands shorthand string constants in mixed object literals in css expressions', () => {
    const source = [
      "import { css } from 'test-package';",
      "import { space } from './design-system';",
      'const display = "flex";',
      'export const a = css`',
      '  ${{ display, gap: space.s8 }}',
      '`;',
    ].join('\n');

    const result = runOxcPreevalStage(source, fileContext, options);

    expect(result.code).toContain('display: "flex"');
    expect(result.code).toContain('gap: space.s8');
  });
});
