/* eslint-disable no-continue, no-restricted-syntax */

import type { Node } from 'oxc-parser';

import { unwrapOxcRuntimeExpression } from '../oxc/runtimeSemantics';

type Positioned = { node: Node };

type PatternInitializer<TStatement extends Positioned> = {
  declarationKind: string;
  owner: TStatement;
  value: Node;
};

type InitializerSummary = {
  evaluationBlockedAt: number;
  invalid: boolean;
  readyAt: number;
  value: Node | undefined;
};

export type InitializerStabilityPhase = 'evaluation' | 'receiver';

export const createStableInitializerResolver = <TStatement extends Positioned>({
  aliasComponents,
  effectsByBinding,
  getEffectVersion,
  patternInitializers,
}: {
  aliasComponents: ReadonlyMap<string, ReadonlySet<string>>;
  effectsByBinding: ReadonlyMap<string, ReadonlySet<TStatement>>;
  getEffectVersion: () => number;
  patternInitializers: ReadonlyMap<string, PatternInitializer<TStatement>>;
}) => {
  const initializerSummaries = new Map<string, InitializerSummary>();
  let initializerSummaryVersion = -1;
  const summarizeInitializer = (name: string): InitializerSummary => {
    const effectVersion = getEffectVersion();
    if (initializerSummaryVersion !== effectVersion) {
      initializerSummaries.clear();
      initializerSummaryVersion = effectVersion;
    }

    const existing = initializerSummaries.get(name);
    if (existing) {
      return existing;
    }

    const path: Array<{
      evaluationBlockedAt: number;
      name: string;
      ownerStart: number;
    }> = [];
    const pending = new Set<string>();
    let currentName = name;
    let summary: InitializerSummary;
    for (;;) {
      const cached = initializerSummaries.get(currentName);
      if (cached) {
        summary = cached;
        break;
      }
      if (pending.has(currentName)) {
        summary = {
          evaluationBlockedAt: Infinity,
          invalid: true,
          readyAt: -Infinity,
          value: undefined,
        };
        break;
      }

      const initializer = patternInitializers.get(currentName);
      if (!initializer) {
        summary = {
          evaluationBlockedAt: Infinity,
          invalid: false,
          readyAt: -Infinity,
          value: undefined,
        };
        initializerSummaries.set(currentName, summary);
        break;
      }
      if (initializer.declarationKind !== 'const') {
        summary = {
          evaluationBlockedAt: Infinity,
          invalid: true,
          readyAt: initializer.owner.node.start,
          value: undefined,
        };
        break;
      }

      pending.add(currentName);
      let evaluationBlockedAt = Infinity;
      const component =
        aliasComponents.get(currentName) ?? new Set([currentName]);
      component.forEach((alias) => {
        effectsByBinding.get(alias)?.forEach((effect) => {
          if (effect.node.start > initializer.owner.node.start) {
            evaluationBlockedAt = Math.min(
              evaluationBlockedAt,
              effect.node.start
            );
          }
        });
      });
      path.push({
        evaluationBlockedAt,
        name: currentName,
        ownerStart: initializer.owner.node.start,
      });

      const value = unwrapOxcRuntimeExpression(initializer.value, true);
      if (value.type !== 'Identifier') {
        summary = {
          evaluationBlockedAt: Infinity,
          invalid: false,
          readyAt: -Infinity,
          value: initializer.value,
        };
        break;
      }
      currentName = value.name;
    }

    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index]!;
      summary = {
        evaluationBlockedAt: Math.min(
          entry.evaluationBlockedAt,
          summary.evaluationBlockedAt
        ),
        invalid: summary.invalid,
        readyAt: Math.max(entry.ownerStart, summary.readyAt),
        value: summary.value,
      };
      initializerSummaries.set(entry.name, summary);
    }
    return summary;
  };

  const receiverInitializerResults = new Map<
    TStatement,
    Map<string, Node | null | undefined>
  >();
  const hasBindingEffectBefore = (
    name: string,
    statementStart: number
  ): boolean => {
    const component = aliasComponents.get(name) ?? new Set([name]);
    for (const alias of component) {
      const effects = effectsByBinding.get(alias);
      if (!effects) {
        continue;
      }
      for (const effect of effects) {
        if (effect.node.start < statementStart) {
          return true;
        }
      }
    }
    return false;
  };
  const resolveStableReceiverInitializer = (
    statement: TStatement,
    name: string
  ): Node | null | undefined => {
    const results =
      receiverInitializerResults.get(statement) ??
      new Map<string, Node | null | undefined>();
    receiverInitializerResults.set(statement, results);
    if (results.has(name)) {
      return results.get(name);
    }

    const path: string[] = [];
    const pending = new Set<string>();
    let currentName = name;
    let result: Node | null | undefined;
    for (;;) {
      if (results.has(currentName)) {
        result = results.get(currentName);
        break;
      }
      if (pending.has(currentName)) {
        result = null;
        break;
      }

      const initializer = patternInitializers.get(currentName);
      if (!initializer) {
        result = undefined;
        results.set(currentName, result);
        break;
      }
      if (
        initializer.declarationKind !== 'const' ||
        initializer.owner.node.start > statement.node.start ||
        hasBindingEffectBefore(currentName, statement.node.start)
      ) {
        result = null;
        break;
      }

      pending.add(currentName);
      path.push(currentName);
      const value = unwrapOxcRuntimeExpression(initializer.value, true);
      if (value.type !== 'Identifier') {
        result = initializer.value;
        break;
      }
      currentName = value.name;
    }

    path.forEach((entry) => results.set(entry, result));
    return result;
  };

  return (
    statement: TStatement,
    name: string,
    phase: InitializerStabilityPhase = 'receiver'
  ): Node | null | undefined => {
    if (phase === 'receiver') {
      return resolveStableReceiverInitializer(statement, name);
    }
    const summary = summarizeInitializer(name);
    if (
      summary.invalid ||
      summary.readyAt > statement.node.start ||
      summary.evaluationBlockedAt < statement.node.start
    ) {
      return null;
    }
    return summary.value;
  };
};
