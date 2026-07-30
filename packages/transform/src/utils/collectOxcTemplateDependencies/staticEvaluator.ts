/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { types as nodeUtilTypes } from 'util';

import type {
  AssignmentExpression,
  Expression,
  MemberExpression,
  Node,
  UpdateExpression,
  VariableDeclarator,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import {
  collectOxcPatternBindingNames,
  collectOxcPatternRuntimeExpressions,
  someOxcPatternNode,
} from '../oxc/patterns';
import { lookupStaticBinding } from './staticBindings';
import {
  findReferences,
  getRootMutationHazards,
  unknownAliasMutationBinding,
  resolveBindingAt,
  toMutationBindingKey,
} from './scopeAnalysis';
import type { Binding, ExtractionContext, OxcFunctionLikeNode } from './types';

const isStaticProxy = (value: unknown): value is object =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  nodeUtilTypes.isProxy(value);

const invalidStaticLiteral = Symbol('wyw.oxc.invalidStaticLiteral');

const staticStringLiteral = (
  value: string
): string | typeof invalidStaticLiteral => {
  const literal = JSON.stringify(value);
  return typeof literal === 'string' ? literal : invalidStaticLiteral;
};

const isLiteralDataDescriptor = (
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor & { value: unknown } =>
  !!descriptor &&
  'value' in descriptor &&
  descriptor.configurable === true &&
  descriptor.enumerable === true &&
  descriptor.writable === true;

const staticLiteralCodeInternal = (
  value: unknown,
  ancestors: WeakSet<object>,
  wrapObject = false
): string | typeof invalidStaticLiteral => {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return staticStringLiteral(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return invalidStaticLiteral;
    }
    return Object.is(value, -0) ? '-0' : String(value);
  }

  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    isStaticProxy(value) ||
    typeof value === 'function'
  ) {
    return invalidStaticLiteral;
  }

  if (ancestors.has(value)) {
    return invalidStaticLiteral;
  }

  const isArray = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (isArray ? Array.prototype : Object.prototype) ||
    !Object.isExtensible(value)
  ) {
    return invalidStaticLiteral;
  }

  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
      return invalidStaticLiteral;
    }

    if (isArray) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        !lengthDescriptor ||
        !('value' in lengthDescriptor) ||
        typeof lengthDescriptor.value !== 'number' ||
        lengthDescriptor.configurable !== false ||
        lengthDescriptor.enumerable !== false ||
        lengthDescriptor.writable !== true
      ) {
        return invalidStaticLiteral;
      }

      const length = lengthDescriptor.value;
      const elements: string[] = new Array(length);
      let elementCount = 0;
      for (const key of keys) {
        if (key === 'length') {
          continue;
        }

        const index = Number(key);
        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== key
        ) {
          return invalidStaticLiteral;
        }

        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!isLiteralDataDescriptor(descriptor)) {
          return invalidStaticLiteral;
        }

        const element = staticLiteralCodeInternal(descriptor.value, ancestors);
        if (element === invalidStaticLiteral) {
          return invalidStaticLiteral;
        }

        elements[index] = element;
        elementCount += 1;
      }

      // Array holes stringify as `null`, which changes their observable shape.
      // Reject them instead of silently materializing elements.
      if (elementCount !== length) {
        return invalidStaticLiteral;
      }

      return `[${elements.join(',')}]`;
    }

    const properties: string[] = [];
    for (const key of keys) {
      if (typeof key !== 'string') {
        return invalidStaticLiteral;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!isLiteralDataDescriptor(descriptor)) {
        return invalidStaticLiteral;
      }

      const propertyValue = staticLiteralCodeInternal(
        descriptor.value,
        ancestors
      );
      if (propertyValue === invalidStaticLiteral) {
        return invalidStaticLiteral;
      }

      const keyCode = staticStringLiteral(key);
      if (keyCode === invalidStaticLiteral) {
        return invalidStaticLiteral;
      }
      const safeKey = key === '__proto__' ? `[${keyCode}]` : keyCode;
      properties.push(`${safeKey}:${propertyValue}`);
    }

    const objectCode = `{${properties.join(',')}}`;
    return wrapObject ? `(${objectCode})` : objectCode;
  } finally {
    ancestors.delete(value);
  }
};

export const literalCode = (value: unknown): string | null => {
  try {
    const literal = staticLiteralCodeInternal(value, new WeakSet(), true);
    return literal === invalidStaticLiteral ? null : literal;
  } catch {
    return null;
  }
};

export const isStaticSerializableValue = (value: unknown): boolean =>
  literalCode(value) !== null;

const unsafeStaticClone = Symbol('wyw.oxc.unsafeStaticClone');

const cloneStaticValueInternal = (
  value: unknown,
  seen = new WeakMap<object, unknown>()
): unknown | typeof unsafeStaticClone => {
  if (isStaticProxy(value)) {
    return unsafeStaticClone;
  }

  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const result: unknown[] = new Array(
      typeof lengthDescriptor?.value === 'number' ? lengthDescriptor.value : 0
    );
    Object.setPrototypeOf(result, Object.getPrototypeOf(value));
    seen.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }

      if ('value' in descriptor) {
        const clonedValue = cloneStaticValueInternal(descriptor.value, seen);
        if (clonedValue === unsafeStaticClone) {
          return unsafeStaticClone;
        }
        Object.defineProperty(result, key, {
          ...descriptor,
          value: clonedValue,
        });
      } else {
        Object.defineProperty(result, key, descriptor);
      }
    }
    if (lengthDescriptor) {
      Object.defineProperty(result, 'length', lengthDescriptor);
    }
    return result;
  }

  if (typeof value === 'object' && value !== null) {
    const existing = seen.get(value);
    if (existing) {
      return existing;
    }

    const result = Object.create(Object.getPrototypeOf(value)) as Record<
      string,
      unknown
    >;
    seen.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        continue;
      }

      if ('value' in descriptor) {
        const clonedValue = cloneStaticValueInternal(descriptor.value, seen);
        if (clonedValue === unsafeStaticClone) {
          return unsafeStaticClone;
        }
        Object.defineProperty(result, key, {
          ...descriptor,
          value: clonedValue,
        });
      } else {
        Object.defineProperty(result, key, descriptor);
      }
    }
    return result;
  }

  return value;
};

export const cloneStaticValue = (
  value: unknown,
  seen = new WeakMap<object, unknown>()
): unknown => {
  const cloned = cloneStaticValueInternal(value, seen);
  return cloned === unsafeStaticClone ? undefined : cloned;
};

const INT32_SIZE = 2 ** 32;
const INT32_SIGN_BIT = 2 ** 31;
const defaultArrayIterator = Array.prototype[Symbol.iterator];
const symbolIteratorPathPart = '\0wyw-static-Symbol.iterator';
const uninitializedStaticBinding = Symbol('wyw.oxc.uninitializedStaticBinding');

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

