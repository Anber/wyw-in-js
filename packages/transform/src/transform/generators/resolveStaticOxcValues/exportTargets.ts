/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  ExportSpecifier,
  Expression,
  Node,
  Program,
  VariableDeclaration,
} from 'oxc-parser';

import { collectLocalConstExpressions } from './programAnalysis';
import {
  collectImportBindings,
  moduleExportName,
  unwrapExpression,
} from './staticExpression';
import type { ExportTarget } from './types';

export const getExportSpecifierNames = (
  specifier: ExportSpecifier
): { exported: string; local: string } => ({
  exported: moduleExportName(specifier.exported),
  local: moduleExportName(specifier.local),
});

export const findExportTarget = (
  program: Program,
  exportedName: string
): ExportTarget | null => {
  const imports = collectImportBindings(program);
  const locals = collectLocalConstExpressions(program);

  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source) {
        for (const specifier of statement.specifiers) {
          if (specifier.type !== 'ExportSpecifier') {
            continue;
          }

          const names = getExportSpecifierNames(specifier);
          if (names.exported === exportedName) {
            return {
              imported: names.local,
              kind: 'import',
              source: statement.source.value,
            };
          }
        }

        continue;
      }

      if (statement.declaration?.type === 'VariableDeclaration') {
        for (const declarator of statement.declaration.declarations) {
          if (
            declarator.id.type === 'Identifier' &&
            declarator.id.name === exportedName &&
            declarator.init
          ) {
            return {
              expression: declarator.init,
              kind: 'expression',
              localName: declarator.id.name,
            };
          }
        }

        continue;
      }

      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ExportSpecifier') {
          continue;
        }

        const names = getExportSpecifierNames(specifier);
        if (names.exported !== exportedName) {
          continue;
        }

        const importBinding = imports.get(names.local);
        if (importBinding) {
          return {
            imported: importBinding.imported,
            kind: 'import',
            source: importBinding.source,
          };
        }

        const local = locals.get(names.local);
        if (local) {
          return {
            expression: local,
            kind: 'expression',
            localName: names.local,
          };
        }
      }
    }

    if (
      exportedName === 'default' &&
      statement.type === 'ExportDefaultDeclaration'
    ) {
      const { declaration } = statement;
      if (declaration.type === 'Identifier') {
        const importBinding = imports.get(declaration.name);
        if (importBinding) {
          return {
            imported: importBinding.imported,
            kind: 'import',
            source: importBinding.source,
          };
        }

        const local = locals.get(declaration.name);
        if (local) {
          return {
            expression: local,
            kind: 'expression',
            localName: declaration.name,
          };
        }

        return null;
      }

      return {
        expression: declaration as Expression,
        kind: 'expression',
      };
    }
  }

  return null;
};

export const exportedLocalName = (
  program: Program,
  exportedName: string
): string | null => {
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source || statement.declaration) {
        continue;
      }

      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ExportSpecifier') {
          continue;
        }

        const names = getExportSpecifierNames(specifier);
        if (names.exported === exportedName) {
          return names.local;
        }
      }
    }

    if (
      exportedName === 'default' &&
      statement.type === 'ExportDefaultDeclaration' &&
      statement.declaration.type === 'Identifier'
    ) {
      return statement.declaration.name;
    }
  }

  return null;
};

export const isIdentifierNamed = (node: Node, name: string): boolean =>
  node.type === 'Identifier' && node.name === name;

export const enumLiteralValue = (node: Node): number | string | null => {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type === 'Literal') {
    const { value } = unwrapped;
    return typeof value === 'string' || typeof value === 'number'
      ? value
      : null;
  }

  if (unwrapped.type === 'UnaryExpression') {
    const argument = unwrapExpression(unwrapped.argument);
    if (
      (unwrapped.operator === '-' || unwrapped.operator === '+') &&
      argument.type === 'Literal' &&
      typeof argument.value === 'number'
    ) {
      return unwrapped.operator === '-' ? -argument.value : argument.value;
    }
  }

  return null;
};

export const enumMemberKey = (node: Node, computed: boolean): string | null => {
  const unwrapped = unwrapExpression(node);
  if (!computed && unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  const value = enumLiteralValue(unwrapped);
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
};

export const enumSimpleAssignment = (
  node: Node,
  enumParamName: string
): { key: string; value: number | string } | null => {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type !== 'AssignmentExpression' || unwrapped.operator !== '=') {
    return null;
  }

  const left = unwrapExpression(unwrapped.left);
  if (
    left.type !== 'MemberExpression' ||
    !isIdentifierNamed(unwrapExpression(left.object), enumParamName)
  ) {
    return null;
  }

  const key = enumMemberKey(left.property, left.computed);
  const value = enumLiteralValue(unwrapped.right);
  return key !== null && value !== null ? { key, value } : null;
};

