import * as babel from '@babel/core';
import type { Expression, File } from '@babel/types';
import * as t from '@babel/types';

import type { MissedBabelCoreTypes } from '../types';
import dynamicImport from '../plugins/dynamic-import';

const { File: BabelFile } = babel as typeof babel & MissedBabelCoreTypes;

const transformToAst = (code: string): File => {
  const result = babel.transformSync(code, {
    filename: '/test.ts',
    ast: true,
    babelrc: false,
    code: false,
    configFile: false,
    parserOpts: {
      plugins: ['typescript'],
    },
    plugins: [dynamicImport],
  });

  if (!result?.ast) {
    throw new Error('Failed to transform code');
  }

  return result.ast as File;
};

const getFirstDynamicImportArgument = (ast: File): Expression | null => {
  let found: Expression | null = null;

  const file = new BabelFile({ filename: '/test.ts' }, { ast, code: '' });

  file.path.traverse({
    CallExpression(path) {
      const callee = path.get('callee');
      if (!callee.isIdentifier({ name: '__wyw_dynamic_import' })) {
        return;
      }

      const firstArg = path.get('arguments.0');
      found = firstArg.isExpression() ? firstArg.node : null;
      path.stop();
    },
  });

  return found;
};

describe('dynamic-import plugin', () => {
  it('unwraps TS assertion for string literal specifier', () => {
    const ast = transformToAst(
      'function foo() { import("./foo" as any).then(() => null); }'
    );
    const argument = getFirstDynamicImportArgument(ast);

    expect(argument).not.toBeNull();
    expect(t.isStringLiteral(argument)).toBe(true);
  });

  it('keeps TS assertion for non-string-like specifier', () => {
    const ast = transformToAst(
      'function foo(locale: unknown) { import(locale as any).then(() => null); }'
    );
    const argument = getFirstDynamicImportArgument(ast);

    expect(argument).not.toBeNull();
    expect(t.isTSAsExpression(argument)).toBe(true);
  });

  it('unwraps TS assertion for string concatenation', () => {
    const ast = transformToAst(
      'function foo(locale: unknown) { import(("./foo/" + locale) as any); }'
    );
    const argument = getFirstDynamicImportArgument(ast);

    expect(argument).not.toBeNull();
    expect(t.isBinaryExpression(argument) && argument.operator === '+').toBe(
      true
    );
  });

  it('unwraps TS assertion for concat call', () => {
    const ast = transformToAst(
      'function foo(locale: unknown) { import(("./foo/".concat(locale, ".json")) as any); }'
    );
    const argument = getFirstDynamicImportArgument(ast);

    expect(argument).not.toBeNull();
    expect(t.isCallExpression(argument)).toBe(true);
  });

  it('unwraps TS assertion for template literal', () => {
    const ast = transformToAst(
      'function foo(locale: unknown) { import((`./foo/${locale}` as any)); }'
    );
    const argument = getFirstDynamicImportArgument(ast);

    expect(argument).not.toBeNull();
    expect(t.isTemplateLiteral(argument)).toBe(true);
  });

  it('does not treat conditional expression as string-like', () => {
    const ast = transformToAst(
      'function foo() { import((Math.random() > 0.5 ? "a" : "b") as any); }'
    );
    const argument = getFirstDynamicImportArgument(ast);

    expect(argument).not.toBeNull();
    expect(t.isTSAsExpression(argument)).toBe(true);
  });
});
