import type { Expression } from '@babel/types';
import * as t from '@babel/types';

const unwrapOnce = (node: Expression): Expression => {
  if (t.isTSAsExpression(node)) return node.expression;
  if (t.isTSTypeAssertion(node)) return node.expression;
  if (t.isTSNonNullExpression(node)) return node.expression;
  if (t.isParenthesizedExpression(node)) return node.expression;
  return node;
};

export function unwrapExpression(node: Expression): Expression {
  let current = node;
  let next = unwrapOnce(current);

  while (next !== current) {
    current = next;
    next = unwrapOnce(current);
  }

  return current;
}
