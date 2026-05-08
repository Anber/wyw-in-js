/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Node, Program } from 'oxc-parser';

import { collectOxcProcessorImportsFromProgram } from '../../../utils/collectOxcExportsAndImports';
import { getOxcNodeChildren } from '../../../utils/oxc/ast';
import { getProcessorForImport } from '../../../utils/processorLookup';
import type { ITransformAction } from '../../types';
import { parseProgram } from './environment';
import {
  findObjectPropertyValue,
  findTopLevelConstExpression,
  objectPropertyKeyName,
} from './programAnalysis';
import { isSafeLiteral, unwrapExpression } from './staticExpression';
import type { AnyNode } from './types';
import { GENERATED_HELPER_NAME_RE } from './types';

export const collectProcessorImportLocals = (
  action: ITransformAction,
  program: Program,
  code: string,
  filename: string
): Set<string> => {
  const result = new Set<string>();

  collectOxcProcessorImportsFromProgram(program, code).forEach((item) => {
    if (
      item.type !== 'esm' ||
      item.imported === '*' ||
      item.imported === 'side-effect'
    ) {
      return;
    }

    const localName = item.local.name ?? item.local.code;
    if (!localName) {
      return;
    }

    const [processor] = getProcessorForImport(
      {
        imported: item.imported,
        source: item.source,
      },
      filename,
      action.services.options.pluginOptions
    );

    if (!processor) {
      return;
    }

    result.add(localName);
    const rootLocalName = localName.split('.')[0];
    if (rootLocalName) {
      result.add(rootLocalName);
    }
  });

  return result;
};

export const isStaticWYWMetaValue = (
  value: unknown,
  seen: Set<unknown> = new Set()
): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  const meta = (value as { __wyw_meta?: unknown }).__wyw_meta;
  if (typeof meta !== 'object' || meta === null) {
    return false;
  }

  const { className, extends: extended } = meta as {
    className?: unknown;
    extends?: unknown;
  };

  return (
    typeof className === 'string' &&
    (extended === null || isStaticWYWMetaValue(extended, seen))
  );
};

export type StaticWYWSelectorMetaValue = {
  __wyw_meta: {
    className: string;
    extends: StaticWYWSelectorMetaValue | null;
  };
};

export const toStaticWYWSelectorMetaValue = (
  value: unknown,
  seen: Set<unknown> = new Set()
): StaticWYWSelectorMetaValue | null => {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return null;
  }

  seen.add(value);

  const meta = (value as { __wyw_meta?: unknown }).__wyw_meta;
  if (typeof meta !== 'object' || meta === null) {
    return null;
  }

  const { className, extends: extended } = meta as {
    className?: unknown;
    extends?: unknown;
  };
  if (typeof className !== 'string') {
    return null;
  }

  const staticExtends =
    extended === null ? null : toStaticWYWSelectorMetaValue(extended, seen);
  if (extended !== null && staticExtends === null) {
    return null;
  }

  return {
    __wyw_meta: {
      className,
      extends: staticExtends,
    },
  };
};

export const staticWYWMetaExtendsReplacementCode = (
  value: unknown
): string | null => {
  if (value === null) {
    return 'null';
  }

  const selectorMeta = toStaticWYWSelectorMetaValue(value);
  return selectorMeta ? `(${JSON.stringify(selectorMeta)})` : null;
};

export const unknownStaticWYWMetaValue = Symbol('unknownStaticWYWMetaValue');

export type UnknownStaticWYWMetaValue = typeof unknownStaticWYWMetaValue;

export const zeroArgFunctionExpressionBody = (
  expr: Expression
): Expression | null => {
  const unwrapped = unwrapExpression(expr) as AnyNode;
  if (
    unwrapped.type !== 'ArrowFunctionExpression' ||
    !Array.isArray(unwrapped.params) ||
    unwrapped.params.length !== 0
  ) {
    return null;
  }

  const body = unwrapped.body as Node | undefined;
  return body && body.type !== 'BlockStatement' ? (body as Expression) : null;
};

export const isNullLiteralExpression = (node: Node): boolean => {
  const unwrapped = unwrapExpression(node);
  return isSafeLiteral(unwrapped) && unwrapped.value === null;
};