export const collectEnumIifeAssignments = (
  call: Node,
  localName: string
): Record<string, number | string> | null => {
  const unwrapped = unwrapExpression(
    call.type === 'ExpressionStatement' ? call.expression : call
  );
  if (unwrapped.type !== 'CallExpression' || unwrapped.arguments.length !== 1) {
    return null;
  }

  const callee = unwrapExpression(unwrapped.callee);
  if (
    callee.type !== 'FunctionExpression' ||
    callee.async ||
    !callee.body ||
    callee.params.length !== 1 ||
    callee.params[0]?.type !== 'Identifier'
  ) {
    return null;
  }

  const enumParamName = callee.params[0].name;
  const argument = unwrapExpression(unwrapped.arguments[0]);
  if (argument.type !== 'LogicalExpression' || argument.operator !== '||') {
    return null;
  }

  const fallback = unwrapExpression(argument.right);
  if (
    !isIdentifierNamed(unwrapExpression(argument.left), localName) ||
    fallback.type !== 'AssignmentExpression' ||
    fallback.operator !== '=' ||
    !isIdentifierNamed(unwrapExpression(fallback.left), localName) ||
    unwrapExpression(fallback.right).type !== 'ObjectExpression'
  ) {
    return null;
  }

  const result: Record<string, number | string> = {};
  for (const statement of callee.body.body) {
    if (statement.type !== 'ExpressionStatement') {
      return null;
    }

    const expression = unwrapExpression(statement.expression);
    if (
      expression.type !== 'AssignmentExpression' ||
      expression.operator !== '='
    ) {
      return null;
    }

    const left = unwrapExpression(expression.left);
    if (
      left.type === 'MemberExpression' &&
      isIdentifierNamed(unwrapExpression(left.object), enumParamName)
    ) {
      const numericEnumAssignment = enumSimpleAssignment(
        left.property,
        enumParamName
      );
      const reverseValue = enumLiteralValue(expression.right);
      if (
        numericEnumAssignment &&
        typeof numericEnumAssignment.value === 'number' &&
        typeof reverseValue === 'string'
      ) {
        result[numericEnumAssignment.key] = numericEnumAssignment.value;
        result[String(numericEnumAssignment.value)] = reverseValue;
        continue;
      }
    }

    const assignment = enumSimpleAssignment(expression, enumParamName);
    if (!assignment) {
      return null;
    }

    result[assignment.key] = assignment.value;
  }

  return Object.keys(result).length > 0 ? result : null;
};

export const enumIifeLocalName = (statement: Node): string | null => {
  if (statement.type !== 'ExpressionStatement') {
    return null;
  }

  const expression = unwrapExpression(statement.expression);
  if (
    expression.type !== 'CallExpression' ||
    expression.arguments.length !== 1
  ) {
    return null;
  }

  const argument = unwrapExpression(expression.arguments[0]);
  if (argument.type !== 'LogicalExpression' || argument.operator !== '||') {
    return null;
  }

  const fallback = unwrapExpression(argument.right);
  if (
    argument.left.type !== 'Identifier' ||
    fallback.type !== 'AssignmentExpression' ||
    fallback.left.type !== 'Identifier'
  ) {
    return null;
  }

  return argument.left.name === fallback.left.name ? argument.left.name : null;
};

export const isEnumVarDeclaration = (
  statement: Node
): statement is VariableDeclaration =>
  statement.type === 'VariableDeclaration' &&
  statement.kind === 'var' &&
  statement.declarations.length > 0 &&
  statement.declarations.every(
    (declarator) =>
      declarator.id.type === 'Identifier' && declarator.init === null
  );

export const isTypeScriptEnumOnlyModule = (program: Program): boolean =>
  program.body.every((statement) => {
    if (isEnumVarDeclaration(statement)) {
      return true;
    }

    const localName = enumIifeLocalName(statement);
    if (localName) {
      return collectEnumIifeAssignments(statement, localName) !== null;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      return statement.declaration.type === 'Identifier';
    }

    return (
      statement.type === 'ExportNamedDeclaration' &&
      !statement.source &&
      !statement.declaration &&
      statement.specifiers.every(
        (specifier) => specifier.type === 'ExportSpecifier'
      )
    );
  });

export const typeScriptEnumStaticExportValue = (
  program: Program,
  exportedName: string
): Record<string, number | string> | null => {
  if (!isTypeScriptEnumOnlyModule(program)) {
    return null;
  }

  const localName = exportedLocalName(program, exportedName);
  if (!localName) {
    return null;
  }

  const hasDeclaration = program.body.some(
    (statement) =>
      isEnumVarDeclaration(statement) &&
      statement.declarations.some(
        (declarator) =>
          declarator.id.type === 'Identifier' &&
          declarator.id.name === localName
      )
  );
  if (!hasDeclaration) {
    return null;
  }

  for (const statement of program.body) {
    const enumValue = collectEnumIifeAssignments(statement, localName);
    if (enumValue) {
      return enumValue;
    }
  }

  return null;
};
