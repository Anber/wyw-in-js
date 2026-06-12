import type {
  Expression,
  ImportDeclaration,
  ExportNamedDeclaration,
  File,
  Statement,
  VariableDeclaration,
  VariableDeclarator,
} from '@babel/types';
import {
  isArrayExpression,
  isArrowFunctionExpression,
  isAssignmentExpression,
  isAwaitExpression,
  isBinaryExpression,
  isBigIntLiteral,
  isBooleanLiteral,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConditionalExpression,
  isEmptyStatement,
  isExportAllDeclaration,
  isExportDefaultDeclaration,
  isExportNamedDeclaration,
  isExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isLogicalExpression,
  isNewExpression,
  isNullLiteral,
  isNumericLiteral,
  isObjectExpression,
  isObjectMethod,
  isObjectProperty,
  isParenthesizedExpression,
  isSequenceExpression,
  isSpreadElement,
  isStringLiteral,
  isTaggedTemplateExpression,
  isTemplateLiteral,
  isTSAsExpression,
  isTSInstantiationExpression,
  isTSNonNullExpression,
  isTSSatisfiesExpression,
  isUnaryExpression,
  isUpdateExpression,
  isYieldExpression,
} from '@babel/types';

function isTypeOnlyImport(statement: ImportDeclaration): boolean {
  if (statement.importKind === 'type') {
    return true;
  }

  return statement.specifiers.every(
    (specifier) =>
      isImportSpecifier(specifier) && specifier.importKind === 'type'
  );
}

function isTypeOnlyReExport(statement: ExportNamedDeclaration): boolean {
  if (!statement.source) {
    return false;
  }

  return statement.exportKind === 'type';
}

function unwrapExpression(expr: Expression): Expression {
  let current: Expression = expr;

  for (;;) {
    if (isTSAsExpression(current)) {
      current = current.expression;
      // eslint-disable-next-line no-continue
      continue;
    }

    if (isTSSatisfiesExpression(current)) {
      current = current.expression;
      // eslint-disable-next-line no-continue
      continue;
    }

    if (isTSNonNullExpression(current)) {
      current = current.expression;
      // eslint-disable-next-line no-continue
      continue;
    }

    if (isTSInstantiationExpression(current)) {
      current = current.expression;
      // eslint-disable-next-line no-continue
      continue;
    }

    if (isParenthesizedExpression(current)) {
      current = current.expression;
      // eslint-disable-next-line no-continue
      continue;
    }

    return current;
  }
}

function isSafeExpression(expr: Expression): boolean {
  const unwrapped = unwrapExpression(expr);

  if (
    isStringLiteral(unwrapped) ||
    isNumericLiteral(unwrapped) ||
    isBooleanLiteral(unwrapped) ||
    isNullLiteral(unwrapped) ||
    isBigIntLiteral(unwrapped)
  ) {
    return true;
  }

  if (isArrowFunctionExpression(unwrapped) || isFunctionExpression(unwrapped)) {
    return true;
  }

  if (isIdentifier(unwrapped)) {
    return (
      unwrapped.name === 'undefined' ||
      unwrapped.name === 'NaN' ||
      unwrapped.name === 'Infinity'
    );
  }

  if (isTemplateLiteral(unwrapped)) {
    return unwrapped.expressions.every(
      (item) => isExpression(item) && isSafeExpression(item)
    );
  }

  if (isUnaryExpression(unwrapped)) {
    return isSafeExpression(unwrapped.argument as Expression);
  }

  if (isBinaryExpression(unwrapped) || isLogicalExpression(unwrapped)) {
    return (
      isSafeExpression(unwrapped.left as Expression) &&
      isSafeExpression(unwrapped.right as Expression)
    );
  }

  if (isConditionalExpression(unwrapped)) {
    return (
      isSafeExpression(unwrapped.test) &&
      isSafeExpression(unwrapped.consequent) &&
      isSafeExpression(unwrapped.alternate)
    );
  }

  if (isArrayExpression(unwrapped)) {
    return unwrapped.elements.every((item) => {
      if (item === null) return true;
      if (isSpreadElement(item)) return false;
      return isSafeExpression(item);
    });
  }

  if (isObjectExpression(unwrapped)) {
    return unwrapped.properties.every((prop) => {
      if (isSpreadElement(prop)) {
        return false;
      }

      if (isObjectMethod(prop)) {
        return !prop.computed;
      }

      if (isObjectProperty(prop)) {
        if (prop.computed) {
          return false;
        }

        return isExpression(prop.value) && isSafeExpression(prop.value);
      }

      return false;
    });
  }

  if (
    isCallExpression(unwrapped) ||
    isNewExpression(unwrapped) ||
    isTaggedTemplateExpression(unwrapped) ||
    isAwaitExpression(unwrapped) ||
    isYieldExpression(unwrapped) ||
    isUpdateExpression(unwrapped) ||
    isAssignmentExpression(unwrapped) ||
    isSequenceExpression(unwrapped)
  ) {
    return false;
  }

  return false;
}

function isSafeDeclarator(declarator: VariableDeclarator): boolean {
  if (!declarator.init) {
    return true;
  }

  return isSafeExpression(declarator.init);
}

function isSafeVariableDeclaration(decl: VariableDeclaration): boolean {
  return decl.declarations.every(isSafeDeclarator);
}

function isSafeStatement(statement: Statement): boolean {
  if (isImportDeclaration(statement)) {
    return isTypeOnlyImport(statement);
  }

  if (isExportAllDeclaration(statement)) {
    return false;
  }

  if (isExportNamedDeclaration(statement)) {
    if (!statement.declaration) {
      return !statement.source || isTypeOnlyReExport(statement);
    }

    if (isFunctionDeclaration(statement.declaration)) {
      return true;
    }

    if (isClassDeclaration(statement.declaration)) {
      return false;
    }

    if (statement.declaration.type === 'VariableDeclaration') {
      return isSafeVariableDeclaration(statement.declaration);
    }

    return false;
  }

  if (isExportDefaultDeclaration(statement)) {
    const decl = statement.declaration;
    if (
      isFunctionDeclaration(decl) ||
      isFunctionExpression(decl) ||
      isArrowFunctionExpression(decl) ||
      isClassExpression(decl) ||
      isClassDeclaration(decl)
    ) {
      return false;
    }

    return isSafeExpression(decl as Expression);
  }

  if (statement.type === 'VariableDeclaration') {
    return isSafeVariableDeclaration(statement);
  }

  if (isFunctionDeclaration(statement)) {
    return true;
  }

  if (isEmptyStatement(statement)) {
    return true;
  }

  if (isExpressionStatement(statement)) {
    // Directives (like "use strict") are safe.
    return isStringLiteral(statement.expression);
  }

  return false;
}

export function isStaticallyEvaluatableModule(ast: File): boolean {
  return ast.program.body.every(isSafeStatement);
}
