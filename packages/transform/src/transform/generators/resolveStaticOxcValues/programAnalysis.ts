/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  Expression,
  Node,
  Program,
  VariableDeclaration,
} from 'oxc-parser';

import {
  collectImportBindings,
  isSafeLiteral,
  unwrapExpression,
} from './staticExpression';
import type { AnyNode } from './types';

export const collectLocalConstExpressions = (
  program: Program
): Map<string, Expression> => {
  const result = new Map<string, Expression>();

  const collect = (declaration: VariableDeclaration): void => {
    if (declaration.kind !== 'const') {
      return;
    }

    declaration.declarations.forEach((declarator) => {
      if (declarator.id.type === 'Identifier' && declarator.init) {
        result.set(declarator.id.name, declarator.init);
      }
    });
  };

  program.body.forEach((statement) => {
    if (statement.type === 'VariableDeclaration') {
      collect(statement);
      return;
    }

    if (
      statement.type === 'ExportNamedDeclaration' &&
      statement.declaration?.type === 'VariableDeclaration'
    ) {
      collect(statement.declaration);
    }
  });

  return result;
};
export const objectPropertyKeyName = (node: Node): string | null => {
  const unwrapped = unwrapExpression(node);

  if (unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  if (isSafeLiteral(unwrapped) && typeof unwrapped.value === 'string') {
    return unwrapped.value;
  }

  return null;
};

export const findObjectPropertyValue = (
  expr: Node,
  name: string
): Expression | null => {
  const unwrapped = unwrapExpression(expr);
  if (unwrapped.type !== 'ObjectExpression') {
    return null;
  }

  for (const property of unwrapped.properties) {
    if (property.type === 'SpreadElement') {
      continue;
    }

    const propertyNode = property as AnyNode;
    if (propertyNode.computed) {
      continue;
    }

    const key = propertyNode.key as Node | undefined;
    const value = propertyNode.value as Expression | undefined;
    if (key && value && objectPropertyKeyName(key) === name) {
      return value;
    }
  }

  return null;
};
export const topLevelStatements = (program: Program): Node[] => {
  const result: Node[] = [];

  program.body.forEach((statement) => {
    if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
    ) {
      result.push(statement.declaration ?? statement);
      return;
    }

    result.push(statement);
  });

  return result;
};

export const findTopLevelConstExpression = (
  program: Program,
  name: string
): Expression | null => {
  for (const statement of topLevelStatements(program)) {
    if (
      statement.type !== 'VariableDeclaration' ||
      statement.kind !== 'const'
    ) {
      continue;
    }

    for (const declarator of statement.declarations) {
      if (
        declarator.id.type === 'Identifier' &&
        declarator.id.name === name &&
        declarator.init
      ) {
        return declarator.init;
      }
    }
  }

  return null;
};

export const hasTopLevelBinding = (program: Program, name: string): boolean => {
  if (collectImportBindings(program).has(name)) {
    return true;
  }

  return topLevelStatements(program).some((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return statement.declarations.some(
        (declarator) =>
          declarator.id.type === 'Identifier' && declarator.id.name === name
      );
    }

    if (statement.type === 'FunctionDeclaration') {
      return statement.id?.name === name;
    }

    if (statement.type === 'ClassDeclaration') {
      return statement.id?.name === name;
    }

    return false;
  });
};

export const isTopLevelFunctionOrClass = (
  program: Program,
  name: string
): boolean =>
  topLevelStatements(program).some((statement) => {
    if (statement.type === 'FunctionDeclaration') {
      return statement.id?.name === name;
    }

    if (statement.type === 'ClassDeclaration') {
      return statement.id?.name === name;
    }

    return false;
  });

export const functionReturnExpression = (
  expr: Node,
  options: { allowParams?: boolean } = {}
): Expression | null => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'ArrowFunctionExpression' &&
    unwrapped.type !== 'FunctionExpression'
  ) {
    return null;
  }

  if (
    unwrapped.async ||
    (!options.allowParams && unwrapped.params.length > 0) ||
    !unwrapped.body
  ) {
    return null;
  }

  if (unwrapped.body.type !== 'BlockStatement') {
    return unwrapped.body as Expression;
  }

  if (unwrapped.body.body.length !== 1) {
    return null;
  }

  const [statement] = unwrapped.body.body;
  return statement.type === 'ReturnStatement' && statement.argument
    ? statement.argument
    : null;
};