export const isNullReturningFunctionExpression = (
  expr: Expression
): boolean => {
  const unwrapped = unwrapExpression(expr) as AnyNode;
  if (
    unwrapped.type !== 'ArrowFunctionExpression' &&
    unwrapped.type !== 'FunctionExpression'
  ) {
    return false;
  }

  if (unwrapped.async || unwrapped.generator) {
    return false;
  }

  const body = unwrapped.body as Node | undefined;
  if (!body) {
    return false;
  }

  if (body.type !== 'BlockStatement') {
    return isNullLiteralExpression(body);
  }

  if (!Array.isArray(body.body) || body.body.length !== 1) {
    return false;
  }

  const [statement] = body.body;
  return (
    statement?.type === 'ReturnStatement' &&
    !!statement.argument &&
    isNullLiteralExpression(statement.argument)
  );
};

export const createSameFileStaticWYWMetaHelperResolver = (
  code: string,
  filename: string
): ((seedValues: Map<string, unknown>) => Map<string, unknown>) => {
  const declarations = new Map<string, Expression>();
  const nullFunctionNames = new Set<string>();

  try {
    const program = parseProgram(code, filename);
    const collectDeclarations = (statement: Node): void => {
      if (statement.type === 'VariableDeclaration') {
        statement.declarations.forEach((declarator) => {
          if (declarator.id.type !== 'Identifier' || !declarator.init) {
            return;
          }

          const { name } = declarator.id;
          const init = declarator.init as Expression;
          if (isNullReturningFunctionExpression(init)) {
            nullFunctionNames.add(name);
            return;
          }

          const unwrapped = unwrapExpression(init);
          if (
            unwrapped.type === 'ObjectExpression' &&
            findObjectPropertyValue(unwrapped, '__wyw_meta')
          ) {
            declarations.set(name, init);
            return;
          }

          const body = zeroArgFunctionExpressionBody(init);
          if (body && GENERATED_HELPER_NAME_RE.test(name)) {
            declarations.set(name, body);
          }
        });
      }
    };

    program.body.forEach((statement) => {
      if (
        statement.type === 'ExportNamedDeclaration' &&
        statement.declaration
      ) {
        collectDeclarations(statement.declaration);
        return;
      }

      collectDeclarations(statement);
    });
  } catch {
    return () => new Map();
  }

  return (seedValues) => {
    const memo = new Map<string, unknown | UnknownStaticWYWMetaValue>();
    const resolving = new Set<string>();

    const resolveName = (name: string): unknown | UnknownStaticWYWMetaValue => {
      if (seedValues.has(name)) {
        return seedValues.get(name);
      }

      if (memo.has(name)) {
        return memo.get(name)!;
      }

      const expression = declarations.get(name);
      if (!expression || resolving.has(name)) {
        if (nullFunctionNames.has(name)) {
          memo.set(name, null);
          return null;
        }

        return unknownStaticWYWMetaValue;
      }

      resolving.add(name);
      const value = resolveExpression(expression);
      resolving.delete(name);
      memo.set(name, value);
      return value;
    };

    const resolveExpression = (
      expression: Node
    ): unknown | UnknownStaticWYWMetaValue => {
      const unwrapped = unwrapExpression(expression);
      if (isSafeLiteral(unwrapped)) {
        return unwrapped.value;
      }

      if (unwrapped.type === 'Identifier') {
        return resolveName(unwrapped.name);
      }

      if (unwrapped.type === 'CallExpression') {
        const callee = unwrapExpression(unwrapped.callee);
        if (callee.type === 'Identifier' && unwrapped.arguments.length === 0) {
          return resolveName(callee.name);
        }

        return unknownStaticWYWMetaValue;
      }

      if (unwrapped.type !== 'ObjectExpression') {
        return unknownStaticWYWMetaValue;
      }

      const value: Record<string, unknown> = {};
      for (const property of unwrapped.properties) {
        if (property.type === 'SpreadElement') {
          return unknownStaticWYWMetaValue;
        }

        const propertyNode = property as AnyNode;
        if (propertyNode.computed) {
          return unknownStaticWYWMetaValue;
        }

        const propertyKey = propertyNode.key as Node | undefined;
        const key = propertyKey ? objectPropertyKeyName(propertyKey) : null;
        const propertyValue = propertyNode.value as Expression | undefined;
        if (key === null || !propertyValue) {
          return unknownStaticWYWMetaValue;
        }

        const resolved = resolveExpression(propertyValue);
        if (resolved === unknownStaticWYWMetaValue) {
          return unknownStaticWYWMetaValue;
        }

        value[key] = resolved;
      }

      return value;
    };

    const result = new Map<string, unknown>();
    declarations.forEach((_expression, name) => {
      if (!GENERATED_HELPER_NAME_RE.test(name)) {
        return;
      }

      const value = resolveName(name);
      if (
        value !== unknownStaticWYWMetaValue &&
        (value === null || isStaticWYWMetaValue(value))
      ) {
        result.set(name, value);
      }
    });

    return result;
  };
};

