/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { ExpressionValue } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type { Expression, Node, Program } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import {
  collectOxcPatternBindingIdentifiers,
  collectOxcPatternBindingNames,
  collectOxcPatternRuntimeExpressions,
  collectOxcPatternShorthandProperties,
} from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import { applyOxcReplacements } from '../oxc/replacements';
import { createOxcLocationLookup } from '../oxc/sourceLocations';
import {
  analyzeProgram,
  containsTaggedTemplateExpression,
  createSpanLookup,
  findReferences,
  getRootMutationHazards,
  getSourceLocation,
  isBindingDeclaredWithin,
  parseOxc,
  resolveBindingAt,
  toMutationBindingKey,
  unknownAliasMutationBinding,
} from './scopeAnalysis';
import {
  applyExpressionReplacements,
  collectEagerIdentifierMutationTargets,
  collectEagerNodeStarts,
  collectIdentifierMutationTargets,
  collectIdentifierReferenceReplacements,
  collectStaticNamespaceMemberReferences,
  getConstantReplacement,
  replaceIdentifierReferences,
} from './expressionReplacements';
import { evaluateStatic, isKnownPureStaticCall } from './staticEvaluator';
import {
  cloneStaticValue,
  isStaticSerializableValue,
  literalCode,
} from './staticValues';
import { toOxcBindingIdentity } from './bindingIdentity';
import { inferSnapshotExpressionKind } from './snapshotValueAnalysis';
import type {
  Binding,
  ExtractedExpression,
  ExpressionSpan,
  ExtractionContext,
  OxcStaticImportReference,
  ProgramAnalysis,
  Replacement,
  StaticBindings,
  StaticLocalExpression,
  TemplateExtractionResult,
} from './types';

const allocateExpressionName = (ctx: ExtractionContext): string => {
  let base = '_exp';
  let idx = 1;
  while (ctx.usedNames.has(base)) {
    idx += 1;
    base = `_exp${idx}`;
  }

  ctx.usedNames.add(base);
  return base;
};

const allocateHoistedBindingName = (
  originalName: string,
  ctx: ExtractionContext
): string => {
  const sanitized = originalName.replace(/[^A-Za-z0-9_$]/g, '_') || 'hoisted';
  const base = /^[A-Za-z_$]/.test(sanitized) ? `_${sanitized}` : '_hoisted';
  let candidate = base;
  let idx = 2;

  while (ctx.usedNames.has(candidate)) {
    candidate = `${base}${idx}`;
    idx += 1;
  }

  ctx.usedNames.add(candidate);
  return candidate;
};

const getHoistedBindingName = (
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

const replaceStaticLocalReferences = (
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

const countPatternBindingNames = (pattern: Node): Map<string, number> =>
  collectOxcPatternBindingNames(pattern).reduce((names, name) => {
    names.set(name, (names.get(name) ?? 0) + 1);
    return names;
  }, new Map<string, number>());

const hasReferencedRootMutationBefore = (
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
      (ctx.rootMutationsByBinding.get(dependencyKey) ?? []).some(
        (mutation) => mutation.start < referenceStart
      ) ||
      getRootMutationHazards(
        ctx.rootMutationHazardsByBinding,
        dependencyKey
      ).some(
        (hazard) =>
          !isKnownPureStaticCall(hazard, ctx) &&
          (!ignoredHazard ||
            hazard.start < ignoredHazard.start ||
            ignoredHazard.end < hazard.end) &&
          hazard.end <= referenceStart
      )
    );
  });

const hasBindingMutationBefore = (
  binding: Binding,
  referenceStart: number,
  ctx: ExtractionContext
): boolean => {
  const bindingKey = toMutationBindingKey(binding);
  return (
    (ctx.rootMutationsByBinding.get(bindingKey) ?? []).some(
      (mutation) => mutation.start < referenceStart
    ) ||
    getRootMutationHazards(ctx.rootMutationHazardsByBinding, bindingKey).some(
      (hazard) =>
        !isKnownPureStaticCall(hazard, ctx) && hazard.end <= referenceStart
    )
  );
};

const hasDestructuringIntrinsicMutationBefore = (
  pattern: Node,
  referenceStart: number,
  ctx: ExtractionContext
): boolean => {
  const intrinsicNames =
    pattern.type === 'ArrayPattern' ? ['Array', 'Object'] : ['Object', 'Array'];

  return intrinsicNames.some((name) => {
    const changesUnshadowedIntrinsic = (change: Node): boolean =>
      !resolveBindingAt(ctx, name, change.start);

    return (
      (ctx.rootMutationsByBinding.get(name) ?? []).some(
        (mutation) =>
          mutation.start < referenceStart &&
          changesUnshadowedIntrinsic(mutation)
      ) ||
      getRootMutationHazards(ctx.rootMutationHazardsByBinding, name).some(
        (hazard) =>
          hazard.end <= referenceStart && changesUnshadowedIntrinsic(hazard)
      )
    );
  });
};

const isOpaqueDestructuringHazard = (
  hazard: Node,
  ctx: ExtractionContext
): boolean => {
  if (hazard.type === 'TaggedTemplateExpression') {
    return !ctx.processorManagedExpressionSpans.has(expressionSpanKey(hazard));
  }

  return !isKnownPureStaticCall(hazard, ctx);
};

const hasOpaqueDestructuringHazardBefore = (
  bindingKey: string,
  referenceStart: number,
  ctx: ExtractionContext
): boolean =>
  getRootMutationHazards(ctx.rootMutationHazardsByBinding, bindingKey).some(
    (hazard) =>
      isOpaqueDestructuringHazard(hazard, ctx) && hazard.end <= referenceStart
  );

const hasAnyBindingChange = (
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  const bindingKey = toMutationBindingKey(binding);
  return (
    (ctx.rootMutationsByBinding.get(bindingKey)?.length ?? 0) > 0 ||
    getRootMutationHazards(ctx.rootMutationHazardsByBinding, bindingKey).some(
      (hazard) => isOpaqueDestructuringHazard(hazard, ctx)
    )
  );
};

