/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define,@typescript-eslint/default-param-last */

import type {
  AssignmentExpression,
  Expression,
  Node,
  UpdateExpression,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import { resolveBindingAt, toMutationBindingKey } from './scopeAnalysis';
import {
  getBindingMutationHazards,
  hasArrayIterationMutationBefore,
  hasRelevantIntrinsicMutationBefore,
  isDeterministicUndefinedExpression,
} from './staticEvaluationSafety';
import {
  cloneStaticValue,
  defineStaticDataProperty,
  hasDefaultArrayIterator,
  hasExactPrototype,
  hasOnlyDataProperties,
  isStaticProxy,
  readArrayProjectionElement,
  readObjectProjectionProperty,
  readOwnDataProperty,
} from './staticValues';
import type { Binding, ExtractionContext, OxcFunctionLikeNode } from './types';

type EvaluateStatic = (
  expression: Expression,
  ctx: ExtractionContext,
  env?: EvalEnv,
  stack?: string[]
) => unknown | undefined;

type IsKnownPureStaticCall = (node: Node, ctx: ExtractionContext) => boolean;

const INT32_SIZE = 2 ** 32;
const INT32_SIGN_BIT = 2 ** 31;
export const uninitializedStaticBinding = Symbol(
  'wyw.oxc.uninitializedStaticBinding'
);

const toInt32 = (value: number): number => {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }

  const integer = Math.sign(value) * Math.floor(Math.abs(value));
  const int32bit = ((integer % INT32_SIZE) + INT32_SIZE) % INT32_SIZE;

  return int32bit >= INT32_SIGN_BIT ? int32bit - INT32_SIZE : int32bit;
};

export const bitwiseNot = (value: number): number => -toInt32(value) - 1;

export const bindingValueCacheKey = (
  binding: Binding,
  ctx: ExtractionContext,
  bindingMutations: readonly Node[] = ctx.rootMutationsByBinding.get(
    toMutationBindingKey(binding)
  ) ?? [],
  bindingMutationHazards: readonly Node[] = getBindingMutationHazards(
    binding,
    ctx
  ),
  isKnownPureStaticCall: IsKnownPureStaticCall
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

const staticObjectPropertyKey = (
  property: Node & { computed?: boolean; key?: Node },
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[],
  evaluateStatic: EvaluateStatic
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
  stack: string[],
  evaluateStatic: EvaluateStatic
): unknown | undefined => {
  if (expression.type !== 'ObjectExpression') {
    return undefined;
  }

  for (let idx = expression.properties.length - 1; idx >= 0; idx -= 1) {
    const property = expression.properties[idx]!;
    if (property.type === 'SpreadElement') {
      return undefined;
    }

    const key = staticObjectPropertyKey(
      property,
      ctx,
      env,
      stack,
      evaluateStatic
    );
    if (key === null) {
      return undefined;
    }

    if (key === propertyKey) {
      return evaluateStatic(property.value, ctx, env, stack);
    }
  }

  return undefined;
};

export const evaluateKnownObjectMember = (
  expression: Expression,
  propertyKey: string | number,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[],
  evaluateStatic: EvaluateStatic
): unknown | undefined => {
  const objectMember = evaluateObjectExpressionMember(
    expression,
    propertyKey,
    ctx,
    env,
    stack,
    evaluateStatic
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
    [...stack, binding.name],
    evaluateStatic
  );
};

export type EvalEnv = Map<string, unknown>;

const oxcStaticCallableValue = Symbol('wyw.oxc.staticCallableValue');
export const oxcStaticFunctionNode = Symbol('wyw.oxc.staticFunctionNode');

type OxcStaticCallableValue = {
  [oxcStaticCallableValue]: unknown;
};

type OxcStaticFunctionValue = (() => undefined) & {
  [oxcStaticFunctionNode]: OxcFunctionLikeNode;
};

export const isOxcStaticCallableValue = (
  value: unknown
): value is OxcStaticCallableValue =>
  typeof value === 'object' &&
  value !== null &&
  !isStaticProxy(value) &&
  oxcStaticCallableValue in value;

export const unwrapOxcStaticCallableValue = (value: unknown): unknown =>
  isOxcStaticCallableValue(value) ? value[oxcStaticCallableValue] : value;

export const createOxcStaticFunctionValue = (
  fn: OxcFunctionLikeNode
): OxcStaticFunctionValue =>
  Object.assign(() => undefined, {
    [oxcStaticFunctionNode]: fn,
  });

export const isOxcStaticFunctionValue = (
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

export const appendDefaultArrayElements = (
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

export const assignPatternValue = (
  pattern: Node,
  value: unknown,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[],
  evaluateStatic: EvaluateStatic
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

    return assignPatternValue(
      pattern.left,
      assignedValue,
      ctx,
      env,
      stack,
      evaluateStatic
    );
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
        if (
          !assignPatternValue(
            property.argument,
            rest,
            ctx,
            env,
            stack,
            evaluateStatic
          )
        ) {
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
      if (
        !assignPatternValue(
          property.value,
          member.value,
          ctx,
          env,
          stack,
          evaluateStatic
        )
      ) {
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
      if (
        !assignPatternValue(
          target,
          elementValue,
          ctx,
          env,
          stack,
          evaluateStatic
        )
      ) {
        return false;
      }
    }

    return true;
  }

  return false;
};

export const applyRootMutation = (
  bindingName: string,
  baseValue: unknown,
  mutation: AssignmentExpression | UpdateExpression,
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[],
  evaluateStatic: EvaluateStatic
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
  if (node !== root && isOxcFunctionLike(node)) {
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

export const evaluateFunctionCall = (
  fn: OxcFunctionLikeNode,
  args: unknown[],
  ctx: ExtractionContext,
  env: EvalEnv,
  stack: string[],
  evaluateStatic: EvaluateStatic
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
    if (
      !assignPatternValue(
        fn.params[idx],
        args[idx],
        ctx,
        localEnv,
        stack,
        evaluateStatic
      )
    ) {
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
        if (
          !assignPatternValue(
            declarator.id,
            value,
            ctx,
            localEnv,
            stack,
            evaluateStatic
          )
        ) {
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

const isCoercionFreePrimitive = (value: unknown): boolean =>
  value === null || (typeof value !== 'object' && typeof value !== 'function');

export const evaluateStringConversion = (value: unknown): string | undefined =>
  isCoercionFreePrimitive(value) ? String(value) : undefined;

export const evaluateNumberConversion = (
  value: unknown
): number | undefined => {
  if (!isCoercionFreePrimitive(value) || typeof value === 'symbol') {
    return undefined;
  }
  try {
    return Number(value);
  } catch {
    return undefined;
  }
};

export const evaluateBinary = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv = new Map(),
  stack: string[] = [],
  evaluateStatic: EvaluateStatic
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
