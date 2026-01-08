import fs from 'fs';
import os from 'os';
import path from 'path';

import * as esbuild from 'esbuild';

import wywInJS from '../index';

const getCssText = (result: esbuild.BuildResult): string | null => {
  const css = result.outputFiles?.find((file) => file.path.endsWith('.css'));
  return css?.text ?? null;
};

type ProgramPath = {
  traverse: (visitor: { JSXElement: () => void }) => void;
  unshiftContainer: (key: 'body', nodes: unknown[]) => void;
};

type BabelTypesHelpers = {
  arrayExpression: (elements: unknown[]) => unknown;
  exportNamedDeclaration: (declaration: unknown) => unknown;
  identifier: (name: string) => unknown;
  taggedTemplateExpression: (tag: unknown, quasi: unknown) => unknown;
  templateElement: (
    value: { cooked: string; raw: string },
    tail: boolean
  ) => unknown;
  templateLiteral: (quasis: unknown[], expressions: unknown[]) => unknown;
  variableDeclaration: (kind: string, declarations: unknown[]) => unknown;
  variableDeclarator: (id: unknown, init: unknown) => unknown;
};

type BabelApi = {
  types: BabelTypesHelpers;
};

const injectCssOnJsx = (babel: BabelApi) => {
  const t = babel.types;

  return {
    name: 'inject-css-on-jsx',
    visitor: {
      Program(programPath: ProgramPath) {
        let hasJsx = false;
        programPath.traverse({
          JSXElement() {
            hasJsx = true;
          },
        });

        if (!hasJsx) {
          return;
        }

        programPath.unshiftContainer('body', [
          t.exportNamedDeclaration(
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier('className'),
                t.taggedTemplateExpression(
                  t.identifier('css'),
                  t.templateLiteral(
                    [
                      t.templateElement(
                        { raw: 'color: red;', cooked: 'color: red;' },
                        true
                      ),
                    ],
                    []
                  )
                )
              ),
            ])
          ),
          t.exportNamedDeclaration(
            t.variableDeclaration('const', [
              t.variableDeclarator(
                t.identifier('_usage'),
                t.arrayExpression([t.identifier('className')])
              ),
            ])
          ),
        ]);
      },
    },
  };
};

it('can apply babelOptions to source code before esbuild/WyW transform', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-esbuild-127-'));
  const outdir = path.join(root, 'dist');

  const entryFile = path.join(root, 'main.tsx');

  const nmRoot = path.join(root, 'node_modules');
  const processorStubDir = path.join(nmRoot, 'test-css-processor');

  fs.mkdirSync(processorStubDir, { recursive: true });

  fs.writeFileSync(
    path.join(processorStubDir, 'package.json'),
    JSON.stringify({
      name: 'test-css-processor',
      version: '1.0.0',
      type: 'module',
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(processorStubDir, 'index.js'),
    `export const css = (strings) => strings.join('');\n`,
    'utf8'
  );

  fs.writeFileSync(
    entryFile,
    [
      `import { css } from 'test-css-processor';`,
      ``,
      `export function App() {`,
      `  return <div />;`,
      `}`,
      ``,
    ].join('\n'),
    'utf8'
  );

  const processorFile = path.resolve(
    __dirname,
    '../../../transform/src/__tests__/__fixtures__/test-css-processor.js'
  );

  const cwd = process.cwd();
  process.chdir(root);

  try {
    const basePluginOptions = {
      configFile: false,
      babelOptions: {
        plugins: [injectCssOnJsx],
        parserOpts: {
          plugins: ['jsx', 'typescript'],
        },
      },
      tagResolver: (source: string, tag: string) => {
        if (source === 'test-css-processor' && tag === 'css') {
          return processorFile;
        }

        return null;
      },
    };

    const skipped = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      write: false,
      outdir,
      plugins: [wywInJS(basePluginOptions)],
    });

    expect(getCssText(skipped)).toBeNull();

    const transformed = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      write: false,
      outdir,
      plugins: [wywInJS({ ...basePluginOptions, babelTransform: true })],
    });

    const cssText = getCssText(transformed);
    expect(cssText).not.toBeNull();
    expect(cssText).toContain('red');
  } finally {
    process.chdir(cwd);
  }
});
