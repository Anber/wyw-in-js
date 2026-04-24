import type { PluginObj } from '@babel/core';
import type { Expression } from '@babel/types';

import type { Core } from '../babel';
import { unwrapExpression } from '../utils/unwrapExpression';

const isLiteralRequireArg = (
  t: Core['types'],
  expression: Expression
): boolean => {
  const unwrapped = unwrapExpression(expression);
  if (t.isStringLiteral(unwrapped)) {
    return true;
  }

  if (t.isTemplateLiteral(unwrapped) && unwrapped.expressions.length === 0) {
    return true;
  }

  return false;
};

export default function requireFallbackPlugin(babel: Core): PluginObj {
  const { types: t } = babel;

  return {
    name: '@wyw-in-js/transform/require-fallback',
    visitor: {
      CallExpression(path) {
        const callee = path.get('callee');
        if (!callee.isIdentifier({ name: 'require' })) {
          return;
        }

        if (path.scope.getBinding('require')) {
          return;
        }

        const args = path.get('arguments');
        if (args.length !== 1) {
          return;
        }

        const firstArg = args[0];
        if (!firstArg.isExpression()) {
          return;
        }

        if (isLiteralRequireArg(t, firstArg.node)) {
          return;
        }

        path.node.arguments.push(t.booleanLiteral(true));
      },
    },
  };
}
