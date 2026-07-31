/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Node } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import {
  collectOxcPatternBindingIdentifiers,
  collectOxcPatternRuntimeExpressions,
  collectOxcPatternShorthandProperties,
} from '../oxc/patterns';
import { toOxcBindingIdentity } from './bindingIdentity';
import {
  applyExpressionReplacements,
  collectIdentifierReferenceReplacements,
  getConstantReplacement,
  replaceIdentifierReferences,
} from './expressionReplacements';
import {
  findReferences,
  getMutationTimeline,
  hasTimelineStartBefore,
  resolveBindingAt,
  someTimelineEndAtOrBefore,
  toMutationBindingKey,
  unknownAliasMutationBinding,
} from './scopeAnalysis';
import {
  allocateHoistedBindingName,
  countPatternBindingNames,
  expressionSpanKey,
  hasAnyBindingChange,
  hasDestructuringIntrinsicMutationBefore,
  isOpaqueDestructuringHazard,
} from './snapshotReplay';
import { isKnownPureStaticCall } from './staticEvaluator';
import type {
  Binding,
  ExtractionContext,
  OxcStaticImportReference,
  Replacement,
  StaticLocalExpression,
} from './types';

export const allocateExpressionName = (ctx: ExtractionContext): string => {
  let base = '_exp';
  let idx = 1;
  while (ctx.usedNames.has(base)) {
    idx += 1;
    base = `_exp${idx}`;
  }

  ctx.usedNames.add(base);
  return base;
};

export const getHoistedBindingName = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const key = toOxcBindingIdentity(binding);
  const existing = ctx.hoistedBindingNames.get(key);
  if (existing) {
    return existing;
  }

  const next = allocateHoistedBindingName(binding.name, ctx);
  ctx.hoistedBindingNames.set(key, next);
  return next;
};

const parenthesizeStaticReplacement = (source: string): string => `(${source})`;

export const replaceStaticLocalReferences = (
  expression: Expression,
  replacements: ReadonlyMap<string, string>,
  ctx: ExtractionContext,
  extraReplacements: Replacement[] = [],
  exactReplacements: ReadonlyMap<number, string> = new Map()
): string => {
  if (expression.type === 'Identifier' && extraReplacements.length === 0) {
    return (
      exactReplacements.get(expression.start) ??
      replacements.get(expression.name) ??
      ctx.code.slice(expression.start, expression.end)
    );
  }

  const parenthesized = new Map<string, string>();
  const parenthesizedExact = new Map<number, string>();
  replacements.forEach((value, key) => {
    parenthesized.set(key, parenthesizeStaticReplacement(value));
  });
  exactReplacements.forEach((value, key) => {
    parenthesizedExact.set(key, parenthesizeStaticReplacement(value));
  });

  return applyExpressionReplacements(
    expression,
    [
      ...extraReplacements,
      ...collectIdentifierReferenceReplacements(
        expression,
        parenthesized,
        parenthesizedExact
      ),
    ],
    ctx.code
  );
};

export const hasReferencedRootMutationBefore = (
  expression: Expression,
  referenceStart: number,
  ctx: ExtractionContext,
  ignoredReferences: ReadonlySet<string> = new Set(),
  ignoredHazard?: Node
): boolean =>
  findReferences(expression, ctx.referencesByNode).some(({ name, start }) => {
    if (ignoredReferences.has(name)) {
      return false;
    }

    const dependency = resolveBindingAt(ctx, name, start);
    if (!dependency) {
      return false;
    }
    const dependencyKey = toMutationBindingKey(dependency);

    return (
      hasTimelineStartBefore(
        getMutationTimeline(ctx.rootMutationsByBinding, dependencyKey),
        referenceStart
      ) ||
      someTimelineEndAtOrBefore(
        getMutationTimeline(ctx.rootMutationHazardsByBinding, dependencyKey),
        referenceStart,
        (hazard) =>
          !isKnownPureStaticCall(hazard, ctx) &&
          (!ignoredHazard ||
            hazard.start < ignoredHazard.start ||
            ignoredHazard.end < hazard.end)
      )
    );
  });

export const hasBindingMutationBefore = (
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext
): boolean => {
  const bindingKey = toMutationBindingKey(binding);
  return (
    hasTimelineStartBefore(
      getMutationTimeline(ctx.rootMutationsByBinding, bindingKey),
      referenceStart
    ) ||
    someTimelineEndAtOrBefore(
      getMutationTimeline(ctx.rootMutationHazardsByBinding, bindingKey),
      referenceStart,
      (hazard) => !isKnownPureStaticCall(hazard, ctx)
    )
  );
};

