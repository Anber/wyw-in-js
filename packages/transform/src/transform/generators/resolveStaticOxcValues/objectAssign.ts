/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Node, Program } from 'oxc-parser';

import { evaluateOxcStaticExpressionAt } from '../../../utils/collectOxcTemplateDependencies';
import { getOxcNodeChildren } from '../../../utils/oxc/ast';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { getStaticBindings } from './environment';
import { findExportTarget } from './exportTargets';
import {
  findTopLevelConstExpression,
  hasTopLevelBinding,
  objectPropertyKeyName,
  topLevelStatements,
} from './programAnalysis';
import {
  isPlainObjectRecord,
  isStaticObjectAssignAliasValue,
  isStaticWYWMetaValue,
} from './processorStaticModel';
import {
  bindStaticResolvedValue,
  isSafeStaticExpression,
  unwrapExpression,
} from './staticExpression';
import {
  collectStaticExpressionDependencies,
  rootIdentifierName,
  staticMemberName,
} from './staticExpressionDependencies';
import type {
  AnyNode,
  ExportTarget,
  StaticExportResolverContext,
  StaticExportResult,
} from './types';

export const isObjectAssignCallee = (program: Program, expr: Node): boolean => {
  const unwrapped = unwrapExpression(expr);
  if (unwrapped.type !== 'MemberExpression' || unwrapped.computed) {
    return false;
  }

  const methodName = staticMemberName(unwrapped.property);
  return (
    methodName === 'assign' &&
    unwrapped.object.type === 'Identifier' &&
    unwrapped.object.name === 'Object' &&
    !hasTopLevelBinding(program, 'Object')
  );
};

export const isSafeObjectAssignAliasExpression = (
  program: Program,
  expr: Node,
  seen: Set<string> = new Set()
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'Identifier') {
    if (seen.has(unwrapped.name)) {
      return false;
    }

    const local = findTopLevelConstExpression(program, unwrapped.name);
    if (!local) {
      return false;
    }

    seen.add(unwrapped.name);
    const result = isSafeObjectAssignAliasExpression(program, local, seen);
    seen.delete(unwrapped.name);
    return result;
  }

  if (unwrapped.type !== 'ObjectExpression') {
    return false;
  }

  return unwrapped.properties.every((property) => {
    if (property.type === 'SpreadElement') {
      return false;
    }

    const propertyNode = property as AnyNode;
    if (
      propertyNode.computed ||
      propertyNode.method ||
      !propertyNode.value ||
      typeof propertyNode.value !== 'object'
    ) {
      return false;
    }

    return isSafeStaticExpression(propertyNode.value as Node);
  });
};

export const objectAssignTargetExpression = (
  program: Program,
  expr: Node
): Expression | null => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'CallExpression' ||
    !isObjectAssignCallee(program, unwrapped.callee) ||
    unwrapped.arguments.length < 2
  ) {
    return null;
  }

  const [target, ...aliases] = unwrapped.arguments;
  if (!target || target.type === 'SpreadElement') {
    return null;
  }

  if (
    aliases.some(
      (alias) =>
        alias.type === 'SpreadElement' ||
        !isSafeObjectAssignAliasExpression(program, alias)
    )
  ) {
    return null;
  }

  return target;
};

export const objectAssignAliasExpressions = (
  program: Program,
  expr: Node
): Expression[] | null => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'CallExpression' ||
    !isObjectAssignCallee(program, unwrapped.callee) ||
    unwrapped.arguments.length < 2
  ) {
    return null;
  }

  const [, ...aliases] = unwrapped.arguments;
  if (
    aliases.some(
      (alias) =>
        alias.type === 'SpreadElement' ||
        !isSafeObjectAssignAliasExpression(program, alias)
    )
  ) {
    return null;
  }

  return aliases as Expression[];
};

export const isFunctionBoundaryNode = (node: Node): boolean =>
  node.type === 'ArrowFunctionExpression' ||
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ClassDeclaration' ||
  node.type === 'ClassExpression';

export const callHasArgumentRootName = (
  expr: Node,
  targetName: string
): boolean => {
  const unwrapped = unwrapExpression(expr);
  return (
    unwrapped.type === 'CallExpression' &&
    unwrapped.arguments.some((argument) => {
      const argumentNode =
        argument.type === 'SpreadElement' ? argument.argument : argument;
      return rootIdentifierName(argumentNode) === targetName;
    })
  );
};

export const isSafeObjectAssignAliasAugmentation = (
  program: Program,
  expr: Node,
  targetName: string
): boolean => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'CallExpression' ||
    !isObjectAssignCallee(program, unwrapped.callee) ||
    unwrapped.arguments.length < 2
  ) {
    return false;
  }

  const [target, ...aliases] = unwrapped.arguments;
  if (!target || target.type === 'SpreadElement') {
    return false;
  }

  const unwrappedTarget = unwrapExpression(target);
  if (
    unwrappedTarget.type !== 'Identifier' ||
    unwrappedTarget.name !== targetName
  ) {
    return false;
  }

  return aliases.every(
    (alias) =>
      alias.type !== 'SpreadElement' &&
      isSafeObjectAssignAliasExpression(program, alias)
  );
};