export const staticWYWMetaTreeValueStatus = (
  value: unknown,
  seen: Set<unknown> = new Set()
): { hasMetadata: boolean; safe: boolean } => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return {
      hasMetadata: false,
      safe: true,
    };
  }

  if (typeof value !== 'object') {
    return {
      hasMetadata: false,
      safe: false,
    };
  }

  if (seen.has(value)) {
    return {
      hasMetadata: false,
      safe: false,
    };
  }
  seen.add(value);

  if (Array.isArray(value)) {
    let hasMetadata = false;
    for (const item of value) {
      const status = staticWYWMetaTreeValueStatus(item, seen);
      if (!status.safe) {
        return {
          hasMetadata: false,
          safe: false,
        };
      }

      hasMetadata = hasMetadata || status.hasMetadata;
    }

    return {
      hasMetadata,
      safe: true,
    };
  }

  if ('__wyw_meta' in value) {
    return {
      hasMetadata: isStaticWYWMetaValue(value),
      safe: isStaticWYWMetaValue(value),
    };
  }

  let hasMetadata = false;
  for (const item of Object.values(value)) {
    const status = staticWYWMetaTreeValueStatus(item, seen);
    if (!status.safe) {
      return {
        hasMetadata: false,
        safe: false,
      };
    }

    hasMetadata = hasMetadata || status.hasMetadata;
  }

  return {
    hasMetadata,
    safe: true,
  };
};

export const isStaticWYWMetaTreeValue = (value: unknown): boolean => {
  const status = staticWYWMetaTreeValueStatus(value);
  return status.safe && status.hasMetadata;
};

export type StaticProcessorInstance = {
  artifacts: unknown[];
  build: (values: Map<string, unknown>) => void;
  className: string;
};

export const isPlainObjectRecord = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

export const isStaticObjectAssignAliasValue = (value: unknown): boolean =>
  isStaticWYWMetaValue(value) || isStaticWYWMetaTreeValue(value);

export const artifactCssText = (artifact: unknown): string | null => {
  if (!Array.isArray(artifact) || artifact[0] !== 'css') {
    return null;
  }

  const payload = artifact[1];
  if (Array.isArray(payload)) {
    const [rules] = payload;
    if (typeof rules === 'object' && rules !== null) {
      return Object.values(rules)
        .map((rule) =>
          typeof rule === 'object' &&
          rule !== null &&
          'cssText' in rule &&
          typeof (rule as { cssText?: unknown }).cssText === 'string'
            ? (rule as { cssText: string }).cssText
            : ''
        )
        .join('');
    }
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    'cssText' in payload &&
    typeof (payload as { cssText?: unknown }).cssText === 'string'
  ) {
    return (payload as { cssText: string }).cssText;
  }

  return null;
};

export const isEmptyProcessorClassName = (
  value: string,
  processors: StaticProcessorInstance[],
  cache: Map<string, boolean>
): boolean => {
  if (cache.has(value)) {
    return cache.get(value)!;
  }

  const processor = processors.find((item) => item.className === value);
  if (!processor) {
    cache.set(value, false);
    return false;
  }

  if (processor.artifacts.length === 0) {
    try {
      processor.build(new Map());
    } catch {
      cache.set(value, false);
      return false;
    }
  }

  const result = processor.artifacts.every((artifact) => {
    const cssText = artifactCssText(artifact);
    return cssText !== null && cssText.trim() === '';
  });
  cache.set(value, result);
  return result;
};

export const isProcessorClassName = (
  value: string,
  processors: StaticProcessorInstance[],
  cache: Map<string, boolean>
): boolean => {
  if (cache.has(value)) {
    return cache.get(value)!;
  }

  const processor = processors.find((item) => item.className === value);
  if (!processor) {
    cache.set(value, false);
    return false;
  }

  if (processor.artifacts.length === 0) {
    try {
      processor.build(new Map());
    } catch {
      cache.set(value, false);
      return false;
    }
  }

  const result = processor.artifacts.every(
    (artifact) => artifactCssText(artifact) !== null
  );
  cache.set(value, result);
  return result;
};

