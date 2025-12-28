import type { MemberExpression } from '@babel/types';
import * as t from '@babel/types';

export function getMemberExpressionPropertyName(
  node: MemberExpression
): string | null {
  if (!node.computed && t.isIdentifier(node.property)) {
    return node.property.name;
  }

  if (node.computed && t.isStringLiteral(node.property)) {
    return node.property.value;
  }

  return null;
}