const hasFunctionContextSyntax = (node: Node): boolean =>
  node.type === 'ThisExpression' ||
  node.type === 'Super' ||
  node.type === 'AwaitExpression' ||
  node.type === 'YieldExpression' ||
  node.type === 'MetaProperty' ||
  getOxcNodeChildren(node).some(hasFunctionContextSyntax);

const nestedDestructuringHasCallTimeUncertainty = (
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

const expressionHasNestedCallTimeUncertainty = (
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
  const targetMutations = ctx.rootMutationsByBinding.get(bindingKey) ?? [];
  const targetMutationHazards = getRootMutationHazards(
    ctx.rootMutationHazardsByBinding,
    bindingKey
  );
  if (
    targetMutations.some((mutation) => mutation.start < referenceStart) ||
    targetMutationHazards.some(
      (hazard) =>
        isOpaqueDestructuringHazard(hazard, ctx) && hazard.end <= referenceStart
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

function collectStaticBindingExpression(
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

const expressionSpanKey = (
  node: Pick<ExpressionSpan, 'end' | 'start'>
): string => `${node.start}:${node.end}`;

const containsProcessorManagedExpression = (
  node: Expression,
  ctx: ExtractionContext
): boolean =>
  ctx.processorManagedExpressionSpans.has(expressionSpanKey(node)) ||
  getOxcNodeChildren(node).some((child) =>
    containsProcessorManagedExpression(child as Expression, ctx)
  );

const declarationInitCode = (
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

const declarationPatternCode = (
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
    const patternBinding = ctx.bindingsByName
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

const addHoistedCode = (
  key: string,
  code: string,
  ctx: ExtractionContext
): void => {
  if (ctx.hoistedDeclarations.has(key)) {
    return;
  }

  ctx.hoistedDeclarations.set(key, code);
  const declarations =
    ctx.hoistedDeclarationsByInsertionPoint.get(ctx.currentInsertionPoint) ??
    [];
  declarations.push(code);
  ctx.hoistedDeclarationsByInsertionPoint.set(
    ctx.currentInsertionPoint,
    declarations
  );
};

const declarationCode = (binding: Binding, ctx: ExtractionContext): string => {
  const { declarator } = binding;
  if (!declarator) {
    return '';
  }

  const { id } = declarator;
  if (id.type !== 'Identifier') {
    const idCode = declarationPatternCode(binding, ctx);
    if (!declarator.init) {
      return `let ${idCode};`;
    }

    return `let ${idCode} = ${declarationInitCode(declarator.init, ctx)};`;
  }

  const hoistedName = getHoistedBindingName(binding, ctx);
  if (!declarator.init) {
    return `let ${hoistedName};`;
  }

  return `let ${hoistedName} = ${declarationInitCode(declarator.init, ctx)};`;
};

const dependsOnLocalDestructuring = (
  binding: Binding,
  ctx: ExtractionContext,
  visited = new Set<string>()
): boolean => {
  const { declarator } = binding;
  if (!declarator || binding.importedFrom || binding.isRoot) {
    return false;
  }

  const bindingKey = toOxcBindingIdentity(binding);
  if (visited.has(bindingKey)) {
    return false;
  }
  visited.add(bindingKey);

  if (
    declarator.id.type === 'ObjectPattern' ||
    declarator.id.type === 'ArrayPattern'
  ) {
    return true;
  }

  if (!declarator.init) {
    return false;
  }

  return findReferences(declarator.init, ctx.referencesByNode).some(
    ({ name, start }) => {
      const dependency = resolveBindingAt(ctx, name, start);
      return (
        !!dependency &&
        dependency.declarator !== declarator &&
        dependsOnLocalDestructuring(dependency, ctx, visited)
      );
    }
  );
};

const requiresSnapshotReplay = (
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  const { declarator } = binding;
  if (!declarator || binding.importedFrom || binding.isRoot) {
    return false;
  }

  // A destructuring declaration can execute user code or throw even when its
  // initializer looks static (nullish object patterns, custom iterators,
  // getters, defaults, and computed keys). Keep it, and aliases derived from
  // it, dormant until the original local expression is reached.
  if (dependsOnLocalDestructuring(binding, ctx)) {
    return true;
  }

  if (nestedDestructuringHasCallTimeUncertainty(binding, ctx)) {
    return true;
  }

  const bindingKey = toMutationBindingKey(binding);
  if (
    (ctx.rootMutationsByBinding.get(bindingKey) ?? []).some(
      (mutation) => mutation.start < ctx.currentExpressionStart
    ) ||
    hasOpaqueDestructuringHazardBefore(
      bindingKey,
      ctx.currentExpressionStart,
      ctx
    )
  ) {
    return true;
  }

  if (!declarator.init) {
    return false;
  }

  const localBindingNames = new Set(
    countPatternBindingNames(declarator.id).keys()
  );
  if (
    hasReferencedRootMutationBefore(
      declarator.init,
      ctx.currentExpressionStart,
      ctx,
      localBindingNames,
      declarator
    )
  ) {
    return true;
  }

  if (
    declarator.id.type !== 'ObjectPattern' &&
    declarator.id.type !== 'ArrayPattern'
  ) {
    return false;
  }

  return (
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      declarator.start,
      ctx
    ) ||
    hasOpaqueDestructuringHazardBefore(
      unknownAliasMutationBinding,
      ctx.currentExpressionStart,
      ctx
    ) ||
    findReferences(declarator.init, ctx.referencesByNode).some(
      ({ name, start }) => {
        const dependency = resolveBindingAt(ctx, name, start);
        return (
          !!dependency &&
          hasOpaqueDestructuringHazardBefore(
            toMutationBindingKey(dependency),
            declarator.start,
            ctx
          )
        );
      }
    )
  );
};

type OxcBlockStatement = Extract<Node, { type: 'BlockStatement' }>;

const snapshotReplayError = (): Error =>
  new Error(
    `This identifier cannot be used in the template, because its local snapshot depends on executed side effects that cannot be safely hoisted.`
  );

export class OxcSnapshotWriteUnsupportedError extends Error {
  constructor() {
    super(
      `This identifier cannot be used in the template, because its local snapshot depends on executed side effects that cannot be safely hoisted.`
    );
    this.name = 'OxcSnapshotWriteUnsupportedError';
  }
}

const isFunctionBoundaryNode = isOxcFunctionLike;

const findSnapshotBody = (
  node: Node,
  binding: Binding
): OxcBlockStatement | null => {
  if (
    node.type === 'BlockStatement' &&
    node.start === binding.scope.start &&
    node.end === binding.scope.end
  ) {
    return node;
  }

  for (const child of getOxcNodeChildren(node)) {
    if (child.start <= binding.scope.start && binding.scope.end <= child.end) {
      const result = findSnapshotBody(child, binding);
      if (result) {
        return result;
      }
    }
  }

  return null;
};

const directSnapshotOwner = (
  body: OxcBlockStatement,
  node: Node
): Node | null =>
  body.body.find(
    (statement) => statement.start <= node.start && node.end <= statement.end
  ) ?? null;

const findSnapshotReplayBoundary = (
  node: Node,
  position: number,
  ctx: ExtractionContext
): Node | null => {
  if (position < node.start || node.end <= position) {
    return null;
  }

  for (const child of getOxcNodeChildren(node)) {
    const boundary = findSnapshotReplayBoundary(child, position, ctx);
    if (boundary) {
      return boundary;
    }
  }

  return node.type === 'TaggedTemplateExpression' ||
    (node.type === 'CallExpression' &&
      ctx.processorManagedExpressionSpans.has(expressionSpanKey(node)))
    ? node
    : null;
};

const snapshotReplayKey = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const boundary = findSnapshotReplayBoundary(
    ctx.program,
    ctx.currentExpressionStart,
    ctx
  );
  return `\0wyw-static-snapshot:${binding.scope.start}:${binding.scope.end}:${
    boundary
      ? `${boundary.start}:${boundary.end}`
      : `expression:${ctx.currentExpressionStart}`
  }`;
};

const crossesDeferredFunctionBoundary = (
  owner: Node,
  target: Node
): boolean => {
  const visit = (node: Node, crossed: boolean): boolean | null => {
    if (node === target) {
      return crossed;
    }

    for (const child of getOxcNodeChildren(node)) {
      if (child.start <= target.start && target.end <= child.end) {
        const result = visit(
          child,
          crossed || (child !== target && isFunctionBoundaryNode(child))
        );
        if (result !== null) {
          return result;
        }
      }
    }

    return null;
  };

  return visit(owner, false) ?? true;
};

const collectMutationTargetRoots = (node: Node, roots: Node[] = []): Node[] => {
  if (node.type === 'Identifier') {
    roots.push(node);
    return roots;
  }

  if (node.type === 'MemberExpression') {
    return collectMutationTargetRoots(node.object, roots);
  }

  if (node.type === 'AssignmentPattern') {
    return collectMutationTargetRoots(node.left, roots);
  }

  if (node.type === 'RestElement') {
    return collectMutationTargetRoots(node.argument, roots);
  }

  if (node.type === 'ObjectPattern') {
    node.properties.forEach((property) => {
      collectMutationTargetRoots(
        property.type === 'RestElement' ? property.argument : property.value,
        roots
      );
    });
    return roots;
  }

  if (node.type === 'ArrayPattern') {
    node.elements.forEach((element) => {
      if (element) {
        collectMutationTargetRoots(element, roots);
      }
    });
  }

  return roots;
};

const callReferenceRoot = (node: Node): Node | null => {
  let current = node;
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'ChainExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSInstantiationExpression'
  ) {
    const { expression } = current as Node & { expression?: Node };
    if (!expression) {
      return null;
    }
    current = expression;
  }

  if (current.type === 'Identifier') {
    return current;
  }

  if (current.type === 'MemberExpression') {
    return callReferenceRoot(current.object);
  }

  return current;
};

const collectSnapshotStatements = (
  binding: Binding,
  ctx: ExtractionContext
): Node[] => {
  const { declarator } = binding;
  const functionScope = binding.scope.parent;
  const body = findSnapshotBody(ctx.program, binding);
  if (
    !declarator ||
    !body ||
    !functionScope?.functionBoundary ||
    !functionScope.parent?.root
  ) {
    throw snapshotReplayError();
  }

  if (
    (declarator.id.type === 'ObjectPattern' ||
      declarator.id.type === 'ArrayPattern') &&
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      Number.POSITIVE_INFINITY,
      ctx
    )
  ) {
    throw snapshotReplayError();
  }

  const selectedStatements = new Set<Node>();
  const pendingStatements: Node[] = [];
  const relevantBindings = new Set<Binding>();
  const pendingBindings: Binding[] = [];
  const directClasses = new Map<string, Node>();
  body.body.forEach((statement) => {
    if (statement.type === 'ClassDeclaration' && statement.id) {
      directClasses.set(statement.id.name, statement);
    }
  });

  const includeStatement = (statement: Node): void => {
    if (
      selectedStatements.has(statement) ||
      statement.end > ctx.currentExpressionStart
    ) {
      return;
    }

    if (
      statement.type === 'VariableDeclaration' &&
      statement.declarations.length !== 1
    ) {
      throw snapshotReplayError();
    }

    selectedStatements.add(statement);
    pendingStatements.push(statement);
  };

  const declarationOwner = (candidate: Binding): Node | null => {
    const declaration = candidate.declaration ?? candidate.functionNode;
    return declaration ? directSnapshotOwner(body, declaration) : null;
  };

  const includeBinding = (candidate: Binding): void => {
    if (relevantBindings.has(candidate)) {
      return;
    }

    relevantBindings.add(candidate);
    pendingBindings.push(candidate);

    const directClass = directClasses.get(candidate.name);
    const owner =
      declarationOwner(candidate) ??
      (directClass?.start === candidate.declaredAt ? directClass : null);
    if (owner) {
      if (candidate.declaredAt >= ctx.currentExpressionStart) {
        throw snapshotReplayError();
      }
      includeStatement(owner);
    }
  };

  const targetOwner = directSnapshotOwner(
    body,
    binding.declaration ?? declarator
  );
  if (!targetOwner) {
    throw snapshotReplayError();
  }
  includeStatement(targetOwner);
  includeBinding(binding);

  while (pendingStatements.length > 0 || pendingBindings.length > 0) {
    while (pendingStatements.length > 0) {
      const statement = pendingStatements.shift()!;
      findReferences(statement, ctx.referencesByNode).forEach(
        ({ name, start }) => {
          const dependency = resolveBindingAt(ctx, name, start);
          if (dependency) {
            includeBinding(dependency);
            return;
          }

          const classDeclaration = directClasses.get(name);
          if (classDeclaration) {
            includeStatement(classDeclaration);
          }
        }
      );
    }

    while (pendingBindings.length > 0) {
      const dependency = pendingBindings.shift()!;
      const dependencyKey = toMutationBindingKey(dependency);
      const changes: Node[] = [
        ...(ctx.rootMutationsByBinding.get(dependencyKey) ?? []),
        ...getRootMutationHazards(
          ctx.rootMutationHazardsByBinding,
          dependencyKey
        ).filter((hazard) => isOpaqueDestructuringHazard(hazard, ctx)),
      ];

      changes.forEach((change) => {
        if (
          change.start < body.start ||
          change.end > ctx.currentExpressionStart
        ) {
          return;
        }

        const owner = directSnapshotOwner(body, change);
        if (owner && !crossesDeferredFunctionBoundary(owner, change)) {
          includeStatement(owner);
        }
      });
    }
  }

  const selected = [...selectedStatements].sort(
    (left, right) => left.start - right.start
  );
  const selectedClassNames = new Set(
    selected.flatMap((statement) =>
      statement.type === 'ClassDeclaration' && statement.id
        ? [statement.id.name]
        : []
    )
  );
  const isInternalBinding = (candidate: Binding): boolean =>
    selected.some(
      (statement) =>
        (statement.start <= candidate.declaredAt &&
          candidate.declaredAt < statement.end) ||
        (statement.start <= candidate.scope.start &&
          candidate.scope.end <= statement.end)
    );
  const assertInternalReference = (name: string, start: number): void => {
    if (selectedClassNames.has(name)) {
      return;
    }

    const dependency = resolveBindingAt(ctx, name, start);
    if (
      !dependency &&
      (name === 'undefined' || name === 'NaN' || name === 'Infinity')
    ) {
      return;
    }
    if (dependency && isInternalBinding(dependency)) {
      return;
    }

    if (dependency?.importedFrom && !hasAnyBindingChange(dependency, ctx)) {
      return;
    }

    if (
      dependency?.kind === 'variable' &&
      dependency.isRoot &&
      dependency.declarationKind === 'const' &&
      !!dependency.declaration &&
      dependency.declaration.end <= ctx.currentInsertionPoint &&
      (ctx.rootMutationsByBinding.get(toMutationBindingKey(dependency))
        ?.length ?? 0) === 0 &&
      getRootMutationHazards(
        ctx.rootMutationHazardsByBinding,
        toMutationBindingKey(dependency)
      ).every((hazard) => !isOpaqueDestructuringHazard(hazard, ctx))
    ) {
      return;
    }

    throw snapshotReplayError();
  };
  const assertInternalCall = (callee: Node): void => {
    const root = callReferenceRoot(callee);
    if (
      root?.type === 'FunctionExpression' ||
      root?.type === 'ArrowFunctionExpression'
    ) {
      if (root.async) {
        throw snapshotReplayError();
      }
      return;
    }

    if (!root || root.type !== 'Identifier') {
      throw snapshotReplayError();
    }

    if (selectedClassNames.has(root.name)) {
      return;
    }

    const dependency = resolveBindingAt(ctx, root.name, root.start);
    if (!dependency || !isInternalBinding(dependency)) {
      throw snapshotReplayError();
    }
  };
  const assertInternalMutation = (target: Node): void => {
    const roots = collectMutationTargetRoots(target);
    if (roots.length === 0) {
      throw snapshotReplayError();
    }

    roots.forEach((root) => {
      if (root.type !== 'Identifier') {
        throw snapshotReplayError();
      }
      if (selectedClassNames.has(root.name)) {
        return;
      }

      const dependency = resolveBindingAt(ctx, root.name, root.start);
      if (!dependency || !isInternalBinding(dependency)) {
        throw snapshotReplayError();
      }
    });
  };
  const validateNode = (node: Node): void => {
    if (
      node.type === 'ThisExpression' ||
      node.type === 'Super' ||
      node.type === 'AwaitExpression' ||
      node.type === 'YieldExpression' ||
      node.type === 'MetaProperty'
    ) {
      throw snapshotReplayError();
    }

    if (node.type === 'AssignmentExpression') {
      assertInternalMutation(node.left);
    } else if (node.type === 'UpdateExpression') {
      assertInternalMutation(node.argument);
    } else if (node.type === 'UnaryExpression' && node.operator === 'delete') {
      assertInternalMutation(node.argument);
    } else if (
      node.type === 'CallExpression' ||
      node.type === 'NewExpression'
    ) {
      assertInternalCall(node.callee);
    } else if (node.type === 'TaggedTemplateExpression') {
      assertInternalCall(node.tag);
    }

    getOxcNodeChildren(node).forEach(validateNode);
  };

  selected.forEach((statement) => {
    findReferences(statement, ctx.referencesByNode).forEach(
      ({ name, start }) => {
        if (name === 'arguments') {
          throw snapshotReplayError();
        }
        assertInternalReference(name, start);
      }
    );
    validateNode(statement);
  });

  return selected;
};

type SnapshotReplayGroup = {
  bindings: Set<Binding>;
  insertionPoint: number;
  name: string;
  statements: Set<Node>;
};

const snapshotReplayGroups = new WeakMap<
  ExtractionContext,
  Map<string, SnapshotReplayGroup>
>();

const snapshotReplayCode = (
  group: SnapshotReplayGroup,
  ctx: ExtractionContext
): string => {
  const bindingNames = [
    ...new Set(
      [...group.bindings].flatMap(({ declarator }) =>
        declarator ? [...countPatternBindingNames(declarator.id).keys()] : []
      )
    ),
  ];
  const statements = [...group.statements].sort(
    (left, right) => left.start - right.start
  );

  return `const ${
    group.name
  } = (() => {\nlet initialized = false;\nlet value;\nreturn () => {\nif (!initialized) {\nvalue = (() => {\n${statements
    .map((statement) => ctx.code.slice(statement.start, statement.end))
    .join('\n')}\nreturn { ${bindingNames.join(
    ', '
  )} };\n})();\ninitialized = true;\n}\nreturn value;\n};\n})();`;
};

const addHoistedSnapshotReplay = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const { declarator } = binding;
  if (!declarator) {
    throw snapshotReplayError();
  }

  const replayKey = snapshotReplayKey(binding, ctx);
  let groups = snapshotReplayGroups.get(ctx);
  if (!groups) {
    groups = new Map();
    snapshotReplayGroups.set(ctx, groups);
  }

  let group = groups.get(replayKey);
  if (!group) {
    group = {
      bindings: new Set(),
      insertionPoint: ctx.currentInsertionPoint,
      name: allocateHoistedBindingName('snapshot', ctx),
      statements: new Set(),
    };
    groups.set(replayKey, group);
    ctx.hoistedBindingNames.set(replayKey, group.name);
  }

  collectSnapshotStatements(binding, ctx).forEach((statement) =>
    group.statements.add(statement)
  );
  group.bindings.add(binding);

  const nextCode = snapshotReplayCode(group, ctx);
  const previousCode = ctx.hoistedDeclarations.get(replayKey);
  if (!previousCode) {
    addHoistedCode(replayKey, nextCode, ctx);
  } else if (previousCode !== nextCode) {
    const declarations = ctx.hoistedDeclarationsByInsertionPoint.get(
      group.insertionPoint
    );
    const declarationIndex = declarations?.indexOf(previousCode) ?? -1;
    if (!declarations || declarationIndex < 0) {
      throw snapshotReplayError();
    }
    declarations[declarationIndex] = nextCode;
    ctx.hoistedDeclarations.set(replayKey, nextCode);
  }

  return `${group.name}().${binding.name}`;
};

const assertHoistable = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  if (!binding.declarator?.init || binding.importedFrom || binding.isRoot) {
    return;
  }

  const bindingKey = toOxcBindingIdentity(binding);
  if (stack.includes(bindingKey)) {
    return;
  }

  const hoistSources = [
    binding.declarator.init,
    ...collectOxcPatternRuntimeExpressions(binding.declarator.id),
  ];
  hoistSources.forEach((source) => {
    findReferences(source, ctx.referencesByNode).forEach(({ name, start }) => {
      const nextBinding = resolveBindingAt(ctx, name, start);
      if (!nextBinding || nextBinding.declarator === binding.declarator) {
        return;
      }

      if (nextBinding.kind === 'param') {
        throw new Error(
          `This identifier cannot be used in the template, because it is a function parameter.`
        );
      }

      assertHoistable(nextBinding, ctx, [...stack, bindingKey]);
    });
  });
};

const addHoistedDeclaration = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  const bindingKey = toOxcBindingIdentity(binding);
  if (
    !binding.declaration ||
    !binding.declarator ||
    binding.importedFrom ||
    binding.isRoot ||
    stack.includes(bindingKey)
  ) {
    return;
  }

  const hoistSources = [
    ...(binding.declarator.init ? [binding.declarator.init] : []),
    ...collectOxcPatternRuntimeExpressions(binding.declarator.id),
  ];
  hoistSources.forEach((source) => {
    findReferences(source, ctx.referencesByNode).forEach(({ name, start }) => {
      const dependency = resolveBindingAt(ctx, name, start);
      if (dependency && dependency.declarator !== binding.declarator) {
        addHoistedDeclaration(dependency, ctx, [...stack, bindingKey]);
      }
    });
  });

  if (!ctx.hoistedDeclarations.has(bindingKey)) {
    addHoistedCode(bindingKey, declarationCode(binding, ctx), ctx);
  }
};

