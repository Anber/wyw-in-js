import type { Node } from 'oxc-parser';

import { isOxcNode } from '../oxc/ast';
import { unwrapOxcRuntimeExpression } from '../oxc/runtimeSemantics';

type AnyNode = Node & Record<string, unknown>;

const unwrapAliasExpression = (node: Node): Node =>
  unwrapOxcRuntimeExpression(node, true);

export type ReceiverOperation = {
  kind: 'copy' | 'delete' | 'get' | 'has' | 'iterate' | 'ownKeys' | 'set';
  property?: {
    computed: boolean;
    key: Node;
  };
  receiver: Node;
};

export type PatternInitializerResolver = (
  name: string
) => Node | null | undefined;

export const isPattern = (
  node: Node
): node is Extract<Node, { type: 'ArrayPattern' | 'ObjectPattern' }> =>
  node.type === 'ArrayPattern' || node.type === 'ObjectPattern';

const isLiteralConstructionSideEffectFree = (node: Node): boolean => {
  const current = unwrapAliasExpression(node);
  if (
    current.type === 'Literal' ||
    current.type === 'FunctionExpression' ||
    current.type === 'ArrowFunctionExpression'
  ) {
    return true;
  }

  if (current.type === 'ArrayExpression') {
    return current.elements.every(
      (element) =>
        !element ||
        (element.type !== 'SpreadElement' &&
          isLiteralConstructionSideEffectFree(element))
    );
  }

  if (current.type === 'ObjectExpression') {
    return current.properties.every((property) => {
      if (property.type === 'SpreadElement') {
        return false;
      }

      const staticKey =
        (!property.computed && property.key.type === 'Identifier') ||
        property.key.type === 'Literal';
      return staticKey && isLiteralConstructionSideEffectFree(property.value);
    });
  }

  return false;
};

const getStaticPatternPropertyName = (property: Node): string | null => {
  if (property.type === 'RestElement') {
    return null;
  }

  const candidate = property as AnyNode;
  const { key } = candidate;
  if (!isOxcNode(key)) {
    return null;
  }
  if (candidate.computed !== true && key.type === 'Identifier') {
    return key.name;
  }
  return key.type === 'Literal' ? String(key.value) : null;
};

const getStaticObjectProperty = (
  object: Extract<Node, { type: 'ObjectExpression' }>,
  name: string
): Exclude<
  (typeof object.properties)[number],
  { type: 'SpreadElement' }
> | null => {
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index]!;
    if (
      property.type !== 'SpreadElement' &&
      getStaticPatternPropertyName(property) === name
    ) {
      return property;
    }
  }
  return null;
};

type ReceiverProofContext = {
  arrayPrototypeStable: boolean;
  objectPrototypeStable: boolean;
  resolveInitializer: PatternInitializerResolver;
};

const resolveReceiverPropertyName = (
  property: NonNullable<ReceiverOperation['property']>,
  context: ReceiverProofContext,
  resolving = new Set<Node>()
): string | null => {
  const current = unwrapAliasExpression(property.key);
  if (!property.computed && current.type === 'Identifier') {
    return current.name;
  }
  if (current.type === 'Literal') {
    return String(current.value);
  }
  if (current.type !== 'Identifier') {
    return null;
  }

  const initializer = context.resolveInitializer(current.name);
  if (!initializer || resolving.has(initializer)) {
    return null;
  }
  resolving.add(initializer);
  try {
    return resolveReceiverPropertyName(
      { computed: true, key: initializer },
      context,
      resolving
    );
  } finally {
    resolving.delete(initializer);
  }
};

type PlainReceiver =
  | Extract<Node, { type: 'ArrayExpression' }>
  | Extract<Node, { type: 'ObjectExpression' }>;