const hasRelevantIntrinsicMutationBefore = (
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

const hasArrayIterationMutationBefore = (
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

const hasStringPrototypeMutationBefore = (
  end: number,
  ctx: ExtractionContext
): boolean =>
  intrinsicChangesBefore('String', end, ctx).some(
    (change) =>
      !nodeContainsStaticMemberPath(change, 'String', [], ctx) ||
      nodeContainsStaticMemberPath(change, 'String', ['prototype'], ctx)
  );

const toInt32 = (value: number): number => {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }

  const integer = Math.sign(value) * Math.floor(Math.abs(value));
  const int32bit = ((integer % INT32_SIZE) + INT32_SIZE) % INT32_SIZE;

  return int32bit >= INT32_SIGN_BIT ? int32bit - INT32_SIZE : int32bit;
};

const bitwiseNot = (value: number): number => -toInt32(value) - 1;

const getBindingMutationHazards = (
  binding: Binding,
  ctx: ExtractionContext
): Node[] =>
  getRootMutationHazards(
    ctx.rootMutationHazardsByBinding,
    toMutationBindingKey(binding)
  );

const bindingValueCacheKey = (
  binding: Binding,
  ctx: ExtractionContext,
  bindingMutations: readonly Node[] = ctx.rootMutationsByBinding.get(
    toMutationBindingKey(binding)
  ) ?? [],
  bindingMutationHazards: readonly Node[] = getBindingMutationHazards(
    binding,
    ctx
  )
): string => {
  const snapshot =
    bindingMutations.some(
      (mutation) => mutation.start < ctx.currentExpressionStart
    ) ||
    bindingMutationHazards.some(
      (hazard) =>
        !isKnownPureStaticCall(hazard, ctx) &&
        hazard.end <= ctx.currentExpressionStart
    )
      ? ctx.currentExpressionStart
      : 'stable';
  return `\0wyw-static-binding:${binding.declaredAt}:${snapshot}:${binding.name}`;
};

const getObjectMember = (
  objectValue: unknown,
  property: string | number
): unknown | undefined => {
  if (
    isStaticProxy(objectValue) ||
    objectValue === null ||
    objectValue === undefined ||
    (typeof objectValue !== 'object' &&
      typeof objectValue !== 'string' &&
      typeof objectValue !== 'number' &&
      typeof objectValue !== 'boolean')
  ) {
    return undefined;
  }

  const target =
    typeof objectValue === 'object' ? objectValue : Object(objectValue);
  const member = readOwnDataProperty(target, String(property));
  return member.safe && member.found ? member.value : undefined;
};

type StaticPropertyRead = {
  found: boolean;
  safe: boolean;
  value?: unknown;
};

const readOwnDataProperty = (
  value: object,
  key: PropertyKey
): StaticPropertyRead => {
  if (isStaticProxy(value)) {
    return { found: false, safe: false };
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      return { found: false, safe: true };
    }

    return 'value' in descriptor
      ? { found: true, safe: true, value: descriptor.value }
      : { found: true, safe: false };
  } catch {
    return { found: false, safe: false };
  }
};

const defineStaticDataProperty = (
  target: object,
  key: PropertyKey,
  value: unknown
): boolean => {
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
};

