/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  Expression,
  MemberExpression,
  Node,
  VariableDeclarator,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import {
  collectOxcPatternBindingNames,
  someOxcPatternNode,
} from '../oxc/patterns';
import {
  findReferences,
  getRootMutationHazards,
  unknownAliasMutationBinding,
  resolveBindingAt,
  toMutationBindingKey,
} from './scopeAnalysis';
import type { Binding, ExtractionContext, OxcFunctionLikeNode } from './types';

const symbolIteratorPathPart = '\0wyw-static-Symbol.iterator';

type StaticMemberPath = {
  parts: Array<string | number>;
  root: string;
};

const getUnshadowedStaticMemberPath = (
  node: Node,
  ctx: ExtractionContext,
  seenBindings = new Set<Binding>()
): StaticMemberPath | null => {
  if (node.type === 'Identifier') {
    const binding = resolveBindingAt(ctx, node.name, node.start);
    if (!binding) {
      return { parts: [], root: node.name };
    }

    if (
      binding.declarationKind !== 'const' ||
      !binding.declarator?.init ||
      binding.declarator.id.type !== 'Identifier' ||
      binding.declarator.end > node.start ||
      seenBindings.has(binding)
    ) {
      return null;
    }

    const nextSeenBindings = new Set(seenBindings);
    nextSeenBindings.add(binding);
    return getUnshadowedStaticMemberPath(
      binding.declarator.init,
      ctx,
      nextSeenBindings
    );
  }

  if (node.type !== 'MemberExpression') {
    return null;
  }

  const parent = getUnshadowedStaticMemberPath(node.object, ctx, seenBindings);
  if (!parent) {
    return null;
  }

  let key: string | number | null = null;
  if (!node.computed && node.property.type === 'Identifier') {
    key = node.property.name;
  } else if (
    node.computed &&
    node.property.type === 'Literal' &&
    (typeof node.property.value === 'string' ||
      typeof node.property.value === 'number')
  ) {
    key = node.property.value;
  } else if (node.computed) {
    const propertyPath = getUnshadowedStaticMemberPath(
      node.property,
      ctx,
      seenBindings
    );
    if (
      propertyPath?.root === 'Symbol' &&
      propertyPath.parts.length === 1 &&
      propertyPath.parts[0] === 'iterator'
    ) {
      key = symbolIteratorPathPart;
    }
  }

  return key === null
    ? null
    : {
        parts: [...parent.parts, key],
        root: parent.root,
      };
};

const nodeContainsStaticMemberPath = (
  node: Node,
  root: string,
  prefix: ReadonlyArray<string | number>,
  ctx: ExtractionContext
): boolean => {
  const path = getUnshadowedStaticMemberPath(node, ctx);
  if (
    path?.root === root &&
    prefix.every((part, index) => path.parts[index] === part)
  ) {
    return true;
  }

  return getOxcNodeChildren(node).some((child) =>
    nodeContainsStaticMemberPath(child, root, prefix, ctx)
  );
};

const intrinsicChangesBefore = (
  binding: 'Array' | 'Object' | 'String',
  end: number,
  ctx: ExtractionContext
): Node[] =>
  [
    ...(ctx.rootMutationsByBinding.get(binding) ?? []),
    ...(ctx.rootMutationHazardsByBinding.get(binding) ?? []),
  ].filter((change) => change.end <= end);

export const hasRelevantIntrinsicMutationBefore = (
  pattern: Node,
  end: number,
  ctx: ExtractionContext
): boolean => {
  const unknownAliasChangesBefore = getRootMutationHazards(
    ctx.rootMutationHazardsByBinding,
    unknownAliasMutationBinding
  ).some((change) => change.end <= end);

  if (
    someOxcPatternNode(pattern, (node) => node.type === 'ObjectPattern') &&
    (unknownAliasChangesBefore ||
      intrinsicChangesBefore('Object', end, ctx).some(
        (change) =>
          !nodeContainsStaticMemberPath(change, 'Object', [], ctx) ||
          nodeContainsStaticMemberPath(change, 'Object', ['prototype'], ctx)
      ))
  ) {
    return true;
  }

  return (
    someOxcPatternNode(pattern, (node) => node.type === 'ArrayPattern') &&
    hasArrayIterationMutationBefore(end, ctx)
  );
};

export const hasArrayIterationMutationBefore = (
  end: number,
  ctx: ExtractionContext
): boolean =>
  getRootMutationHazards(
    ctx.rootMutationHazardsByBinding,
    unknownAliasMutationBinding
  ).some((change) => change.end <= end) ||
  intrinsicChangesBefore('Object', end, ctx).some(
    (change) =>
      !nodeContainsStaticMemberPath(change, 'Object', [], ctx) ||
      nodeContainsStaticMemberPath(change, 'Object', ['prototype'], ctx)
  ) ||
  intrinsicChangesBefore('Array', end, ctx).some(
    (change) =>
      !nodeContainsStaticMemberPath(change, 'Array', [], ctx) ||
      nodeContainsStaticMemberPath(change, 'Array', ['prototype'], ctx)
  );

export const hasStringPrototypeMutationBefore = (
  end: number,
  ctx: ExtractionContext
): boolean =>
  intrinsicChangesBefore('String', end, ctx).some(
    (change) =>
      !nodeContainsStaticMemberPath(change, 'String', [], ctx) ||
      nodeContainsStaticMemberPath(change, 'String', ['prototype'], ctx)
  );

export const getBindingMutationHazards = (
  binding: Binding,
  ctx: ExtractionContext
): Node[] =>
  getRootMutationHazards(
    ctx.rootMutationHazardsByBinding,
    toMutationBindingKey(binding)
  );

