import type { Expression } from '@babel/types';
import * as t from '@babel/types';

export function getConstantStringValue(node: Expression): string | null {
  const unwrapOnce = (value: Expression): Expression => {
    if (t.isTSAsExpression(value)) return value.expression;
    if (t.isTSTypeAssertion(value)) return value.expression;
    if (t.isTSNonNullExpression(value)) return value.expression;
    if (t.isParenthesizedExpression(value)) return value.expression;
    return value;
  };

  const unwrapExpression = (value: Expression): Expression => {
    let current = value;
    let next = unwrapOnce(current);
    while (next !== current) {
      current = next;
      next = unwrapOnce(current);
    }
    return current;
  };

  const getConcatPropertyName = (
    value: t.Node | null | undefined
  ): string | null => {
    if (!t.isMemberExpression(value)) return null;
    if (!value.computed && t.isIdentifier(value.property)) {
      return value.property.name;
    }
    if (value.computed && t.isStringLiteral(value.property)) {
      return value.property.value;
    }
    return null;
  };

  const fromExpression = (value: Expression): string | null => {
    const expression = unwrapExpression(value);

    if (t.isStringLiteral(expression)) {
      return expression.value;
    }

    if (t.isTemplateLiteral(expression)) {
      if (expression.expressions.length !== 0) {
        return null;
      }

      const [quasi] = expression.quasis;
      return quasi?.value.cooked ?? null;
    }

    if (t.isBinaryExpression(expression) && expression.operator === '+') {
      if (!t.isExpression(expression.left) || !t.isExpression(expression.right))
        return null;

      const left = fromExpression(expression.left);
      const right = fromExpression(expression.right);
      if (left === null || right === null) {
        return null;
      }

      return left + right;
    }

    if (t.isCallExpression(expression)) {
      const concatProperty = getConcatPropertyName(expression.callee);
      if (concatProperty !== 'concat') {
        return null;
      }

      const { callee } = expression;
      if (!t.isMemberExpression(callee) || !t.isExpression(callee.object)) {
        return null;
      }

      const base = fromExpression(callee.object);
      if (base === null) {
        return null;
      }

      const parts: string[] = [base];
      for (const arg of expression.arguments) {
        if (!t.isExpression(arg)) {
          return null;
        }
        const part = fromExpression(arg);
        if (part === null) {
          return null;
        }
        parts.push(part);
      }

      return parts.join('');
    }

    return null;
  };

  return fromExpression(node);
}
