/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Program } from 'oxc-parser';

import { evaluateOxcStaticExpressionAt } from '../../../utils/collectOxcTemplateDependencies';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { getStaticBindings } from './environment';
import { findTopLevelConstExpression } from './programAnalysis';
import {
  collectImportBindings,
  bindStaticResolvedValue,
} from './staticExpression';
import { collectStaticExpressionDependencies } from './staticExpressionDependencies';
import {
  mergeStaticObjectAssignAliases,
  objectAssignAliasExpressionsForTarget,
  objectAssignTargetExpression,
  resolveObjectAssignAliasValues,
} from './objectAssign';
import { isStaticWYWMetaValue } from './processorStaticModel';
import type {
  ExportTarget,
  StaticExportResolverContext,
  StaticExportResult,
} from './types';

export function* resolveObjectAssignStaticExport(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolvers: StaticExportResolverContext
): SyncScenarioFor<StaticExportResult | null> {
  const objectAssignAliases = objectAssignAliasExpressionsForTarget(
    program,
    target
  );
  const objectAssignTarget = objectAssignTargetExpression(
    program,
    target.expression
  );
  if (!objectAssignTarget) {
    return null;
  }

  const imports = collectImportBindings(program);
  if (objectAssignTarget.type === 'Identifier') {
    const importBinding = imports.get(objectAssignTarget.name);
    if (importBinding) {
      const resolved = yield* resolvers.resolveImportValue(
        action,
        filename,
        importBinding,
        stack,
        memo
      );
      if (!resolved || !isStaticWYWMetaValue(resolved.value)) {
        return null;
      }

      const dependencies = new Set([
        filename,
        ...resolved.dependencies.filter((item) => item !== filename),
      ]);
      const sideEffectDependencies = new Set(
        resolved.sideEffectDependencies ?? []
      );
      const aliasValues = objectAssignAliases
        ? yield* resolveObjectAssignAliasValues(
            action,
            filename,
            code,
            program,
            objectAssignAliases,
            stack,
            memo,
            resolvers
          )
        : null;
      const mergedValue = aliasValues
        ? mergeStaticObjectAssignAliases(resolved.value, aliasValues.values)
        : null;
      aliasValues?.dependencies.forEach((item) => dependencies.add(item));
      aliasValues?.sideEffectDependencies.forEach((item) =>
        sideEffectDependencies.add(item)
      );

      return {
        dependencies: [...dependencies],
        sideEffectDependencies: [...sideEffectDependencies],
        value: mergedValue ?? resolved.value,
      };
    }
  }

  const expression =
    objectAssignTarget.type === 'Identifier'
      ? findTopLevelConstExpression(program, objectAssignTarget.name) ??
        objectAssignTarget
      : objectAssignTarget;
  const staticDependencies = collectStaticExpressionDependencies(program, {
    ...target,
    expression,
  });
  if (!staticDependencies) {
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);
  const sideEffectDependencies = new Set<string>();

  for (const binding of staticDependencies.imports) {
    const resolved = yield* resolvers.resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!resolved) {
      return null;
    }

    if (!bindStaticResolvedValue(env, expression, binding.local, resolved)) {
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
  if (!isStaticWYWMetaValue(value)) {
    return null;
  }

  const aliasValues = objectAssignAliases
    ? yield* resolveObjectAssignAliasValues(
        action,
        filename,
        code,
        program,
        objectAssignAliases,
        stack,
        memo,
        resolvers
      )
    : null;
  const mergedValue = aliasValues
    ? mergeStaticObjectAssignAliases(value, aliasValues.values)
    : null;
  aliasValues?.dependencies.forEach((item) => dependencies.add(item));
  aliasValues?.sideEffectDependencies.forEach((item) =>
    sideEffectDependencies.add(item)
  );

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    value: mergedValue ?? value,
  };
}
