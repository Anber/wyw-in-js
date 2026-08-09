import type { Node } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternRuntimeExpressions } from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';

const isDirectReadOnlyExpression = (node: Node): boolean => {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSInstantiationExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return isDirectReadOnlyExpression(node.expression);
  }

  return node.type === 'Identifier' || node.type === 'Literal';
};

const readOnlyOpaqueFunctionCache = new WeakMap<Node, boolean>();

export const isReadOnlyOpaqueFunction = (node: Node): boolean => {
  const cached = readOnlyOpaqueFunctionCache.get(node);
  if (cached !== undefined) {
    return cached;
  }

  if (!isOxcFunctionLike(node)) {
    readOnlyOpaqueFunctionCache.set(node, false);
    return false;
  }

  if (
    node.params.some(
      (param) => collectOxcPatternRuntimeExpressions(param).length > 0
    )
  ) {
    readOnlyOpaqueFunctionCache.set(node, false);
    return false;
  }

  const { body } = node;
  if (!body) {
    readOnlyOpaqueFunctionCache.set(node, false);
    return false;
  }
  if (body.type !== 'BlockStatement') {
    const result = isDirectReadOnlyExpression(body);
    readOnlyOpaqueFunctionCache.set(node, result);
    return result;
  }

  const result = getOxcNodeChildren(body).every(
    (statement) =>
      statement.type === 'EmptyStatement' ||
      (statement.type === 'ExpressionStatement' &&
        statement.expression.type === 'Literal' &&
        typeof statement.expression.value === 'string') ||
      (statement.type === 'ReturnStatement' &&
        (!statement.argument || isDirectReadOnlyExpression(statement.argument)))
  );
  readOnlyOpaqueFunctionCache.set(node, result);
  return result;
};