const literalExpressionValue = (
  expression: Expression,
  ctx: ExtractionContext
): Omit<ExpressionValue, 'buildCodeFrameError'> | null => {
  if (expression.type !== 'Literal') {
    return null;
  }

  if (
    expression.value !== null &&
    typeof expression.value !== 'string' &&
    typeof expression.value !== 'number' &&
    typeof expression.value !== 'boolean'
  ) {
    return null;
  }

  let type:
    | 'BooleanLiteral'
    | 'NullLiteral'
    | 'NumericLiteral'
    | 'StringLiteral';
  if (expression.value === null) {
    type = 'NullLiteral';
  } else if (typeof expression.value === 'string') {
    type = 'StringLiteral';
  } else if (typeof expression.value === 'number') {
    type = 'NumericLiteral';
  } else {
    type = 'BooleanLiteral';
  }

  const loc = getSourceLocation(expression.start, expression.end, ctx);
  const ex =
    expression.value === null
      ? { loc, type }
      : {
          loc,
          type,
          value: expression.value,
        };

  return {
    ex,
    kind: ValueType.CONST,
    source: ctx.code.slice(expression.start, expression.end),
    value: expression.value,
  } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>;
};

const extractExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  evaluate: boolean,
  snapshotWriteFallbackBindings: ReadonlySet<Binding>
): ExtractedExpression => {
  const source = ctx.code.slice(expression.start, expression.end);
  const expressionReferences = findReferences(expression, ctx.referencesByNode);
  const eagerNodeStarts = collectEagerNodeStarts(expression);
  const eagerMutationTargetStarts = new Set(
    collectEagerIdentifierMutationTargets(expression).map(
      (target) => target.start
    )
  );
  const snapshotMutationTargets = collectIdentifierMutationTargets(
    expression
  ).filter((target) => {
    const binding = resolveBindingAt(ctx, target.name, target.start);
    return !!binding && requiresSnapshotReplay(binding, ctx);
  });
  if (
    snapshotMutationTargets.some(
      (target) => !eagerMutationTargetStarts.has(target.start)
    )
  ) {
    throw snapshotReplayError();
  }
  if (
    expressionReferences.some(({ name, start }) => {
      if (eagerNodeStarts.has(start)) {
        return false;
      }

      const binding = resolveBindingAt(ctx, name, start);
      return !!binding && snapshotWriteFallbackBindings.has(binding);
    })
  ) {
    throw snapshotReplayError();
  }
  if (
    snapshotMutationTargets.some((target) => {
      const binding = resolveBindingAt(ctx, target.name, target.start);
      return !!binding && !snapshotWriteFallbackBindings.has(binding);
    })
  ) {
    throw new OxcSnapshotWriteUnsupportedError();
  }

  const snapshotBindings = expressionReferences.flatMap(({ name, start }) => {
    const binding = resolveBindingAt(ctx, name, start);
    return binding &&
      requiresSnapshotReplay(binding, ctx) &&
      !snapshotWriteFallbackBindings.has(binding)
      ? [binding]
      : [];
  });
  if (snapshotBindings.length > 0) {
    const snapshotKind = inferSnapshotExpressionKind(expression, ctx);
    if (snapshotKind === 'identity' || snapshotKind === 'unknown') {
      throw snapshotReplayError();
    }
  }

  const identityReferencesAreRootVisible =
    expressionReferences.length > 0 &&
    expressionReferences.every(({ name, start }) => {
      const binding = resolveBindingAt(ctx, name, start);
      return !binding || !!binding.importedFrom || binding.isRoot;
    });
  let preserveRuntimeIdentity = false;
  let preservedStaticValue: unknown;
  // Only inline function expressions are function-valued here. A bare
  // identifier that points to a local function may be a styled runtime
  // component, so it has to stay as a lazy `_exp()` reference.
  const isFunction =
    expression.type === 'FunctionExpression' ||
    expression.type === 'ArrowFunctionExpression';

  if (evaluate && !expressionHasNestedCallTimeUncertainty(expression, ctx)) {
    const evaluated = evaluateStatic(expression, ctx);
    const literal = literalCode(evaluated);
    preserveRuntimeIdentity =
      evaluated !== null &&
      ((typeof evaluated === 'object' && evaluated !== null) ||
        typeof evaluated === 'function') &&
      identityReferencesAreRootVisible;
    if (preserveRuntimeIdentity && isStaticSerializableValue(evaluated)) {
      preservedStaticValue = cloneStaticValue(evaluated);
    }
    if (literal && !preserveRuntimeIdentity) {
      expressionReferences.forEach(({ name }) => ctx.dependencyNames.add(name));
      return {
        expressionCode: literal,
        importedFrom: [],
        kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
        staticImports: [],
        staticValue: isStaticSerializableValue(evaluated)
          ? cloneStaticValue(evaluated)
          : undefined,
      };
    }
  }

  const identifierReplacements = new Map<number, string>();
  const importedFrom: string[] = [];
  const namespaceStatic = collectStaticNamespaceMemberReferences(
    expression,
    ctx
  );
  const staticIdentifierReplacements = new Map<number, string>();
  const staticImports: OxcStaticImportReference[] = [
    ...namespaceStatic.imports,
  ];
  let hasNonStaticLocalReference = preserveRuntimeIdentity;
  let hasInlinableLocalReference = false;
  let hasSnapshotReplay = preserveRuntimeIdentity;

  expressionReferences.forEach(({ name, start }) => {
    const binding = resolveBindingAt(ctx, name, start);
    if (!binding) {
      return;
    }

    if (isFunction && isBindingDeclaredWithin(binding, expression)) {
      return;
    }

    if (binding.kind === 'param') {
      throw new Error(
        `This identifier cannot be used in the template, because it is a function parameter.`
      );
    }

    const isIterationBinding = binding.isIteration === true;
    const isDynamicScopedBinding =
      !binding.isRoot &&
      !binding.importedFrom &&
      !binding.declarator &&
      !binding.functionNode;
    if (isIterationBinding || isDynamicScopedBinding) {
      throw snapshotReplayError();
    }

    ctx.dependencyNames.add(name);

    if (binding.importedFrom) {
      importedFrom.push(binding.importedFrom);
      if (hasBindingMutationBefore(binding, start, ctx)) {
        hasNonStaticLocalReference = true;
        return;
      }

      if (binding.imported && binding.imported !== '*') {
        staticImports.push({
          imported: binding.imported,
          local: binding.name,
          source: binding.importedFrom,
        });
      } else if (
        binding.imported === '*' &&
        namespaceStatic.coveredReferenceStarts.has(start)
      ) {
        // The static candidate source gets a synthetic named import alias,
        // while the eval fallback keeps the original namespace expression.
      } else {
        hasNonStaticLocalReference = true;
      }
      return;
    }

    if (preserveRuntimeIdentity && binding.isRoot) {
      hasNonStaticLocalReference = true;
      return;
    }

    const replacement =
      binding.declarationKind === 'const'
        ? getConstantReplacement(binding, ctx)
        : null;
    if (evaluate && replacement) {
      identifierReplacements.set(start, replacement);
      return;
    }

    const init = binding.declarator?.init;
    // Processor-managed bindings (`const x = css```, or object literals
    // containing processor tags) carry values that only become known after
    // processors run. Leave the identifier free in the candidate source so
    // the resolver can supply it via inlineConstants at evaluation time.
    const isProcessorManagedLocal =
      !!evaluate &&
      !!init &&
      (containsTaggedTemplateExpression(init) ||
        containsProcessorManagedExpression(init, ctx));
    const staticLocalExpression =
      evaluate && init && !isProcessorManagedLocal
        ? collectStaticBindingExpression(binding, start, ctx)
        : null;
    if (staticLocalExpression) {
      staticIdentifierReplacements.set(start, staticLocalExpression.source);
      importedFrom.push(...staticLocalExpression.importedFrom);
      staticImports.push(...staticLocalExpression.imports);
    } else if (isProcessorManagedLocal) {
      hasInlinableLocalReference = true;
    } else {
      hasNonStaticLocalReference = true;
    }

    if (!isProcessorManagedLocal) {
      if (
        requiresSnapshotReplay(binding, ctx) &&
        !snapshotWriteFallbackBindings.has(binding)
      ) {
        if (!staticLocalExpression) {
          hasSnapshotReplay = true;
          hasNonStaticLocalReference = true;
        }
        identifierReplacements.set(
          start,
          addHoistedSnapshotReplay(binding, ctx)
        );
      } else {
        assertHoistable(binding, ctx);
        addHoistedDeclaration(binding, ctx);
        if (!binding.isRoot && binding.declarator) {
          identifierReplacements.set(
            start,
            getHoistedBindingName(binding, ctx)
          );
        }
      }
    }
  });

  // Merge literal-const inlines (e.g. `const A = 32` -> "32") with
  // local-to-imported substitutions (e.g. `const X = imp.y` -> "imp.y").
  // Both must reach the candidate source so the resolver's evaluator
  // can fold every Identifier in the expression; env only carries
  // imported bindings, never same-file locals.
  const mergedReplacements = new Map(staticIdentifierReplacements);
  identifierReplacements.forEach((value, key) => {
    if (!mergedReplacements.has(key)) {
      mergedReplacements.set(key, value);
    }
  });

  let staticExpressionCode: string | undefined;
  if (!hasSnapshotReplay && mergedReplacements.size > 0) {
    staticExpressionCode = replaceStaticLocalReferences(
      expression,
      new Map(),
      ctx,
      namespaceStatic.replacements,
      mergedReplacements
    );
  } else if (!hasSnapshotReplay && namespaceStatic.replacements.length > 0) {
    staticExpressionCode = applyExpressionReplacements(
      expression,
      namespaceStatic.replacements,
      ctx.code
    );
  }

  return {
    expressionCode:
      identifierReplacements.size > 0
        ? replaceIdentifierReferences(
            expression,
            new Map(),
            ctx.code,
            identifierReplacements
          )
        : source,
    importedFrom,
    kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
    staticExpressionCode,
    hasInlinableLocalReference:
      !hasNonStaticLocalReference && hasInlinableLocalReference,
    staticImports: hasNonStaticLocalReference ? [] : staticImports,
    staticValue: preservedStaticValue,
  };
};

