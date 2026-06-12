/* eslint-env jest */
import { expressionToCode } from '@wyw-in-js/processor-utils';

import {
  createOxcAstService,
  printOxcAstServiceImport,
} from '../utils/oxcAstService';

describe('oxc AstService', () => {
  it('builds expression nodes used by existing processors', () => {
    const ast = createOxcAstService();

    const call = ast.callExpression(ast.identifier('__styles'), [
      ast.objectExpression([
        ast.objectProperty(ast.identifier('root'), ast.stringLiteral('a b')),
      ]),
      ast.arrayExpression([ast.stringLiteral('.a{}')]),
    ]);

    expect(expressionToCode(call)).toBe(
      ['__styles({', '  root: "a b"', '}, [".a{}"])'].join('\n')
    );
  });

  it('supports Linaria styled functional component fallback nodes', () => {
    const ast = createOxcAstService();
    const fallback = ast.arrowFunctionExpression([], ast.blockStatement([]));

    expect(fallback).toEqual({
      body: {
        body: [],
        type: 'BlockStatement',
      },
      params: [],
      type: 'ArrowFunctionExpression',
    });
  });

  it('tracks helper imports and avoids local name collisions', () => {
    const ast = createOxcAstService(['__styles']);
    const imported = ast.addNamedImport('__styles', '@griffel/react');

    expect(imported.name).toBe('__styles2');
    expect(ast.getAddedImports()).toEqual([
      {
        imported: '__styles',
        local: '__styles2',
        source: '@griffel/react',
      },
    ]);
    expect(printOxcAstServiceImport(ast.getAddedImports()[0])).toBe(
      'import { __styles as __styles2 } from "@griffel/react";'
    );
  });
});