const copyEnumerableOwnDataProperties = (
  target: object,
  source: object
): boolean => {
  if (isStaticProxy(source)) {
    return false;
  }

  try {
    for (const key of Reflect.ownKeys(source)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor?.enumerable) {
        continue;
      }

      if (
        !('value' in descriptor) ||
        !defineStaticDataProperty(target, key, descriptor.value)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

const staticObjectPropertyKey = (
  property: Node & { computed?: boolean; key?: Node },
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): string | number | null => {
  if (!property.key) {
    return null;
  }

  let key: unknown;
  if (property.computed) {
    key = evaluateStatic(property.key as Expression, ctx, env, stack);
  } else if (property.key.type === 'Identifier') {
    key = property.key.name;
  } else if (property.key.type === 'Literal') {
    key = property.key.value;
  }

  return typeof key === 'string' || typeof key === 'number' ? key : null;
};

const evaluateObjectExpressionMember = (
  expression: Expression,
  propertyKey: string | number,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): unknown | undefined => {
  if (expression.type !== 'ObjectExpression') {
    return undefined;
  }

  for (let idx = expression.properties.length - 1; idx >= 0; idx -= 1) {
    const property = expression.properties[idx]!;
    if (property.type === 'SpreadElement') {
      return undefined;
    }

    const key = staticObjectPropertyKey(property, ctx, env, stack);
    if (key === null) {
      return undefined;
    }

    if (key === propertyKey) {
      return evaluateStatic(property.value, ctx, env, stack);
    }
  }

  return undefined;
};

const evaluateKnownObjectMember = (
  expression: Expression,
  propertyKey: string | number,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): unknown | undefined => {
  const objectMember = evaluateObjectExpressionMember(
    expression,
    propertyKey,
    ctx,
    env,
    stack
  );
  if (objectMember !== undefined) {
    return objectMember;
  }

  if (expression.type !== 'Identifier' || env.has(expression.name)) {
    return undefined;
  }

  const binding = resolveBindingAt(ctx, expression.name, expression.start);
  if (
    !binding ||
    binding.kind === 'param' ||
    binding.importedFrom ||
    binding.isRoot ||
    stack.includes(binding.name) ||
    !binding.declarator?.init ||
    binding.declarator.id.type !== 'Identifier'
  ) {
    return undefined;
  }

  return evaluateKnownObjectMember(
    binding.declarator.init,
    propertyKey,
    ctx,
    env,
    [...stack, binding.name]
  );
};

type EvalEnv = Map<string, unknown>;

const oxcStaticCallableValue = Symbol('wyw.oxc.staticCallableValue');
const oxcStaticFunctionNode = Symbol('wyw.oxc.staticFunctionNode');

type OxcStaticCallableValue = {
  [oxcStaticCallableValue]: unknown;
};

type OxcStaticFunctionValue = (() => undefined) & {
  [oxcStaticFunctionNode]: OxcFunctionLikeNode;
};

const isOxcStaticCallableValue = (
  value: unknown
): value is OxcStaticCallableValue =>
  typeof value === 'object' &&
  value !== null &&
  !isStaticProxy(value) &&
  oxcStaticCallableValue in value;

const unwrapOxcStaticCallableValue = (value: unknown): unknown =>
  isOxcStaticCallableValue(value) ? value[oxcStaticCallableValue] : value;

const createOxcStaticFunctionValue = (
  fn: OxcFunctionLikeNode
): OxcStaticFunctionValue =>
  Object.assign(() => undefined, {
    [oxcStaticFunctionNode]: fn,
  });

const isOxcStaticFunctionValue = (
  value: unknown
): value is OxcStaticFunctionValue =>
  typeof value === 'function' &&
  !isStaticProxy(value) &&
  oxcStaticFunctionNode in value;

export const createOxcStaticCallableValue = (
  value: unknown
): OxcStaticCallableValue => ({
  [oxcStaticCallableValue]: value,
});

const hasReferencedRootMutationBetween = (
  expression: Expression,
  start: number,
  end: number,
  ctx: ExtractionContext
): boolean =>
  findReferences(expression, ctx.referencesByNode).some(
    ({ name, start: referenceStart }) => {
      const binding = resolveBindingAt(ctx, name, referenceStart);
      if (!binding) {
        return false;
      }

      return (
        (
          ctx.rootMutationsByBinding.get(toMutationBindingKey(binding)) ?? []
        ).some((mutation) => start <= mutation.start && mutation.start < end) ||
        getBindingMutationHazards(binding, ctx).some(
          (hazard) =>
            !isKnownPureStaticCall(hazard, ctx) &&
            start <= hazard.start &&
            hazard.end <= end
        )
      );
    }
  );

export const isKnownPureStaticCall = (
  node: Node,
  ctx: ExtractionContext
): boolean => {
  // Tagged templates are classified more precisely by the destructuring
  // projection gate. Treating them as ordinary binding mutations here would
  // make one processor template invalidate every later use of the tag.
  if (node.type === 'TaggedTemplateExpression') {
    return true;
  }

  if (
    node.type === 'CallExpression' &&
    ctx.processorManagedExpressionSpans.has(`${node.start}:${node.end}`)
  ) {
    return true;
  }

  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') {
    return false;
  }

  const binding = resolveBindingAt(ctx, node.callee.name, node.callee.start);
  if (binding?.importedFrom) {
    const override = lookupStaticBinding(
      ctx.staticBindings,
      binding.importedFrom,
      binding.imported
    );
    return override.found && typeof override.value === 'function';
  }

  const fn = binding?.functionNode ?? binding?.declarator?.init;
  if (
    !fn ||
    (fn.type !== 'ArrowFunctionExpression' &&
      fn.type !== 'FunctionDeclaration' &&
      fn.type !== 'FunctionExpression') ||
    (binding?.declarator && binding.declarator.end > node.start) ||
    node.arguments.some((argument) => argument.type === 'SpreadElement')
  ) {
    return false;
  }

  const proofHazards = new Map(ctx.rootMutationHazardsByBinding);
  proofHazards.forEach((hazards, key) => {
    if (hazards.includes(node)) {
      proofHazards.set(
        key,
        hazards.filter((hazard) => hazard !== node)
      );
    }
  });
  const proofCtx: ExtractionContext = {
    ...ctx,
    currentExpressionStart: node.start,
    rootMutationHazardsByBinding: proofHazards,
  };
  const isScalar = (value: unknown): boolean =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint';
  const argumentsAreScalar = node.arguments.every(
    (argument) =>
      argument.type !== 'SpreadElement' &&
      isScalar(evaluateStatic(argument, proofCtx))
  );

  return argumentsAreScalar && isScalar(evaluateStatic(node, proofCtx));
};

const hasReferencedRootMutationHazardBefore = (
  expression: Expression,
  end: number,
  ctx: ExtractionContext,
  ignoredHazard?: Node
): boolean => {
  if (ctx.rootMutationHazardsByBinding.size === 0) {
    return false;
  }

  return findReferences(expression, ctx.referencesByNode).some(
    ({ name, start: referenceStart }) => {
      const binding = resolveBindingAt(ctx, name, referenceStart);
      if (!binding) {
        return false;
      }

      return getBindingMutationHazards(binding, ctx).some(
        (hazard) =>
          !isKnownPureStaticCall(hazard, ctx) &&
          (!ignoredHazard ||
            hazard.start < ignoredHazard.start ||
            ignoredHazard.end < hazard.end) &&
          hazard.end <= end
      );
    }
  );
};

const hasBindingMutationHazardBetween = (
  binding: Binding,
  start: number,
  end: number,
  ctx: ExtractionContext
): boolean =>
  getBindingMutationHazards(binding, ctx).some(
    (hazard) =>
      !isKnownPureStaticCall(hazard, ctx) &&
      start <= hazard.start &&
      hazard.end <= end
  );

const hasBindingMutationBefore = (
  binding: Binding,
  end: number,
  ctx: ExtractionContext
): boolean =>
  (ctx.rootMutationsByBinding.get(toMutationBindingKey(binding)) ?? []).some(
    (mutation) => mutation.start < end
  ) ||
  getBindingMutationHazards(binding, ctx).some(
    (hazard) => !isKnownPureStaticCall(hazard, ctx) && hazard.end <= end
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

const mutationDirectlyTargetsBinding = (
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

const hasDirectBindingMutationBefore = (
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

const hasLexicalPreDeclarationChange = (
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

const isPatternRuntimeExpressionStable = (
  expression: Expression,
  patternDeclarator: VariableDeclarator,
  ctx: ExtractionContext,
  env: EvalEnv,
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

const isDestructuringProjection = (
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

const hasOnlyDataProperties = (value: object): boolean => {
  if (isStaticProxy(value)) {
    return false;
  }

  try {
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && 'value' in descriptor;
    });
  } catch {
    return false;
  }
};

const hasExactPrototype = (value: object, prototype: object): boolean => {
  if (isStaticProxy(value)) {
    return false;
  }

  try {
    return Object.getPrototypeOf(value) === prototype;
  } catch {
    return false;
  }
};

const readObjectProjectionProperty = (
  value: object,
  key: string | number
): StaticPropertyRead => {
  const propertyKey = String(key);
  const own = readOwnDataProperty(value, propertyKey);
  if (!own.safe || own.found) {
    return own;
  }

  try {
    return Object.getOwnPropertyDescriptor(Object.prototype, propertyKey)
      ? { found: true, safe: false }
      : own;
  } catch {
    return { found: false, safe: false };
  }
};

const readArrayProjectionElement = (
  value: unknown[],
  index: number
): StaticPropertyRead => {
  const propertyKey = String(index);
  const own = readOwnDataProperty(value, propertyKey);
  if (!own.safe || own.found) {
    return own;
  }

  try {
    if (
      Object.getOwnPropertyDescriptor(Array.prototype, propertyKey) ||
      Object.getOwnPropertyDescriptor(Object.prototype, propertyKey)
    ) {
      return { found: true, safe: false };
    }
    return own;
  } catch {
    return { found: false, safe: false };
  }
};

const hasDefaultArrayIterator = (value: unknown[]): boolean => {
  const ownIterator = readOwnDataProperty(value, Symbol.iterator);
  if (!ownIterator.safe) {
    return false;
  }
  if (ownIterator.found) {
    return ownIterator.value === defaultArrayIterator;
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      Symbol.iterator
    );
    return (
      !!descriptor &&
      'value' in descriptor &&
      descriptor.value === defaultArrayIterator
    );
  } catch {
    return false;
  }
};

const appendDefaultArrayElements = (
  target: unknown[],
  value: unknown[],
  ctx: ExtractionContext
): boolean => {
  if (
    hasArrayIterationMutationBefore(ctx.currentExpressionStart, ctx) ||
    isStaticProxy(value) ||
    !hasExactPrototype(value, Array.prototype) ||
    !hasOnlyDataProperties(value) ||
    !hasDefaultArrayIterator(value)
  ) {
    return false;
  }

  const length = readOwnDataProperty(value, 'length');
  if (!length.safe || !length.found || typeof length.value !== 'number') {
    return false;
  }

  for (let index = 0; index < length.value; index += 1) {
    const element = readArrayProjectionElement(value, index);
    if (!element.safe) {
      return false;
    }
    target.push(element.value);
  }

  return true;
};

const assignPatternValue = (
  pattern: Node,
  value: unknown,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): boolean => {
  if (pattern.type === 'Identifier') {
    env.set(pattern.name, value);
    return true;
  }

  if (pattern.type === 'AssignmentPattern') {
    const assignedValue =
      value === undefined
        ? evaluateStatic(pattern.right, ctx, env, stack)
        : value;
    if (assignedValue === undefined) {
      return false;
    }

    return assignPatternValue(pattern.left, assignedValue, ctx, env, stack);
  }

  if (pattern.type === 'ObjectPattern') {
    if (
      hasRelevantIntrinsicMutationBefore(
        pattern,
        ctx.currentExpressionStart,
        ctx
      ) ||
      typeof value !== 'object' ||
      value === null ||
      isStaticProxy(value) ||
      !hasExactPrototype(value, Object.prototype) ||
      !hasOnlyDataProperties(value)
    ) {
      return false;
    }

    const excludedKeys = new Set<string>();
    for (const property of pattern.properties) {
      if (property.type === 'RestElement') {
        const rest: Record<string, unknown> = {};
        try {
          if (
            Object.getOwnPropertySymbols(value).some(
              (symbol) =>
                Object.getOwnPropertyDescriptor(value, symbol)?.enumerable
            )
          ) {
            return false;
          }

          Object.keys(value).forEach((key) => {
            if (!excludedKeys.has(key)) {
              const propertyRead = readOwnDataProperty(value, key);
              if (
                !propertyRead.safe ||
                !propertyRead.found ||
                !defineStaticDataProperty(rest, key, propertyRead.value)
              ) {
                throw new Error('Unsafe static object rest property');
              }
            }
          });
        } catch {
          return false;
        }
        if (!assignPatternValue(property.argument, rest, ctx, env, stack)) {
          return false;
        }
        continue;
      }

      let key: unknown;
      if (property.computed) {
        key = evaluateStatic(property.key as Expression, ctx, env, stack);
      } else if (property.key.type === 'Identifier') {
        key = property.key.name;
      } else if (property.key.type === 'Literal') {
        key = property.key.value;
      }
      if (typeof key !== 'string' && typeof key !== 'number') {
        return false;
      }

      excludedKeys.add(String(key));
      const member = readObjectProjectionProperty(value, key);
      if (!member.safe) {
        return false;
      }
      if (!assignPatternValue(property.value, member.value, ctx, env, stack)) {
        return false;
      }
    }

    return true;
  }

  if (pattern.type === 'ArrayPattern') {
    if (
      hasRelevantIntrinsicMutationBefore(
        pattern,
        ctx.currentExpressionStart,
        ctx
      ) ||
      isStaticProxy(value) ||
      !Array.isArray(value) ||
      !hasExactPrototype(value, Array.prototype) ||
      !hasOnlyDataProperties(value)
    ) {
      return false;
    }

    if (!hasDefaultArrayIterator(value)) {
      return false;
    }

    const length = readOwnDataProperty(value, 'length');
    if (!length.safe || !length.found || typeof length.value !== 'number') {
      return false;
    }

    for (let index = 0; index < pattern.elements.length; index += 1) {
      const element = pattern.elements[index];
      let elementValue: unknown;
      if (element?.type === 'RestElement') {
        const rest: unknown[] = [];
        for (let cursor = index; cursor < length.value; cursor += 1) {
          const member = readArrayProjectionElement(value, cursor);
          if (!member.safe) {
            return false;
          }
          rest.push(member.value);
        }
        elementValue = rest;
      } else {
        // Array destructuring advances the iterator for elisions too.
        const member = readArrayProjectionElement(value, index);
        if (!member.safe) {
          return false;
        }
        elementValue = member.value;
      }
      if (!element) {
        continue;
      }

      const target =
        element.type === 'RestElement' ? element.argument : element;
      if (!assignPatternValue(target, elementValue, ctx, env, stack)) {
        return false;
      }
    }

    return true;
  }

  return false;
};

const applyRootMutation = (
  bindingName: string,
  baseValue: unknown,
  mutation: AssignmentExpression | UpdateExpression,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): unknown | undefined => {
  const resolvePath = (node: Node): { path: Array<string | number> } | null => {
    if (node.type === 'Identifier') {
      return node.name === bindingName ? { path: [] } : null;
    }

    if (node.type !== 'MemberExpression') {
      return null;
    }

    const parent = resolvePath(node.object);
    if (!parent) {
      return null;
    }

    let key: unknown;
    if (node.computed) {
      key = evaluateStatic(node.property as Expression, ctx, env, stack);
    } else if (node.property.type === 'Identifier') {
      key = node.property.name;
    }
    if (
      key === undefined ||
      key === null ||
      (typeof key !== 'string' && typeof key !== 'number')
    ) {
      return null;
    }

    return {
      path: [...parent.path, key],
    };
  };

  const pathInfo = resolvePath(
    mutation.type === 'AssignmentExpression' ? mutation.left : mutation.argument
  );
  if (!pathInfo) {
    return undefined;
  }

  const cloned = cloneStaticValue(baseValue);
  if (pathInfo.path.length === 0) {
    if (mutation.type !== 'AssignmentExpression') {
      return undefined;
    }

    return evaluateStatic(mutation.right, ctx, env, stack);
  }

  let target = cloned as Record<string | number, unknown>;
  for (let idx = 0; idx < pathInfo.path.length - 1; idx += 1) {
    const key = pathInfo.path[idx];
    const next = target?.[key];
    if (typeof next !== 'object' || next === null) {
      return undefined;
    }

    target = next as Record<string | number, unknown>;
  }

  const lastKey = pathInfo.path[pathInfo.path.length - 1]!;
  if (mutation.type === 'AssignmentExpression') {
    const nextValue = evaluateStatic(mutation.right, ctx, env, stack);
    if (nextValue === undefined) {
      return undefined;
    }

    target[lastKey] = nextValue;
    return cloned;
  }

  const currentValue = target[lastKey];
  if (typeof currentValue !== 'number') {
    return undefined;
  }

  target[lastKey] =
    mutation.operator === '++' ? currentValue + 1 : currentValue - 1;
  return cloned;
};

const collectHoistedVarNames = (
  node: Node,
  names = new Set<string>(),
  root = node
): Set<string> => {
  if (
    node !== root &&
    (node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression')
  ) {
    return names;
  }

  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    node.declarations.forEach((declarator) => {
      collectOxcPatternBindingNames(declarator.id).forEach((name) =>
        names.add(name)
      );
    });
  }

  getOxcNodeChildren(node).forEach((child) =>
    collectHoistedVarNames(child, names, root)
  );
  return names;
};

const prepareFunctionBodyEnvironment = (
  fn: OxcFunctionLikeNode,
  env: EvalEnv
): void => {
  if (fn.body?.type !== 'BlockStatement') {
    return;
  }

  collectHoistedVarNames(fn.body).forEach((name) => {
    if (!env.has(name)) {
      env.set(name, undefined);
    }
  });

  fn.body.body.forEach((statement) => {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      statement.declarations.forEach((declarator) => {
        collectOxcPatternBindingNames(declarator.id).forEach((name) => {
          env.set(name, uninitializedStaticBinding);
        });
      });
      return;
    }

    if (statement.type === 'FunctionDeclaration' && statement.id) {
      env.set(statement.id.name, createOxcStaticFunctionValue(statement));
    }
  });
};

const evaluateFunctionCall = (
  fn: OxcFunctionLikeNode,
  args: unknown[],
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[]
): unknown | undefined => {
  if (fn.async || !fn.body) {
    return undefined;
  }

  const localEnv = new Map(env);
  if (fn.id) {
    localEnv.set(fn.id.name, createOxcStaticFunctionValue(fn));
  }
  fn.params.forEach((param) => {
    collectOxcPatternBindingNames(param).forEach((name) => {
      localEnv.set(name, uninitializedStaticBinding);
    });
  });
  for (let idx = 0; idx < fn.params.length; idx += 1) {
    if (!assignPatternValue(fn.params[idx], args[idx], ctx, localEnv, stack)) {
      return undefined;
    }
  }

  if (fn.body.type !== 'BlockStatement') {
    return evaluateStatic(fn.body as Expression, ctx, localEnv, stack);
  }

  prepareFunctionBodyEnvironment(fn, localEnv);

  for (const statement of fn.body.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        const value = declarator.init
          ? evaluateStatic(declarator.init, ctx, localEnv, stack)
          : undefined;
        if (
          declarator.init &&
          value === undefined &&
          !isDeterministicUndefinedExpression(declarator.init, ctx, localEnv)
        ) {
          return undefined;
        }
        if (!assignPatternValue(declarator.id, value, ctx, localEnv, stack)) {
          return undefined;
        }
      }
      continue;
    }

    if (statement.type === 'FunctionDeclaration') {
      continue;
    }

    if (statement.type === 'ReturnStatement') {
      if (!statement.argument) {
        return undefined;
      }

      return evaluateStatic(statement.argument, ctx, localEnv, stack);
    }

    return undefined;
  }

  return undefined;
};

const isProcessEnvMember = (node: Node): node is MemberExpression => {
  if (node.type !== 'MemberExpression' || node.computed) {
    return false;
  }

  if (node.property.type !== 'Identifier' || node.property.name !== 'env') {
    return false;
  }

  return node.object.type === 'Identifier' && node.object.name === 'process';
};

const isProcessEnvValueAccess = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv
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

const isDeterministicUndefinedExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv
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

const isCoercionFreePrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== 'object' && typeof value !== 'function');

const evaluateStringConversion = (value: unknown): string | undefined =>
  isCoercionFreePrimitive(value) ? String(value) : undefined;

const evaluateNumberConversion = (value: unknown): number | undefined => {
  if (!isCoercionFreePrimitive(value) || typeof value === 'symbol') {
    return undefined;
  }
  try {
    return Number(value);
  } catch {
    return undefined;
  }
};

const evaluateBinary = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: string[] = []
): unknown | undefined => {
  if (expression.type !== 'BinaryExpression') {
    return undefined;
  }

  const left = evaluateStatic(expression.left as Expression, ctx, env, stack);
  const right = evaluateStatic(expression.right as Expression, ctx, env, stack);

  const leftIsDeterministicUndefined =
    left === undefined &&
    isDeterministicUndefinedExpression(expression.left as Expression, ctx, env);
  const rightIsDeterministicUndefined =
    right === undefined &&
    isDeterministicUndefinedExpression(
      expression.right as Expression,
      ctx,
      env
    );

  if (
    (left === undefined && !leftIsDeterministicUndefined) ||
    (right === undefined && !rightIsDeterministicUndefined)
  ) {
    return undefined;
  }

  const comparesDistinctReferences =
    left !== right &&
    left !== null &&
    right !== null &&
    (typeof left === 'object' || typeof left === 'function') &&
    (typeof right === 'object' || typeof right === 'function');
  if (
    comparesDistinctReferences &&
    (expression.operator === '===' ||
      expression.operator === '!==' ||
      expression.operator === '==' ||
      expression.operator === '!=')
  ) {
    // Static export loading and local snapshot reconstruction can clone an
    // object graph. A false identity result is therefore not proof that the
    // runtime references are distinct.
    return undefined;
  }

  switch (expression.operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '==':
      if (!isCoercionFreePrimitive(left) || !isCoercionFreePrimitive(right)) {
        return undefined;
      }
      // eslint-disable-next-line eqeqeq
      return left == right;
    case '!=':
      if (!isCoercionFreePrimitive(left) || !isCoercionFreePrimitive(right)) {
        return undefined;
      }
      // eslint-disable-next-line eqeqeq
      return left != right;
    default:
      break;
  }

  if (expression.operator === '+') {
    if (typeof left === 'number' && typeof right === 'number') {
      return left + right;
    }

    if (
      (typeof left === 'string' || typeof left === 'number') &&
      (typeof right === 'string' || typeof right === 'number')
    ) {
      return `${left}${right}`;
    }
  }

  if (typeof left === 'number' && typeof right === 'number') {
    switch (expression.operator) {
      case '<':
        return left < right;
      case '<=':
        return left <= right;
      case '>':
        return left > right;
      case '>=':
        return left >= right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return left / right;
      case '%':
        return left % right;
      case '**':
        return left ** right;
      default:
        break;
    }
  }

  return undefined;
};