const assignmentTargetContainsBinding = (
  target: Node,
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  if (target.type === 'Identifier') {
    return resolveBindingAt(ctx, target.name, target.start) === binding;
  }

  if (target.type === 'AssignmentPattern') {
    return assignmentTargetContainsBinding(target.left, binding, ctx);
  }

  if (target.type === 'RestElement') {
    return assignmentTargetContainsBinding(target.argument, binding, ctx);
  }

  if (target.type === 'ArrayPattern') {
    return target.elements.some(
      (element) =>
        !!element && assignmentTargetContainsBinding(element, binding, ctx)
    );
  }

  if (target.type === 'ObjectPattern') {
    return target.properties.some((property) =>
      assignmentTargetContainsBinding(
        property.type === 'RestElement' ? property.argument : property.value,
        binding,
        ctx
      )
    );
  }

  return false;
};

export const mutationDirectlyTargetsBinding = (
  mutation: Node,
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  if (mutation.type === 'AssignmentExpression') {
    return assignmentTargetContainsBinding(mutation.left, binding, ctx);
  }

  return (
    mutation.type === 'UpdateExpression' &&
    assignmentTargetContainsBinding(mutation.argument, binding, ctx)
  );
};

export const hasDirectBindingMutationBefore = (
  binding: Binding,
  end: number,
  ctx: ExtractionContext
): boolean =>
  [
    ...(ctx.rootMutationsByBinding.get(toMutationBindingKey(binding)) ?? []),
    ...getBindingMutationHazards(binding, ctx),
  ].some(
    (mutation) =>
      mutation.end <= end &&
      mutationDirectlyTargetsBinding(mutation, binding, ctx)
  );

export const hasLexicalPreDeclarationChange = (
  binding: Binding,
  ctx: ExtractionContext,
  bindingMutations: readonly Node[],
  bindingMutationHazards: readonly Node[]
): boolean => {
  if (
    (binding.declarationKind !== 'const' &&
      binding.declarationKind !== 'let') ||
    !binding.declarator
  ) {
    return false;
  }

  const isPreDeclarationChange = (change: Node): boolean =>
    change.start < binding.declaredAt &&
    findReferences(change, ctx.referencesByNode).some(
      ({ name, start }) =>
        name === binding.name && resolveBindingAt(ctx, name, start) === binding
    );

  return (
    bindingMutations.some(isPreDeclarationChange) ||
    bindingMutationHazards.some(isPreDeclarationChange)
  );
};

export const isPatternRuntimeExpressionStable = (
  expression: Expression,
  patternDeclarator: VariableDeclarator,
  ctx: ExtractionContext,
  env: ReadonlyMap<string, unknown>,
  stack = new Set<string>()
): boolean =>
  findReferences(expression, ctx.referencesByNode).every(
    ({ name, start: referenceStart }) => {
      if (env.has(name)) {
        return true;
      }

      const binding = resolveBindingAt(ctx, name, referenceStart);
      if (!binding || binding.kind === 'param') {
        return false;
      }

      if (binding.declarator === patternDeclarator) {
        return true;
      }

      if (binding.kind === 'import' || binding.kind === 'function') {
        return true;
      }

      if (
        binding.declarationKind !== 'const' ||
        !binding.declarator?.init ||
        referenceStart < binding.declarator.end ||
        stack.has(binding.name)
      ) {
        return false;
      }

      const nextStack = new Set(stack);
      nextStack.add(binding.name);
      return isPatternRuntimeExpressionStable(
        binding.declarator.init,
        patternDeclarator,
        ctx,
        env,
        nextStack
      );
    }
  );

export const isDestructuringProjection = (
  callee: Node
): callee is OxcFunctionLikeNode =>
  callee.type === 'ArrowFunctionExpression' &&
  !callee.async &&
  callee.params.length === 1 &&
  (callee.params[0]?.type === 'ObjectPattern' ||
    callee.params[0]?.type === 'ArrayPattern') &&
  callee.body?.type === 'Identifier' &&
  new Set(collectOxcPatternBindingNames(callee.params[0])).has(
    callee.body.name
  );

const isProcessEnvMember = (node: Node): node is MemberExpression => {
  if (node.type !== 'MemberExpression' || node.computed) {
    return false;
  }

  if (node.property.type !== 'Identifier' || node.property.name !== 'env') {
    return false;
  }

  return node.object.type === 'Identifier' && node.object.name === 'process';
};

export const isProcessEnvValueAccess = (
  expression: Expression,
  ctx: ExtractionContext,
  env: ReadonlyMap<string, unknown>
): boolean => {
  const processEnvMember =
    expression.type === 'MemberExpression' ? expression.object : null;
  if (
    !processEnvMember ||
    !isProcessEnvMember(processEnvMember) ||
    env.has('process')
  ) {
    return false;
  }

  const processIdentifier = processEnvMember.object;
  return (
    processIdentifier.type === 'Identifier' &&
    !resolveBindingAt(ctx, processIdentifier.name, processIdentifier.start)
  );
};

export const isDeterministicUndefinedExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  env: ReadonlyMap<string, unknown>
): boolean => {
  if (isProcessEnvValueAccess(expression, ctx, env)) {
    return true;
  }

  if (expression.type === 'UnaryExpression' && expression.operator === 'void') {
    return true;
  }

  if (expression.type === 'Identifier') {
    if (env.has(expression.name)) {
      return env.get(expression.name) === undefined;
    }

    const binding = resolveBindingAt(ctx, expression.name, expression.start);
    if (
      binding?.declarationKind === 'var' &&
      binding.declarator &&
      ctx.currentExpressionStart < binding.declarator.end
    ) {
      return true;
    }
  }

  return (
    expression.type === 'Identifier' &&
    expression.name === 'undefined' &&
    !resolveBindingAt(ctx, expression.name, expression.start)
  );
};