export const hasOnlySafeObjectAssignCallArgumentUses = (
  program: Program,
  targetName: string
): boolean => {
  let hasSafeUse = false;
  let hasUnsafeUse = false;

  const visit = (node: Node): void => {
    if (hasUnsafeUse || isFunctionBoundaryNode(node)) {
      return;
    }

    const unwrapped = unwrapExpression(node);
    if (unwrapped.type === 'CallExpression') {
      if (callHasArgumentRootName(unwrapped, targetName)) {
        if (
          isSafeObjectAssignAliasAugmentation(program, unwrapped, targetName)
        ) {
          hasSafeUse = true;
        } else {
          hasUnsafeUse = true;
          return;
        }
      }
    }

    getOxcNodeChildren(node).forEach(visit);
  };

  topLevelStatements(program).forEach(visit);
  return hasSafeUse && !hasUnsafeUse;
};

export const objectAssignAugmentationAliasExpressions = (
  program: Program,
  targetName: string
): Expression[] | null => {
  const aliases: Expression[] = [];
  let hasUnsafeUse = false;

  const visit = (node: Node): void => {
    if (hasUnsafeUse || isFunctionBoundaryNode(node)) {
      return;
    }

    const unwrapped = unwrapExpression(node);
    if (unwrapped.type === 'CallExpression') {
      if (callHasArgumentRootName(unwrapped, targetName)) {
        if (
          isSafeObjectAssignAliasAugmentation(program, unwrapped, targetName)
        ) {
          const [, ...nextAliases] = unwrapped.arguments;
          aliases.push(...(nextAliases as Expression[]));
        } else {
          hasUnsafeUse = true;
        }

        return;
      }
    }

    getOxcNodeChildren(node).forEach(visit);
  };

  topLevelStatements(program).forEach(visit);
  return !hasUnsafeUse && aliases.length > 0 ? aliases : null;
};

export const objectAssignAliasExpressionsForTarget = (
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>
): Expression[] | null => {
  const aliases = [
    ...(objectAssignAliasExpressions(program, target.expression) ?? []),
    ...(target.localName
      ? objectAssignAugmentationAliasExpressions(program, target.localName) ??
        []
      : []),
  ];

  return aliases.length > 0 ? aliases : null;
};

export const resolveObjectAssignProcessorExpression = (
  program: Program,
  expr: Expression
): Expression => {
  const objectAssignTarget = objectAssignTargetExpression(program, expr);
  const target = objectAssignTarget ?? expr;

  if (target.type !== 'Identifier') {
    return target;
  }

  return findTopLevelConstExpression(program, target.name) ?? target;
};

export type ObjectAssignAliasResolution = {
  dependencies: string[];
  sideEffectDependencies: string[];
  values: Record<string, unknown>[];
};

export type ObjectAssignAliasPropertyResolution = {
  dependencies: string[];
  sideEffectDependencies: string[];
  value: unknown;
};

export type ObjectAssignAliasPropertyEntry = {
  key: string;
  value: Expression;
};

export const mergeStaticObjectAssignAliases = (
  targetValue: unknown,
  aliasValues: Record<string, unknown>[]
): unknown | null => {
  if (!isPlainObjectRecord(targetValue) || !isStaticWYWMetaValue(targetValue)) {
    return null;
  }

  const result: Record<string, unknown> = { ...targetValue };
  aliasValues.forEach((aliasValue) => {
    Object.assign(result, aliasValue);
  });

  return result;
};

export const objectAssignAliasObjectExpression = (
  program: Program,
  alias: Expression,
  seen: Set<string> = new Set()
): Expression | null => {
  const unwrapped = unwrapExpression(alias);
  if (unwrapped.type === 'ObjectExpression') {
    return unwrapped as Expression;
  }

  if (unwrapped.type !== 'Identifier' || seen.has(unwrapped.name)) {
    return null;
  }

  const local = findTopLevelConstExpression(program, unwrapped.name);
  if (!local) {
    return null;
  }

  seen.add(unwrapped.name);
  const result = objectAssignAliasObjectExpression(program, local, seen);
  seen.delete(unwrapped.name);
  return result;
};

export const objectAssignAliasPropertyEntries = (
  program: Program,
  alias: Expression
): ObjectAssignAliasPropertyEntry[] | null => {
  const aliasObject = objectAssignAliasObjectExpression(program, alias);
  if (!aliasObject || aliasObject.type !== 'ObjectExpression') {
    return null;
  }

  const entries: ObjectAssignAliasPropertyEntry[] = [];
  for (const property of aliasObject.properties) {
    if (property.type === 'SpreadElement') {
      return null;
    }

    const propertyNode = property as AnyNode;
    if (
      propertyNode.computed ||
      propertyNode.method ||
      !propertyNode.key ||
      !propertyNode.value ||
      typeof propertyNode.key !== 'object' ||
      typeof propertyNode.value !== 'object'
    ) {
      return null;
    }

    const key = objectPropertyKeyName(propertyNode.key as Node);
    if (!key) {
      return null;
    }

    entries.push({
      key,
      value: propertyNode.value as Expression,
    });
  }

  return entries;
};