const getInsertionPoints = (
  program: Program,
  expressions: Expression[]
): number[] => {
  if (expressions.length === 0) {
    return [];
  }

  if (program.body.length === 0) {
    return expressions.map(() => 0);
  }

  const insertionPoints: number[] = [];
  let ownerIndex = 0;

  expressions.forEach((expression) => {
    while (
      ownerIndex < program.body.length - 1 &&
      program.body[ownerIndex]!.end < expression.start
    ) {
      ownerIndex += 1;
    }

    let owner: Program['body'][number] | undefined = program.body[ownerIndex];
    if (
      !owner ||
      owner.start > expression.start ||
      owner.end < expression.end
    ) {
      owner = program.body.find(
        (statement) =>
          statement.start <= expression.start && statement.end >= expression.end
      );
    }

    insertionPoints.push(owner?.start ?? 0);
  });

  return insertionPoints;
};

const extractExpressions = (
  code: string,
  filename: string,
  evaluate: boolean,
  program: Program,
  analysis: Pick<
    ProgramAnalysis,
    | 'bindingsByName'
    | 'rootMutationHazardsByBinding'
    | 'rootMutationsByBinding'
    | 'usedNames'
  >,
  expressions: Expression[],
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = [],
  allowSnapshotWriteFallback = false
): TemplateExtractionResult => {
  if (expressions.length === 0) {
    return {
      code,
      dependencyNames: [],
      expressionValues: [],
      staticValueCandidates: [],
      staticValues: [],
    };
  }

  const insertionPoints = getInsertionPoints(program, expressions);
  const ctx: ExtractionContext = {
    bindingResolutionCache: new Map(),
    bindingsByName: analysis.bindingsByName,
    code,
    currentInsertionPoint: insertionPoints[0] ?? 0,
    currentExpressionStart: expressions[0].start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedBindingNames: new Map(),
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createOxcLocationLookup(code),
    processorManagedExpressionSpans: new Set(
      processorManagedExpressionSpans.map(expressionSpanKey)
    ),
    program,
    referencesByNode: new WeakMap(),
    replacements: [],
    rootMutationHazardsByBinding: analysis.rootMutationHazardsByBinding,
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    staticBindings,
    staticImportAliases: new Map(),
    staticValueCandidates: [],
    staticValues: [],
    usedNames: new Set(analysis.usedNames),
  };

  const snapshotWriteFallbackBindings = new Set<Binding>();
  if (allowSnapshotWriteFallback) {
    expressions.forEach((expression, index) => {
      ctx.currentInsertionPoint = insertionPoints[index] ?? 0;
      ctx.currentExpressionStart = expression.start;
      collectEagerIdentifierMutationTargets(expression).forEach((target) => {
        const binding = resolveBindingAt(ctx, target.name, target.start);
        if (binding && requiresSnapshotReplay(binding, ctx)) {
          snapshotWriteFallbackBindings.add(binding);
        }
      });
    });
  }

  expressions.forEach((expression, index) => {
    ctx.currentInsertionPoint = insertionPoints[index] ?? 0;
    ctx.currentExpressionStart = expression.start;

    const literal = literalExpressionValue(expression, ctx);
    if (literal) {
      ctx.expressionValues.push(literal);
      return;
    }

    const {
      expressionCode,
      hasInlinableLocalReference,
      importedFrom,
      kind,
      staticExpressionCode,
      staticImports,
      staticValue,
    } = extractExpression(
      expression,
      ctx,
      evaluate,
      snapshotWriteFallbackBindings
    );
    const expName = allocateExpressionName(ctx);

    addHoistedCode(
      expName,
      `const ${expName} = () => (${expressionCode});`,
      ctx
    );
    if (staticValue !== undefined && kind !== ValueType.FUNCTION) {
      ctx.staticValues.push({
        name: expName,
        value: staticValue,
      });
    } else if (
      (staticImports.length > 0 ||
        hasInlinableLocalReference ||
        staticExpressionCode !== undefined) &&
      kind !== ValueType.FUNCTION
    ) {
      const uniqueImports = new Map<string, OxcStaticImportReference>();
      staticImports.forEach((item) => {
        uniqueImports.set(
          `${item.local}\0${item.importLocal ?? ''}\0${item.source}\0${
            item.imported
          }`,
          item
        );
      });
      ctx.staticValueCandidates.push({
        imports: [...uniqueImports.values()],
        name: expName,
        source: staticExpressionCode ?? expressionCode,
      });
    }
    ctx.replacements.push({
      start: expression.start,
      end: expression.end,
      value: `${expName}()`,
    });
    ctx.expressionValues.push({
      ex: {
        loc: getSourceLocation(expression.start, expression.end, ctx),
        name: expName,
        type: 'Identifier',
      },
      importedFrom,
      kind,
      source: ctx.code.slice(expression.start, expression.end),
    } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>);
  });

  ctx.hoistedDeclarationsByInsertionPoint.forEach((declarations, point) => {
    ctx.replacements.push({
      start: point,
      end: point,
      value: `${declarations.join('\n')}\n`,
    });
  });

  return {
    code: applyOxcReplacements(code, ctx.replacements),
    dependencyNames: [...ctx.dependencyNames],
    expressionValues: ctx.expressionValues,
    staticValueCandidates: ctx.staticValueCandidates,
    staticValues: ctx.staticValues,
  };
};

