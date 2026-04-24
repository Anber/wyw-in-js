/* eslint-env jest */
import path from 'path';

import type { StrictOptions } from '@wyw-in-js/shared';

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
  | 'evaluate'
  | 'extensions'
  | 'features'
  | 'tagResolver'
> = {
  codeRemover: {},
  displayName: false,
  evaluate: true,
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
  | 'evaluate'
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
    expect(shaken.code).toContain('const _exp =');
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

    expect(preeval.code).toContain('export const __wywPreval = { _exp: _exp };');
    expect(shaken.code).toContain('export const __wywPreval = { _exp: _exp };');
    expect(shaken.code).toContain('const _exp =');
  });
});