export const evaluateStatic = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: string[] = []
): unknown | undefined => {
  if (
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TSInstantiationExpression' ||
    expression.type === 'TSTypeAssertion' ||
    expression.type === 'ParenthesizedExpression'
  ) {
    return evaluateStatic(expression.expression as Expression, ctx, env, stack);
  }

  if (expression.type === 'Literal') {
    return expression.value;
  }

  if (expression.type === 'UnaryExpression') {
    if (expression.operator === 'typeof') {
      const argIsProcessEnvAccess = isProcessEnvValueAccess(
        expression.argument as Expression,
        ctx,
        env
      );
      // `typeof someIdentifier` is the canonical undeclared-global
      // probe — it returns 'undefined' regardless of whether the
      // symbol is declared. Only fold truly unbound identifiers: declared
      // but dynamic locals still have runtime values we cannot infer.
      const argIsUnboundBareIdentifier =
        expression.argument.type === 'Identifier' &&
        !resolveBindingAt(
          ctx,
          expression.argument.name,
          expression.argument.start
        );
      const argExpression = expression.argument as Expression;
      const arg = evaluateStatic(argExpression, ctx, env, stack);
      if (arg === undefined) {
        return argIsProcessEnvAccess ||
          argIsUnboundBareIdentifier ||
          isDeterministicUndefinedExpression(argExpression, ctx, env)
          ? 'undefined'
          : undefined;
      }

      return typeof arg;
    }

    const arg = evaluateStatic(
      expression.argument as Expression,
      ctx,
      env,
      stack
    );
    if (arg === undefined) {
      return undefined;
    }

    switch (expression.operator) {
      case '-':
        return typeof arg === 'number' ? -arg : undefined;
      case '+':
        return typeof arg === 'number' ? +arg : undefined;
      case '!':
        return !arg;
      case '~':
        return typeof arg === 'number' ? bitwiseNot(arg) : undefined;
      case 'void':
        return undefined;
      default:
        return undefined;
    }
  }

  if (expression.type === 'LogicalExpression') {
    const left = evaluateStatic(expression.left, ctx, env, stack);
    // Runtime `undefined` is only trusted for explicitly modeled sources
    // (build-time process.env, initialized env entries, and hoisted var).
    // Otherwise it means evaluation failed and must not select a fallback.
    const leftIsDeterministicUndefined = isDeterministicUndefinedExpression(
      expression.left,
      ctx,
      env
    );

    if (left === undefined && !leftIsDeterministicUndefined) {
      return undefined;
    }

    if (expression.operator === '||') {
      return left || evaluateStatic(expression.right, ctx, env, stack);
    }

    if (expression.operator === '??') {
      return left ?? evaluateStatic(expression.right, ctx, env, stack);
    }

    if (expression.operator === '&&') {
      return left && evaluateStatic(expression.right, ctx, env, stack);
    }

    return undefined;
  }

  if (expression.type === 'ConditionalExpression') {
    const test = evaluateStatic(expression.test, ctx, env, stack);
    if (test === undefined) {
      return undefined;
    }

    return evaluateStatic(
      test ? expression.consequent : expression.alternate,
      ctx,
      env,
      stack
    );
  }

  if (expression.type === 'TemplateLiteral') {
    let result = '';

    for (let idx = 0; idx < expression.quasis.length; idx += 1) {
      result += expression.quasis[idx]?.value.cooked ?? '';

      const nextExpression = expression.expressions[idx];
      if (!nextExpression) {
        continue;
      }

      const value = evaluateStatic(nextExpression, ctx, env, stack);
      if (
        value === undefined ||
        (typeof value !== 'string' && typeof value !== 'number')
      ) {
        return undefined;
      }

      result += String(value);
    }

    return result;
  }

  if (expression.type === 'Identifier') {
    const binding = resolveBindingAt(ctx, expression.name, expression.start);
    if (
      binding?.kind === 'variable' &&
      binding.declarator &&
      ctx.currentExpressionStart < binding.declarator.end
    ) {
      return undefined;
    }

    if (env.has(expression.name)) {
      const envValue = env.get(expression.name);
      if (envValue === uninitializedStaticBinding) {
        return undefined;
      }

      if (
        binding?.importedFrom &&
        hasBindingMutationBefore(binding, ctx.currentExpressionStart, ctx)
      ) {
        return undefined;
      }

      return unwrapOxcStaticCallableValue(envValue);
    }

    if (binding?.importedFrom) {
      if (hasBindingMutationBefore(binding, ctx.currentExpressionStart, ctx)) {
        return undefined;
      }

      // staticBindings can supply a literal value for an imported name,
      // bypassing whatever the source module would otherwise resolve to.
      // Function values are deferred to the CallExpression branch.
      const override = lookupStaticBinding(
        ctx.staticBindings,
        binding.importedFrom,
        binding.imported
      );
      if (override.found && typeof override.value !== 'function') {
        return override.value;
      }
      return undefined;
    }
    if (!binding) {
      return undefined;
    }

    if (binding.kind === 'param') {
      return undefined;
    }

    const bindingKey = toMutationBindingKey(binding);
    const bindingMutations = ctx.rootMutationsByBinding.get(bindingKey) ?? [];
    const bindingMutationHazards = getRootMutationHazards(
      ctx.rootMutationHazardsByBinding,
      bindingKey
    );
    const bindingHasChanges =
      bindingMutations.length > 0 || bindingMutationHazards.length > 0;

    if (
      bindingHasChanges &&
      hasLexicalPreDeclarationChange(
        binding,
        ctx,
        bindingMutations,
        bindingMutationHazards
      )
    ) {
      return undefined;
    }

    const { declarator } = binding;
    const init = declarator?.init;
    const valueCacheKey = init
      ? bindingValueCacheKey(
          binding,
          ctx,
          bindingMutations,
          bindingMutationHazards
        )
      : null;
    if (valueCacheKey && env.has(valueCacheKey)) {
      return env.get(valueCacheKey);
    }

    if (stack.includes(binding.name)) {
      return undefined;
    }

    let value: unknown | undefined;
    if (init) {
      const nextStack = [...stack, binding.name];
      if (declarator.id.type === 'Identifier') {
        if (
          hasReferencedRootMutationHazardBefore(
            init,
            ctx.currentExpressionStart,
            ctx,
            declarator
          )
        ) {
          return undefined;
        }
        value = evaluateStatic(init, ctx, env, nextStack);
      } else {
        if (
          binding.declarationKind !== 'const' ||
          expression.start < declarator.end ||
          hasReferencedRootMutationHazardBefore(init, declarator.start, ctx)
        ) {
          return undefined;
        }

        const snapshotCtx: ExtractionContext = {
          ...ctx,
          currentExpressionStart: declarator.start,
        };
        const patternRuntimeExpressions = collectOxcPatternRuntimeExpressions(
          declarator.id
        );
        if (
          patternRuntimeExpressions.some(
            (runtimeExpression) =>
              !isPatternRuntimeExpressionStable(
                runtimeExpression,
                declarator,
                snapshotCtx,
                env
              ) ||
              hasReferencedRootMutationHazardBefore(
                runtimeExpression,
                declarator.start,
                ctx
              )
          )
        ) {
          return undefined;
        }

        const initialValue = evaluateStatic(init, snapshotCtx, env, nextStack);
        if (initialValue === undefined) {
          return undefined;
        }

        const patternBindingNames = collectOxcPatternBindingNames(
          declarator.id
        );
        const patternEnv = new Map(env);
        patternBindingNames.forEach((name) => {
          patternEnv.set(name, uninitializedStaticBinding);
        });
        if (
          !assignPatternValue(
            declarator.id,
            initialValue,
            snapshotCtx,
            patternEnv,
            nextStack
          ) ||
          !patternEnv.has(binding.name)
        ) {
          return undefined;
        }

        value = patternEnv.get(binding.name);
        const sourceChangedAfterDestructuring =
          hasReferencedRootMutationBetween(
            init,
            declarator.end,
            ctx.currentExpressionStart,
            ctx
          ) ||
          patternRuntimeExpressions.some((runtimeExpression) =>
            hasReferencedRootMutationBetween(
              runtimeExpression,
              declarator.end,
              ctx.currentExpressionStart,
              ctx
            )
          );
        if (
          typeof value === 'object' &&
          value !== null &&
          (sourceChangedAfterDestructuring ||
            hasBindingMutationHazardBetween(
              binding,
              declarator.end,
              ctx.currentExpressionStart,
              ctx
            ))
        ) {
          return undefined;
        }

        patternBindingNames.forEach((name) => {
          const siblingBinding = ctx.bindingsByName
            .get(name)
            ?.find((candidate) => candidate.declarator === declarator);
          const siblingValue = patternEnv.get(name);
          const siblingHasChanges =
            !!siblingBinding &&
            ((ctx.rootMutationsByBinding.get(
              toMutationBindingKey(siblingBinding)
            )?.length ?? 0) > 0 ||
              getBindingMutationHazards(siblingBinding, ctx).length > 0);
          if (
            siblingBinding &&
            patternEnv.has(name) &&
            !siblingHasChanges &&
            !(
              typeof siblingValue === 'object' &&
              siblingValue !== null &&
              sourceChangedAfterDestructuring
            )
          ) {
            env.set(bindingValueCacheKey(siblingBinding, ctx), siblingValue);
          }
        });
      }
    } else if (binding.functionNode) {
      value = createOxcStaticFunctionValue(binding.functionNode);
    }

    if (value !== undefined && !bindingHasChanges) {
      if (valueCacheKey) {
        env.set(valueCacheKey, value);
      }
      return value;
    }

    const priorMutations = bindingMutations.filter(
      (mutation) => mutation.start < ctx.currentExpressionStart
    );
    const replayedMutationNodes = new Set<Node>(priorMutations);
    const priorMutationHazards = bindingMutationHazards.filter(
      (hazard) =>
        !isKnownPureStaticCall(hazard, ctx) &&
        !replayedMutationNodes.has(hazard) &&
        hazard.end <= ctx.currentExpressionStart
    );
    const priorDirectMutationHazards = priorMutationHazards.filter((hazard) =>
      mutationDirectlyTargetsBinding(hazard, binding, ctx)
    );
    if (
      value !== undefined &&
      (typeof value !== 'object' || value === null) &&
      (priorMutations.length > 0 || priorDirectMutationHazards.length > 0)
    ) {
      return undefined;
    }

    if (
      value !== undefined &&
      typeof value === 'object' &&
      value !== null &&
      declarator?.id.type === 'Identifier' &&
      priorMutationHazards.length > 0
    ) {
      return undefined;
    }

    if (
      value !== undefined &&
      binding.isRoot &&
      typeof value === 'object' &&
      value !== null
    ) {
      if (priorMutations.length === 0) {
        if (valueCacheKey) {
          env.set(valueCacheKey, value);
        }
        return value;
      }

      let nextValue = cloneStaticValue(value);
      for (const mutation of priorMutations) {
        const applied = applyRootMutation(
          binding.name,
          nextValue,
          mutation,
          ctx,
          env,
          [...stack, binding.name]
        );
        if (applied === undefined) {
          return undefined;
        }

        nextValue = applied;
      }

      if (valueCacheKey) {
        env.set(valueCacheKey, nextValue);
      }
      return nextValue;
    }

    if (valueCacheKey && value !== undefined) {
      env.set(valueCacheKey, value);
    }
    return value;
  }

  if (expression.type === 'ObjectExpression') {
    const result: Record<string, unknown> = {};

    for (const property of expression.properties) {
      if (property.type === 'SpreadElement') {
        const spreadValue = evaluateStatic(property.argument, ctx, env, stack);
        if (typeof spreadValue !== 'object' || spreadValue === null) {
          return undefined;
        }

        if (!copyEnumerableOwnDataProperties(result, spreadValue)) {
          return undefined;
        }
        continue;
      }

      let key: unknown;
      if (property.computed) {
        key = evaluateStatic(property.key as Expression, ctx, env, stack);
      } else if (property.key.type === 'Identifier') {
        key = property.key.name;
      } else if (property.key.type === 'Literal') {
        key = property.key.value;
      }
      if (
        key === undefined ||
        key === null ||
        (typeof key !== 'string' && typeof key !== 'number')
      ) {
        return undefined;
      }

      const value = evaluateStatic(property.value, ctx, env, stack);
      if (value === undefined) {
        return undefined;
      }

      const isPrototypeSetter =
        !property.computed &&
        !property.shorthand &&
        !property.method &&
        key === '__proto__';
      if (isPrototypeSetter) {
        if ((typeof value === 'object' && value !== null) || value === null) {
          try {
            Object.setPrototypeOf(result, value);
          } catch {
            return undefined;
          }
        }
        continue;
      }

      if (!defineStaticDataProperty(result, key, value)) {
        return undefined;
      }
    }

    return result;
  }

  if (expression.type === 'ArrayExpression') {
    const result: unknown[] = [];

    for (const element of expression.elements) {
      if (!element) {
        return undefined;
      }

      if (element.type === 'SpreadElement') {
        const spreadValue = evaluateStatic(element.argument, ctx, env, stack);
        if (isStaticProxy(spreadValue) || !Array.isArray(spreadValue)) {
          return undefined;
        }

        if (!appendDefaultArrayElements(result, spreadValue, ctx)) {
          return undefined;
        }
        continue;
      }

      const value = evaluateStatic(element, ctx, env, stack);
      if (value === undefined) {
        return undefined;
      }

      result.push(value);
    }

    return result;
  }

  if (expression.type === 'MemberExpression') {
    let key: unknown;
    if (expression.computed) {
      key = evaluateStatic(expression.property as Expression, ctx, env, stack);
    } else if (expression.property.type === 'Identifier') {
      key = expression.property.name;
    }
    if (
      key === undefined ||
      key === null ||
      (typeof key !== 'string' && typeof key !== 'number')
    ) {
      return undefined;
    }

    if (
      isProcessEnvValueAccess(expression, ctx, env) &&
      typeof key === 'string'
    ) {
      // Treat process.env.X as deterministically undefined at build time.
      // Reading from real process.env would couple the bundle to whatever
      // happens to be set on the build machine; falling back to the
      // ?? / || branch (or a runtime read) is more predictable.
      return undefined;
    }

    const knownObjectMember = evaluateKnownObjectMember(
      expression.object as Expression,
      key,
      ctx,
      env,
      stack
    );
    if (knownObjectMember !== undefined) {
      return knownObjectMember;
    }

    const objectValue = evaluateStatic(expression.object, ctx, env, stack);
    if (objectValue === undefined) {
      return undefined;
    }

    return getObjectMember(objectValue, key);
  }

  if (expression.type === 'NewExpression') {
    if (
      expression.callee.type !== 'Identifier' ||
      expression.arguments.length !== 1
    ) {
      return undefined;
    }

    const [argument] = expression.arguments;
    if (!argument || argument.type === 'SpreadElement') {
      return undefined;
    }

    if (
      env.has(expression.callee.name) ||
      resolveBindingAt(ctx, expression.callee.name, expression.callee.start)
    ) {
      return undefined;
    }

    // Wrapper constructors produce identity-bearing objects. Returning the
    // primitive conversion here changes both value identity and `typeof`, and
    // converting an object argument could execute user coercion hooks.
    return undefined;
  }

  if (expression.type === 'CallExpression') {
    let inlineCallee: Node = expression.callee;
    while (
      inlineCallee.type === 'ParenthesizedExpression' ||
      inlineCallee.type === 'TSAsExpression' ||
      inlineCallee.type === 'TSSatisfiesExpression' ||
      inlineCallee.type === 'TSNonNullExpression' ||
      inlineCallee.type === 'TSInstantiationExpression' ||
      inlineCallee.type === 'TSTypeAssertion'
    ) {
      inlineCallee = inlineCallee.expression as Node;
    }

    if (isDestructuringProjection(inlineCallee)) {
      const args = expression.arguments.map((arg) =>
        arg.type === 'SpreadElement'
          ? undefined
          : evaluateStatic(arg, ctx, env, stack)
      );
      if (args.some((value) => value === undefined)) {
        return undefined;
      }

      return evaluateFunctionCall(inlineCallee, args, ctx, env, [
        ...stack,
        `<inline:${inlineCallee.start}>`,
      ]);
    }

    if (expression.callee.type === 'Identifier') {
      const binding = resolveBindingAt(
        ctx,
        expression.callee.name,
        expression.callee.start
      );
      const args = expression.arguments.map((arg) =>
        arg.type === 'SpreadElement'
          ? undefined
          : evaluateStatic(arg, ctx, env, stack)
      );
      if (args.some((value) => value === undefined)) {
        return undefined;
      }

      if (
        binding &&
        hasDirectBindingMutationBefore(binding, expression.start, ctx)
      ) {
        return undefined;
      }

      const staticCallable = env.get(expression.callee.name);
      if (isOxcStaticFunctionValue(staticCallable)) {
        return evaluateFunctionCall(
          staticCallable[oxcStaticFunctionNode],
          args,
          ctx,
          env,
          [...stack, expression.callee.name]
        );
      }
      if (
        isOxcStaticCallableValue(staticCallable) &&
        expression.arguments.length === 0
      ) {
        return unwrapOxcStaticCallableValue(staticCallable);
      }

      // Plain function in env (e.g. supplied via staticBindings as a
      // pure helper). Invoke with already-evaluated args.
      if (
        typeof staticCallable === 'function' &&
        !isStaticProxy(staticCallable)
      ) {
        try {
          return (staticCallable as (...a: unknown[]) => unknown)(...args);
        } catch {
          return undefined;
        }
      }

      const canUseIntrinsic = !binding && !env.has(expression.callee.name);
      if (
        canUseIntrinsic &&
        expression.callee.name === 'String' &&
        args.length === 1
      ) {
        return evaluateStringConversion(args[0]);
      }

      if (
        canUseIntrinsic &&
        expression.callee.name === 'Number' &&
        args.length === 1
      ) {
        return evaluateNumberConversion(args[0]);
      }

      if (
        canUseIntrinsic &&
        expression.callee.name === 'Boolean' &&
        args.length === 1
      ) {
        return Boolean(args[0]);
      }

      // staticBindings can register a pure helper for an imported name
      // (e.g. linaria's `cx` from '@linaria/core'). When the callee
      // resolves to such an import and every arg evaluated, invoke the
      // helper and return its result as a static value.
      if (binding?.importedFrom) {
        const override = lookupStaticBinding(
          ctx.staticBindings,
          binding.importedFrom,
          binding.imported
        );
        if (override.found && typeof override.value === 'function') {
          try {
            return (override.value as (...a: unknown[]) => unknown)(...args);
          } catch {
            return undefined;
          }
        }
      }

      const fn = binding?.functionNode ?? binding?.declarator?.init;
      if (
        fn &&
        (fn.type === 'ArrowFunctionExpression' ||
          fn.type === 'FunctionDeclaration' ||
          fn.type === 'FunctionExpression')
      ) {
        return evaluateFunctionCall(fn, args, ctx, env, [
          ...stack,
          expression.callee.name,
        ]);
      }
    }

    if (expression.callee.type === 'MemberExpression') {
      const objectValue = evaluateStatic(
        expression.callee.object,
        ctx,
        env,
        stack
      );
      let key: unknown;
      if (expression.callee.computed) {
        key = evaluateStatic(
          expression.callee.property as Expression,
          ctx,
          env,
          stack
        );
      } else if (expression.callee.property.type === 'Identifier') {
        key = expression.callee.property.name;
      }
      if (typeof objectValue === 'string') {
        if (
          key === 'toLowerCase' &&
          expression.arguments.length === 0 &&
          !hasStringPrototypeMutationBefore(ctx.currentExpressionStart, ctx)
        ) {
          return objectValue.toLowerCase();
        }

        if (
          key === 'toUpperCase' &&
          expression.arguments.length === 0 &&
          !hasStringPrototypeMutationBefore(ctx.currentExpressionStart, ctx)
        ) {
          return objectValue.toUpperCase();
        }
      }
    }
  }

  return evaluateBinary(expression, ctx, env, stack);
};
