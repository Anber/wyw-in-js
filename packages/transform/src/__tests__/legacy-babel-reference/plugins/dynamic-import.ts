import type { NodePath, PluginObj } from '@babel/core';
import type { Expression } from '@babel/types';

import type { Core } from '../babel';
import { getMemberExpressionPropertyName } from '../utils/getMemberExpressionPropertyName';
import { unwrapExpression } from '../utils/unwrapExpression';

/**
 * The plugin that replaces `import()` with `__wyw_dynamic_import` as Node VM does not support dynamic imports yet.
 */
export default function dynamicImport(babel: Core): PluginObj {
  const { types: t } = babel;

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
      const propertyName = getMemberExpressionPropertyName(callee);
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

  return {
    name: '@wyw-in-js/transform/dynamic-import',
    visitor: {
      CallExpression(path) {
        if (path.get('callee').isImport()) {
          const moduleName = path.get('arguments.0') as NodePath;
          const argument = moduleName.isExpression() ? moduleName.node : null;

          if (argument) {
            const unwrappedArgument = unwrapExpression(argument);
            const nextArgument = isStringLikeExpression(argument)
              ? t.cloneNode(unwrappedArgument, true, true)
              : t.cloneNode(argument, true, true);

            path.replaceWith(
              t.callExpression(t.identifier('__wyw_dynamic_import'), [
                nextArgument,
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