export const hasOpaqueDestructuringHazardBefore = (
  bindingKey: string,
  referenceStart: number,
  ctx: ExtractionContext
): boolean =>
  someTimelineEndAtOrBefore(
    getMutationTimeline(ctx.rootMutationHazardsByBinding, bindingKey),
    referenceStart,
    (hazard) => isOpaqueDestructuringHazard(hazard, ctx)
  );

const hasFunctionContextSyntax = (node: Node): boolean =>
  node.type === 'ThisExpression' ||
  node.type === 'Super' ||
  node.type === 'AwaitExpression' ||
  node.type === 'YieldExpression' ||
  node.type === 'MetaProperty' ||
  getOxcNodeChildren(node).some(hasFunctionContextSyntax);

export const nestedDestructuringHasCallTimeUncertainty = (
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  const { declarator } = binding;
  if (
    binding.isRoot ||
    !declarator?.init ||
    (declarator.id.type !== 'ObjectPattern' &&
      declarator.id.type !== 'ArrayPattern')
  ) {
    return false;
  }

  let functionScope = binding.scope.parent;
  while (functionScope && !functionScope.functionBoundary) {
    functionScope = functionScope.parent;
  }
  if (!functionScope) {
    return false;
  }

  if (
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      Number.POSITIVE_INFINITY,
      ctx
    )
  ) {
    return true;
  }

  const visitedBindings = new Map<Binding, Set<number>>();
  const bindingHasUncertainty = (
    candidate: Binding,
    evaluatedAt: number
  ): boolean => {
    const visitedAt = visitedBindings.get(candidate) ?? new Set<number>();
    if (visitedAt.has(evaluatedAt)) {
      return false;
    }
    visitedAt.add(evaluatedAt);
    visitedBindings.set(candidate, visitedAt);

    if (
      candidate.kind === 'param' ||
      hasBindingMutationBefore(candidate, evaluatedAt, ctx)
    ) {
      return true;
    }

    const candidateDeclarator = candidate.declarator;
    if (!candidateDeclarator) {
      return true;
    }
    if (
      evaluatedAt < candidateDeclarator.end ||
      (candidateDeclarator !== declarator &&
        candidateDeclarator.id.type !== 'Identifier')
    ) {
      return true;
    }

    const candidateExpressions = candidateDeclarator?.init
      ? [
          candidateDeclarator.init,
          ...collectOxcPatternRuntimeExpressions(candidateDeclarator.id),
        ]
      : [];

    return candidateExpressions.some((expression) => {
      if (hasFunctionContextSyntax(expression)) {
        return true;
      }

      return findReferences(expression, ctx.referencesByNode).some(
        ({ name, start }) => {
          const dependency = resolveBindingAt(ctx, name, start);
          if (!dependency) {
            return !(
              name === 'undefined' ||
              name === 'NaN' ||
              name === 'Infinity'
            );
          }

          if (dependency.declarator === candidateDeclarator) {
            return false;
          }

          const declaredInsideFunction =
            functionScope.start <= dependency.declaredAt &&
            dependency.declaredAt < functionScope.end;
          if (declaredInsideFunction) {
            return bindingHasUncertainty(dependency, candidateDeclarator.start);
          }

          return (
            hasAnyBindingChange(dependency, ctx) ||
            (!!dependency.declaration &&
              dependency.declaration.end > ctx.currentInsertionPoint)
          );
        }
      );
    });
  };

  if (
    collectOxcPatternRuntimeExpressions(declarator.id).some(
      hasFunctionContextSyntax
    )
  ) {
    return true;
  }

  return bindingHasUncertainty(binding, ctx.currentExpressionStart);
};

export const expressionHasNestedCallTimeUncertainty = (
  expression: Expression,
  ctx: ExtractionContext
): boolean =>
  findReferences(expression, ctx.referencesByNode).some(({ name, start }) => {
    const binding = resolveBindingAt(ctx, name, start);
    return !!binding && nestedDestructuringHasCallTimeUncertainty(binding, ctx);
  });