const getPlainObjectProperty = (
  object: Extract<Node, { type: 'ObjectExpression' }>,
  name: string,
  context: ReceiverProofContext
):
  | Exclude<(typeof object.properties)[number], { type: 'SpreadElement' }>
  | null
  | undefined => {
  for (let index = object.properties.length - 1; index >= 0; index -= 1) {
    const property = object.properties[index]!;
    if (property.type === 'SpreadElement') {
      return undefined;
    }

    const propertyName = resolveReceiverPropertyName(
      {
        computed: property.computed,
        key: property.key,
      },
      context
    );
    if (propertyName === null) {
      return undefined;
    }
    if (propertyName === name) {
      return property;
    }
  }
  return null;
};

const hasCustomObjectPrototype = (
  object: Extract<Node, { type: 'ObjectExpression' }>
): boolean =>
  object.properties.some((property) => {
    if (property.type === 'SpreadElement') {
      return false;
    }
    const candidate = property as AnyNode;
    return (
      property.computed !== true &&
      property.kind === 'init' &&
      candidate.method !== true &&
      candidate.shorthand !== true &&
      ((property.key.type === 'Identifier' &&
        property.key.name === '__proto__') ||
        (property.key.type === 'Literal' &&
          property.key.value === '__proto__')) &&
      !(property.value.type === 'Literal' && property.value.value === null)
    );
  });

const resolvePlainReceiver = (
  value: Node,
  context: ReceiverProofContext,
  resolving = new Set<Node>()
): PlainReceiver | null => {
  const current = unwrapAliasExpression(value);
  if (
    current.type === 'ArrayExpression' ||
    current.type === 'ObjectExpression'
  ) {
    return current;
  }

  if (current.type === 'Identifier') {
    const initializer = context.resolveInitializer(current.name);
    if (!initializer || resolving.has(initializer)) {
      return null;
    }
    resolving.add(initializer);
    try {
      return resolvePlainReceiver(initializer, context, resolving);
    } finally {
      resolving.delete(initializer);
    }
  }

  if (current.type !== 'MemberExpression') {
    return null;
  }

  const receiver = resolvePlainReceiver(current.object, context, resolving);
  const propertyName = resolveReceiverPropertyName(
    {
      computed: current.computed,
      key: current.property,
    },
    context
  );
  if (!receiver || propertyName === null) {
    return null;
  }

  let propertyValue: Node | null = null;
  if (receiver.type === 'ObjectExpression') {
    const property = getPlainObjectProperty(receiver, propertyName, context);
    if (!property || property.kind !== 'init') {
      return null;
    }
    propertyValue = property.value;
  } else {
    const index = /^(?:0|[1-9]\d*)$/.test(propertyName)
      ? Number(propertyName)
      : null;
    const element = index === null ? null : receiver.elements[index];
    if (!element || element.type === 'SpreadElement') {
      return null;
    }
    propertyValue = element;
  }

  if (resolving.has(propertyValue)) {
    return null;
  }
  resolving.add(propertyValue);
  try {
    return resolvePlainReceiver(propertyValue, context, resolving);
  } finally {
    resolving.delete(propertyValue);
  }
};