export const isOxcStaticSerializableValue = (value: unknown): boolean =>
  isStaticSerializableValue(value);

export const evaluateOxcStaticExpressionAt = (
  code: string,
  filename: string,
  expressionSpan: ExpressionSpan,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup([expressionSpan]),
  });
  const [expression] = analysis.targetExpressions;
  if (!expression) {
    return undefined;
  }

  const ctx: ExtractionContext = {
    bindingResolutionCache: new Map(),
    bindingsByName: analysis.bindingsByName,
    code,
    currentInsertionPoint: 0,
    currentExpressionStart: expression.start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedBindingNames: new Map(),
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createOxcLocationLookup(code),
    processorManagedExpressionSpans: new Set(),
    program,
    referencesByNode: new WeakMap(),
    replacements: [],
    rootMutationHazardsByBinding: analysis.rootMutationHazardsByBinding,
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    staticBindings,
    staticImportAliases: new Map(),
    staticValueCandidates: [],
    staticValues: [],
    usedNames: new Set(analysis.usedNames),
  };

  return evaluateStatic(expression, ctx, new Map(env));
};

export const evaluateOxcStaticExpression = (
  source: string,
  filename: string,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined => {
  const code = `const __wyw_static_value = ${source};`;
  const program = parseOxc(code, filename);
  const declaration = program.body[0];
  if (declaration?.type !== 'VariableDeclaration') {
    return undefined;
  }

  const [declarator] = declaration.declarations;
  if (!declarator?.init) {
    return undefined;
  }

  return evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: declarator.init.end,
      start: declarator.init.start,
    },
    env,
    staticBindings
  );
};