function collectStaticLocalExpression(
  expression: Expression,
  ctx: ExtractionContext,
  stack: string[] = [],
  ignoredReferences: ReadonlySet<string> = new Set()
): StaticLocalExpression | null {
  const exactReplacements = new Map<number, string>();
  const importedFrom = new Set<string>();
  const imports: OxcStaticImportReference[] = [];

  for (const { name, start } of findReferences(
    expression,
    ctx.referencesByNode
  )) {
    if (ignoredReferences.has(name)) {
      continue;
    }

    const binding = resolveBindingAt(ctx, name, start);
    if (!binding) {
      return null;
    }

    if (binding.importedFrom) {
      importedFrom.add(binding.importedFrom);
      if (binding.imported && binding.imported !== '*') {
        imports.push({
          imported: binding.imported,
          local: binding.name,
          source: binding.importedFrom,
        });
        continue;
      }

      return null;
    }

    const replacement =
      binding.declarationKind === 'const'
        ? getConstantReplacement(binding, ctx)
        : null;
    if (replacement) {
      exactReplacements.set(start, replacement);
      continue;
    }

    // Processor-managed bindings (const x = css``) carry their value
    // (the generated className string) via inlineConstants at candidate
    // evaluation time. Walking the TaggedTemplateExpression here would
    // pull the processor's tag import (e.g. `css` from '@linaria/core')
    // into the candidate's static imports, where it fails to resolve.
    // Leave the identifier as a free reference; the candidate-side env
    // supplies the className.
    if (binding.declarator?.init?.type === 'TaggedTemplateExpression') {
      continue;
    }

    const nested = collectStaticBindingExpression(binding, start, ctx, stack);
    if (!nested) {
      return null;
    }

    exactReplacements.set(start, nested.source);
    nested.importedFrom.forEach((source) => importedFrom.add(source));
    imports.push(...nested.imports);
  }

  return {
    importedFrom: [...importedFrom],
    imports,
    source:
      exactReplacements.size > 0
        ? replaceStaticLocalReferences(
            expression,
            new Map(),
            ctx,
            [],
            exactReplacements
          )
        : ctx.code.slice(expression.start, expression.end),
  };
}

function collectStaticDestructuringProjection(
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext,
  stack: string[]
): StaticLocalExpression | null {
  const { declarator } = binding;
  if (
    !declarator?.init ||
    (declarator.id.type !== 'ObjectPattern' &&
      declarator.id.type !== 'ArrayPattern')
  ) {
    return null;
  }

  if (
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      declarator.start,
      ctx
    )
  ) {
    return null;
  }

  if (
    hasOpaqueDestructuringHazardBefore(
      unknownAliasMutationBinding,
      referenceStart,
      ctx
    )
  ) {
    return null;
  }

  const bindingNames = countPatternBindingNames(declarator.id);
  if (bindingNames.get(binding.name) !== 1) {
    return null;
  }

  const bindingKey = toMutationBindingKey(binding);
  const targetMutations = getMutationTimeline(
    ctx.rootMutationsByBinding,
    bindingKey
  );
  const targetMutationHazards = getMutationTimeline(
    ctx.rootMutationHazardsByBinding,
    bindingKey
  );
  if (
    hasTimelineStartBefore(targetMutations, referenceStart) ||
    someTimelineEndAtOrBefore(targetMutationHazards, referenceStart, (hazard) =>
      isOpaqueDestructuringHazard(hazard, ctx)
    )
  ) {
    return null;
  }

  const snapshotCtx: ExtractionContext = {
    ...ctx,
    currentExpressionStart: declarator.start,
  };
  const initializerReferences = findReferences(
    declarator.init,
    ctx.referencesByNode
  );
  if (
    initializerReferences.some(({ name, start }) => {
      const dependency = resolveBindingAt(ctx, name, start);
      return (
        dependency?.declarator === declarator ||
        (!!dependency &&
          hasOpaqueDestructuringHazardBefore(
            toMutationBindingKey(dependency),
            declarator.start,
            ctx
          ))
      );
    })
  ) {
    return null;
  }
  const initializer = collectStaticLocalExpression(
    declarator.init,
    snapshotCtx,
    stack
  );
  if (!initializer) {
    return null;
  }

  const importedFrom = new Set(initializer.importedFrom);
  const imports = [...initializer.imports];
  const patternReplacements: Replacement[] = [];
  const localBindingNames = new Set(bindingNames.keys());
  for (const expression of collectOxcPatternRuntimeExpressions(declarator.id)) {
    if (
      hasReferencedRootMutationBefore(
        expression,
        referenceStart,
        ctx,
        localBindingNames
      )
    ) {
      return null;
    }

    const resolved = collectStaticLocalExpression(
      expression,
      snapshotCtx,
      stack,
      localBindingNames
    );
    if (!resolved) {
      return null;
    }

    resolved.importedFrom.forEach((source) => importedFrom.add(source));
    imports.push(...resolved.imports);
    patternReplacements.push({
      end: expression.end,
      start: expression.start,
      value: parenthesizeStaticReplacement(resolved.source),
    });
  }

  const patternSource = applyExpressionReplacements(
    declarator.id,
    patternReplacements,
    ctx.code
  );

  return {
    importedFrom: [...importedFrom],
    imports,
    source: `((${patternSource}) => ${binding.name})((${initializer.source}))`,
  };
}

