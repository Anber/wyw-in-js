import type { NodePath, PluginObj } from '@babel/core';
import type { Expression, MemberExpression } from '@babel/types';

import type { Core } from '../babel';

/**
 * The plugin that replaces `import()` with `__wyw_dynamic_import` as Node VM does not support dynamic imports yet.
 */
export default function dynamicImport(babel: Core): PluginObj {
  const { types: t } = babel;

  const unwrapOnce = (node: Expression): Expression => {
    if (t.isTSAsExpression(node)) {
      return node.expression;
    }
    if (t.isTSTypeAssertion(node)) {
      return node.expression;
    }
    if (t.isTSNonNullExpression(node)) {
      return node.expression;
    }
    if (t.isParenthesizedExpression(node)) {
      return node.expression;
    }
    return node;
  };

  const unwrapExpression = (node: Expression): Expression => {
    let current = node;
    let next = unwrapOnce(current);
    while (next !== current) {
      current = next;
      next = unwrapOnce(current);
    }
    return current;
  };

  const getConcatPropertyName = (node: MemberExpression): string | null => {
    if (!node.computed && t.isIdentifier(node.property)) {
      return node.property.name;
    }
    if (node.computed && t.isStringLiteral(node.property)) {
      return node.property.value;
    }
    return null;
  };

  const isStringLikeExpression = (node: Expression): boolean => {
    const expression = unwrapExpression(node);

    if (t.isStringLiteral(expression) || t.isTemplateLiteral(expression)) {
      return true;
    }

    if (t.isBinaryExpression(expression) && expression.operator === '+') {
      return (
        (t.isExpression(expression.left) &&
          isStringLikeExpression(expression.left)) ||
        (t.isExpression(expression.right) &&
          isStringLikeExpression(expression.right))
      );
    }

    if (t.isCallExpression(expression)) {
      const { callee } = expression;
      if (!t.isMemberExpression(callee)) {
        return false;
      }
      const propertyName = getConcatPropertyName(callee);
      if (propertyName !== 'concat') {
        return false;
      }
      if (!t.isExpression(callee.object)) {
        return false;
      }
      return isStringLikeExpression(callee.object);
    }

    return false;
  };

  const normalizeImportArgument = (node: Expression): Expression => {
    const unwrapped = unwrapExpression(node);
    const cloned = t.cloneNode(unwrapped, true, true);

    if (isStringLikeExpression(unwrapped)) {
      return cloned;
    }

    return t.binaryExpression('+', t.stringLiteral(''), cloned);
  };

  return {
    name: '@wyw-in-js/transform/dynamic-import',
    visitor: {
      CallExpression(path) {
        if (path.get('callee').isImport()) {
          const moduleName = path.get('arguments.0') as NodePath;
          const argument = moduleName.isExpression()
            ? unwrapExpression(moduleName.node)
            : null;

          if (argument) {
            path.replaceWith(
              t.callExpression(t.identifier('__wyw_dynamic_import'), [
                normalizeImportArgument(argument),
              ])
            );
            return;
          }

          path.replaceWith(
            t.callExpression(t.identifier('__wyw_dynamic_import'), [])
          );
        }
      },
    },
  };
}