export const isReceiverOperationProvenInert = (
  operation: ReceiverOperation,
  context: ReceiverProofContext
): boolean => {
  const receiver = resolvePlainReceiver(operation.receiver, context);
  if (!receiver) {
    return false;
  }

  if (operation.kind === 'ownKeys') {
    return true;
  }

  if (operation.kind === 'iterate') {
    return (
      receiver.type === 'ArrayExpression' &&
      context.arrayPrototypeStable &&
      context.objectPrototypeStable &&
      receiver.elements.every(
        (element) => !element || element.type !== 'SpreadElement'
      )
    );
  }

  if (operation.kind === 'copy') {
    if (receiver.type === 'ArrayExpression') {
      return receiver.elements.every(
        (element) => !element || element.type !== 'SpreadElement'
      );
    }
    return receiver.properties.every(
      (property) =>
        property.type !== 'SpreadElement' && property.kind === 'init'
    );
  }

  if (!operation.property) {
    return false;
  }
  const propertyName = resolveReceiverPropertyName(operation.property, context);
  if (propertyName === null) {
    return false;
  }

  if (receiver.type === 'ObjectExpression') {
    const property = getPlainObjectProperty(receiver, propertyName, context);
    if (property === undefined) {
      return false;
    }
    if (operation.kind === 'delete') {
      return true;
    }
    if (property) {
      return property.kind === 'init';
    }
    return !hasCustomObjectPrototype(receiver) && context.objectPrototypeStable;
  }

  if (operation.kind === 'delete') {
    return true;
  }
  if (propertyName === 'length') {
    return operation.kind !== 'set';
  }
  const index = /^(?:0|[1-9]\d*)$/.test(propertyName)
    ? Number(propertyName)
    : null;
  if (
    index !== null &&
    receiver.elements[index] &&
    receiver.elements[index]?.type !== 'SpreadElement'
  ) {
    return true;
  }
  return context.arrayPrototypeStable && context.objectPrototypeStable;
};

export function isProvenNonAbruptPatternEvaluation(
  pattern: Node,
  value: Node,
  resolveInitializer: PatternInitializerResolver,
  resolving: Set<Node> = new Set()
): boolean {
  const currentPattern = unwrapAliasExpression(pattern);
  const currentValue = unwrapAliasExpression(value);
  const isProvenTarget = (target: Node, targetValue: Node | null): boolean => {
    const current = unwrapAliasExpression(target);
    if (current.type === 'Identifier' || current.type === 'MemberExpression') {
      return true;
    }
    if (current.type === 'RestElement') {
      return isProvenTarget(current.argument, targetValue);
    }
    if (current.type === 'AssignmentPattern' || !targetValue) {
      return false;
    }

    return isProvenNonAbruptPatternEvaluation(
      current,
      targetValue,
      resolveInitializer,
      resolving
    );
  };

  if (currentValue.type === 'Identifier') {
    const resolved = resolveInitializer(currentValue.name);
    if (resolved === undefined) {
      return true;
    }
    if (!resolved || resolving.has(resolved)) {
      return false;
    }
    resolving.add(resolved);
    try {
      return isProvenNonAbruptPatternEvaluation(
        currentPattern,
        resolved,
        resolveInitializer,
        resolving
      );
    } finally {
      resolving.delete(resolved);
    }
  }

  if (!isLiteralConstructionSideEffectFree(currentValue)) {
    return false;
  }

  if (currentPattern.type === 'ObjectPattern') {
    if (currentValue.type !== 'ObjectExpression') {
      return false;
    }

    return currentPattern.properties.every((property) => {
      if (property.type === 'RestElement') {
        return (
          currentValue.properties.every(
            (candidate) =>
              candidate.type !== 'SpreadElement' && candidate.kind === 'init'
          ) && isProvenTarget(property.argument, currentValue)
        );
      }

      const propertyName = getStaticPatternPropertyName(property);
      if (propertyName === null) {
        return false;
      }
      const sourceProperty = getStaticObjectProperty(
        currentValue,
        propertyName
      );
      if (sourceProperty && sourceProperty.kind !== 'init') {
        return false;
      }
      return isProvenTarget(property.value, sourceProperty?.value ?? null);
    });
  }

  if (currentPattern.type === 'ArrayPattern') {
    if (currentValue.type !== 'ArrayExpression') {
      return false;
    }

    return currentPattern.elements.every((element, index) => {
      if (!element) {
        return true;
      }
      if (element.type === 'RestElement') {
        return isProvenTarget(element.argument, currentValue);
      }
      const sourceElement = currentValue.elements[index];
      return isProvenTarget(
        element,
        sourceElement && sourceElement.type !== 'SpreadElement'
          ? sourceElement
          : null
      );
    });
  }

  return false;
}