export function* resolveObjectAssignAliasExpressionValue(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  expression: Expression,
  ignoredMutableCallArgumentNames: Set<string>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolvers: StaticExportResolverContext
): SyncScenarioFor<ObjectAssignAliasPropertyResolution | null> {
  const staticDependencies = collectStaticExpressionDependencies(
    program,
    {
      expression,
      kind: 'expression',
    },
    {
      allowMetadataCalls: true,
      ignoredMutableCallArgumentNames,
    }
  );
  if (!staticDependencies) {
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();

  for (const binding of staticDependencies.imports) {
    const resolved = yield* resolvers.resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (
      !resolved ||
      !bindStaticResolvedValue(env, expression, binding.local, resolved)
    ) {
      return null;
    }

    resolved.dependencies.forEach((item) => dependencies.add(item));
    resolved.sideEffectDependencies?.forEach((item) =>
      sideEffectDependencies.add(item)
    );
  }

  const value = evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: expression.end,
      start: expression.start,
    },
    env,
    getStaticBindings(action)
  );
  return isStaticObjectAssignAliasValue(value)
    ? {
        dependencies: [...dependencies],
        sideEffectDependencies: [...sideEffectDependencies],
        value,
      }
    : null;
}

export function* resolveObjectAssignAliasPropertyValue(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  expression: Expression,
  ignoredMutableCallArgumentNames: Set<string>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolvers: StaticExportResolverContext
): SyncScenarioFor<ObjectAssignAliasPropertyResolution | null> {
  const expressionValue = yield* resolveObjectAssignAliasExpressionValue(
    action,
    filename,
    code,
    program,
    expression,
    ignoredMutableCallArgumentNames,
    stack,
    memo,
    resolvers
  );
  if (expressionValue) {
    return expressionValue;
  }

  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped.type !== 'Identifier' ||
    !findExportTarget(program, unwrapped.name)
  ) {
    return null;
  }

  const resolved = yield* resolvers.resolveStaticExport(
    action,
    filename,
    unwrapped.name,
    stack,
    memo
  );
  return resolved && isStaticObjectAssignAliasValue(resolved.value)
    ? {
        dependencies: resolved.dependencies,
        sideEffectDependencies: resolved.sideEffectDependencies ?? [],
        value: resolved.value,
      }
    : null;
}

export function* resolveObjectAssignAliasValue(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  alias: Expression,
  ignoredMutableCallArgumentNames: Set<string>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolvers: StaticExportResolverContext
): SyncScenarioFor<{
  dependencies: string[];
  sideEffectDependencies: string[];
  value: Record<string, unknown>;
} | null> {
  const aliasValue = yield* resolveObjectAssignAliasExpressionValue(
    action,
    filename,
    code,
    program,
    alias,
    ignoredMutableCallArgumentNames,
    stack,
    memo,
    resolvers
  );
  if (aliasValue && isPlainObjectRecord(aliasValue.value)) {
    return Object.values(aliasValue.value).every(isStaticObjectAssignAliasValue)
      ? {
          dependencies: aliasValue.dependencies,
          sideEffectDependencies: aliasValue.sideEffectDependencies,
          value: aliasValue.value,
        }
      : null;
  }

  const entries = objectAssignAliasPropertyEntries(program, alias);
  if (!entries) {
    return null;
  }

  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();
  const value: Record<string, unknown> = {};

  for (const entry of entries) {
    const resolved = yield* resolveObjectAssignAliasPropertyValue(
      action,
      filename,
      code,
      program,
      entry.value,
      ignoredMutableCallArgumentNames,
      stack,
      memo,
      resolvers
    );
    if (!resolved || !isStaticObjectAssignAliasValue(resolved.value)) {
      return null;
    }

    value[entry.key] = resolved.value;
    resolved.dependencies.forEach((item) => dependencies.add(item));
    resolved.sideEffectDependencies.forEach((item) =>
      sideEffectDependencies.add(item)
    );
  }

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    value,
  };
}

export function* resolveObjectAssignAliasValues(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  aliases: Expression[],
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolvers: StaticExportResolverContext
): SyncScenarioFor<ObjectAssignAliasResolution | null> {
  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();
  const values: Record<string, unknown>[] = [];
  const ignoredMutableCallArgumentNames = new Set<string>();
  aliases.forEach((alias) => {
    const name = rootIdentifierName(alias);
    if (name) {
      ignoredMutableCallArgumentNames.add(name);
    }
  });

  for (const alias of aliases) {
    const aliasValue = yield* resolveObjectAssignAliasValue(
      action,
      filename,
      code,
      program,
      alias,
      ignoredMutableCallArgumentNames,
      stack,
      memo,
      resolvers
    );
    if (!aliasValue) {
      return null;
    }

    aliasValue.dependencies.forEach((item) => dependencies.add(item));
    aliasValue.sideEffectDependencies.forEach((item) =>
      sideEffectDependencies.add(item)
    );
    values.push(aliasValue.value);
  }

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    values,
  };
}