export const collectOxcExpressionDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetExpressionSpans?: ExpressionSpan[],
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = []
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup(targetExpressionSpans),
    mutationHazardIgnoreLookup: createSpanLookup(
      processorManagedExpressionSpans
    ),
  });

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    analysis.targetExpressions,
    staticBindings,
    processorManagedExpressionSpans
  );
};

export const collectOxcExpressionDependenciesForEvalFallback = (
  code: string,
  filename: string,
  targetExpressionSpans?: ExpressionSpan[],
  processorManagedExpressionSpans: ExpressionSpan[] = []
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup(targetExpressionSpans),
    mutationHazardIgnoreLookup: createSpanLookup(
      processorManagedExpressionSpans
    ),
  });
  const extracted = extractExpressions(
    code,
    filename,
    false,
    program,
    analysis,
    analysis.targetExpressions,
    undefined,
    processorManagedExpressionSpans,
    true
  );

  return {
    ...extracted,
    staticValueCandidates: [],
    staticValues: [],
  };
};

export const collectOxcTemplateDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetTemplateSpans?: ExpressionSpan[]
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTemplateLiterals: true,
    templateSpanLookup: createSpanLookup(targetTemplateSpans),
  });
  const expressions = analysis.templateLiterals.flatMap(
    (template) => template.expressions
  );

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    expressions
  );
};
