/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Program } from 'oxc-parser';

import {
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
} from '../../../utils/collectOxcTemplateDependencies';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import { getStaticBindings } from './environment';
import { bindStaticResolvedValue, unwrapExpression } from './staticExpression';
import { collectStaticExpressionDependencies } from './staticExpressionDependencies';
import type {
  ExportTarget,
  ResolveStaticImportValue,
  StaticExportResult,
} from './types';

export const zeroArgFunctionReturnExpression = (
  expression: Expression
): Expression | null => {
  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped.type !== 'ArrowFunctionExpression' &&
    unwrapped.type !== 'FunctionExpression'
  ) {
    return null;
  }

  if (unwrapped.async || unwrapped.params.length !== 0 || !unwrapped.body) {
    return null;
  }

  if (unwrapped.body.type !== 'BlockStatement') {
    return unwrapped.body as Expression;
  }

  if (unwrapped.body.body.length !== 1) {
    return null;
  }

  const [statement] = unwrapped.body.body;
  return statement?.type === 'ReturnStatement' && statement.argument
    ? statement.argument
    : null;
};

export function* resolveZeroArgFunctionStaticExport(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>,
  resolveImportValue: ResolveStaticImportValue
): SyncScenarioFor<StaticExportResult | null> {
  const returnExpression = zeroArgFunctionReturnExpression(target.expression);
  if (!returnExpression) {
    return null;
  }

  const staticDependencies = collectStaticExpressionDependencies(
    program,
    {
      ...target,
      expression: returnExpression,
    },
    { allowMetadataCalls: true }
  );
  if (!staticDependencies) {
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);
  const sideEffectDependencies = new Set<string>();

  for (const binding of staticDependencies.imports) {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!resolved) {
      return null;
    }

    if (
      !bindStaticResolvedValue(env, returnExpression, binding.local, resolved)
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
      end: returnExpression.end,
      start: returnExpression.start,
    },
    env,
    getStaticBindings(action)
  );
  return isOxcStaticSerializableValue(value)
    ? {
        callable: 'zero-arg',
        dependencies: [...dependencies],
        sideEffectDependencies: [...sideEffectDependencies],
        value,
      }
    : null;
}