export function collectStaticBindingExpression(
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext,
  stack: string[] = []
): StaticLocalExpression | null {
  const { declarator } = binding;
  if (
    binding.kind === 'param' ||
    binding.declarationKind !== 'const' ||
    !declarator?.init ||
    referenceStart < declarator.end
  ) {
    return null;
  }

  if (
    binding.isRoot &&
    hasOpaqueDestructuringHazardBefore(
      toMutationBindingKey(binding),
      referenceStart,
      ctx
    )
  ) {
    return null;
  }

  if (nestedDestructuringHasCallTimeUncertainty(binding, ctx)) {
    return null;
  }

  const key = toOxcBindingIdentity(binding);
  if (stack.includes(key)) {
    return null;
  }

  const nextStack = [...stack, key];
  if (
    hasReferencedRootMutationBefore(
      declarator.init,
      referenceStart,
      ctx,
      new Set(countPatternBindingNames(declarator.id).keys()),
      declarator
    )
  ) {
    return null;
  }

  if (declarator.id.type === 'Identifier') {
    return collectStaticLocalExpression(declarator.init, ctx, nextStack);
  }

  return collectStaticDestructuringProjection(
    binding,
    referenceStart,
    ctx,
    nextStack
  );
}

export const containsProcessorManagedExpression = (
  node: Expression,
  ctx: ExtractionContext
): boolean =>
  ctx.processorManagedExpressionSpans.has(expressionSpanKey(node)) ||
  getOxcNodeChildren(node).some((child) =>
    containsProcessorManagedExpression(child as Expression, ctx)
  );

export const declarationInitCode = (
  init: Expression,
  ctx: ExtractionContext
): string => {
  const renamedDependencies = new Map<number, string>();
  findReferences(init, ctx.referencesByNode).forEach(({ name, start }) => {
    const dependency = resolveBindingAt(ctx, name, start);
    if (
      !dependency ||
      dependency.importedFrom ||
      dependency.isRoot ||
      dependency.declarator?.id.type !== 'Identifier'
    ) {
      return;
    }

    renamedDependencies.set(start, getHoistedBindingName(dependency, ctx));
  });

  return renamedDependencies.size > 0
    ? replaceIdentifierReferences(
        init,
        new Map(),
        ctx.code,
        renamedDependencies
      )
    : ctx.code.slice(init.start, init.end);
};

export const declarationPatternCode = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const { declarator } = binding;
  if (
    !declarator ||
    (declarator.id.type !== 'ObjectPattern' &&
      declarator.id.type !== 'ArrayPattern')
  ) {
    return declarator
      ? ctx.code.slice(declarator.id.start, declarator.id.end)
      : '';
  }

  const replacements: Replacement[] = [];
  collectOxcPatternBindingIdentifiers(declarator.id).forEach((identifier) => {
    const patternBinding = ctx.bindingIndex.bindingsByName
      .get(identifier.name)
      ?.find((candidate) => candidate.declarator === declarator);
    if (!patternBinding) {
      return;
    }

    replacements.push({
      end: identifier.end,
      start: identifier.start,
      value: getHoistedBindingName(patternBinding, ctx),
    });
  });

  collectOxcPatternRuntimeExpressions(declarator.id).forEach((expression) => {
    findReferences(expression, ctx.referencesByNode).forEach(
      ({ end, name, start }) => {
        const dependency = resolveBindingAt(ctx, name, start);
        if (
          !dependency ||
          dependency.importedFrom ||
          dependency.isRoot ||
          (dependency.declarator !== declarator &&
            dependency.declarator?.id.type !== 'Identifier')
        ) {
          return;
        }

        replacements.push({
          end,
          start,
          value: getHoistedBindingName(dependency, ctx),
        });
      }
    );
  });

  const shorthandProperties = collectOxcPatternShorthandProperties(
    declarator.id
  );
  const isInsideShorthand = (
    replacement: Replacement,
    property: (typeof shorthandProperties)[number]
  ): boolean =>
    property.start <= replacement.start && replacement.end <= property.end;
  const shorthandReplacements = shorthandProperties.map((property) => {
    const valueReplacements = replacements.filter((replacement) =>
      isInsideShorthand(replacement, property)
    );
    const valueCode =
      valueReplacements.length > 0
        ? applyExpressionReplacements(
            property.value,
            valueReplacements,
            ctx.code
          )
        : ctx.code.slice(property.value.start, property.value.end);
    const keyCode = ctx.code.slice(property.key.start, property.key.end);
    return {
      end: property.end,
      start: property.start,
      value: `${keyCode}: ${valueCode}`,
    };
  });
  const directReplacements = replacements.filter(
    (replacement) =>
      !shorthandProperties.some((property) =>
        isInsideShorthand(replacement, property)
      )
  );
  const allReplacements = [...directReplacements, ...shorthandReplacements];

  return allReplacements.length > 0
    ? applyExpressionReplacements(declarator.id, allReplacements, ctx.code)
    : ctx.code.slice(declarator.id.start, declarator.id.end);
};
