import type { NodePath, PluginObj } from '@babel/core';

import type { Core } from '../babel';

/**
 * The plugin that replaces `import()` with `__wyw_dynamic_import` as Node VM does not support dynamic imports yet.
 */
export default function dynamicImport(babel: Core): PluginObj {
  const { types: t } = babel;

  return {
    name: '@wyw-in-js/transform/dynamic-import',
    visitor: {
      CallExpression(path) {
        if (path.get('callee').isImport()) {
          const moduleName = path.get('arguments.0') as NodePath;

          if (moduleName.isStringLiteral()) {
            path.replaceWith(
              t.callExpression(t.identifier('__wyw_dynamic_import'), [
                t.stringLiteral(moduleName.node.value),
              ])
            );
            return;
          }

          if (moduleName.isTemplateLiteral()) {
            path.replaceWith(
              t.callExpression(t.identifier('__wyw_dynamic_import'), [
                t.cloneNode(moduleName.node, true, true),
              ])
            );
            return;
          }

          // Throw an error if this import will be reached during evaluation
          // throw new Error(
          //   'Dynamic import argument must be a string or a template literal'
          // );
          path.replaceWith(
            t.callExpression(
              t.arrowFunctionExpression(
                [],
                t.blockStatement([
                  t.throwStatement(
                    t.newExpression(t.identifier('Error'), [
                      t.stringLiteral(
                        'Dynamic import argument must be a string or a template literal'
                      ),
                    ])
                  ),
                ])
              ),
              []
            )
          );
        }
      },
    },
  };
}