export const isKnownProcessorClassName = (
  value: string,
  processorClassNames: ReadonlySet<string>
): boolean => processorClassNames.has(value);

export const isSelectorOnlyProcessorValue = (
  value: unknown,
  processors: StaticProcessorInstance[],
  cache: Map<string, boolean>,
  seen: Set<unknown> = new Set()
): boolean => {
  if (typeof value === 'string') {
    return isEmptyProcessorClassName(value, processors, cache);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return value.every((item) =>
      isSelectorOnlyProcessorValue(item, processors, cache, seen)
    );
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return Object.values(value).every((item) =>
      isSelectorOnlyProcessorValue(item, processors, cache, seen)
    );
  }

  return false;
};

export const isProcessorClassValue = (
  value: unknown,
  processors: StaticProcessorInstance[],
  cache: Map<string, boolean>,
  seen: Set<unknown> = new Set()
): boolean => {
  if (typeof value === 'string') {
    return isProcessorClassName(value, processors, cache);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return value.every((item) =>
      isProcessorClassValue(item, processors, cache, seen)
    );
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return Object.values(value).every((item) =>
      isProcessorClassValue(item, processors, cache, seen)
    );
  }

  return false;
};

export const isKnownProcessorClassValue = (
  value: unknown,
  processorClassNames: ReadonlySet<string>,
  seen: Set<unknown> = new Set()
): boolean => {
  if (typeof value === 'string') {
    return isKnownProcessorClassName(value, processorClassNames);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return value.every((item) =>
      isKnownProcessorClassValue(item, processorClassNames, seen)
    );
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return Object.values(value).every((item) =>
      isKnownProcessorClassValue(item, processorClassNames, seen)
    );
  }

  return false;
};
export const findWYWMetaExtendsExpression = (
  expr: Expression
): Expression | null => {
  const meta = findObjectPropertyValue(expr, '__wyw_meta');
  if (!meta) {
    return null;
  }

  return findObjectPropertyValue(meta, 'extends');
};

export const collectWYWMetaExtendsExpressionsDeep = (
  program: Program,
  expr: Expression
): Expression[] => {
  const result: Expression[] = [];
  const seenLocals = new Set<string>();
  const seenRanges = new Set<string>();

  const visit = (node: Node, parent: Node | null = null): void => {
    const parentRecord = parent as AnyNode | null;
    if (
      parentRecord &&
      parentRecord.type === 'Property' &&
      parentRecord.key === node &&
      !parentRecord.computed
    ) {
      return;
    }

    if (node.type === 'ObjectExpression') {
      const extendsExpression = findWYWMetaExtendsExpression(
        node as Expression
      );
      if (extendsExpression) {
        const key = `${extendsExpression.start}:${extendsExpression.end}`;
        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          result.push(extendsExpression);
        }
      }
    }

    if (node.type === 'Identifier') {
      const local = findTopLevelConstExpression(program, node.name);
      if (local && !seenLocals.has(node.name)) {
        seenLocals.add(node.name);
        visit(local);
      }
      return;
    }

    getOxcNodeChildren(node).forEach((child) => visit(child, node));
  };

  visit(expr);
  return result;
};
export const isStaticMetaObjectExpression = (expr: Node): boolean => {
  const meta = findObjectPropertyValue(expr, '__wyw_meta');
  return !!meta && findObjectPropertyValue(meta, 'className') !== null;
};
export const collectWYWMetaExtendsHelperNames = (
  program: Program
): Set<string> => {
  const result = new Set<string>();

  const visit = (node: Node): void => {
    if (node.type === 'ObjectExpression') {
      const extendsExpression = findWYWMetaExtendsExpression(node);
      const unwrapped = extendsExpression
        ? unwrapExpression(extendsExpression)
        : null;
      if (
        unwrapped?.type === 'CallExpression' &&
        unwrapped.callee.type === 'Identifier' &&
        unwrapped.arguments.length === 0
      ) {
        result.add(unwrapped.callee.name);
      }
    }

    getOxcNodeChildren(node).forEach(visit);
  };

  visit(program);
  return result;
};
