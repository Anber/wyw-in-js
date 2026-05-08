/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  AssignmentExpression,
  Expression,
  Node,
  UpdateExpression,
} from 'oxc-parser';

import { lookupStaticBinding } from './staticBindings';
import { resolveBindingAt } from './scopeAnalysis';
import type { ExtractionContext, OxcFunctionLikeNode } from './types';

export const literalCode = (value: unknown): string | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : null;
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }

  if (typeof value === 'object' && value !== null) {
    return `(${JSON.stringify(value)})`;
  }

  return null;
};

export const isStaticSerializableValue = (value: unknown): boolean =>
  literalCode(value) !== null;

export const cloneStaticValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneStaticValue(item));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneStaticValue(item)])
    );
  }

  return value;
};

const INT32_SIZE = 2 ** 32;
const INT32_SIGN_BIT = 2 ** 31;

const toInt32 = (value: number): number => {
  if (!Number.isFinite(value) || value === 0) {
    return 0;
  }

  const integer = Math.sign(value) * Math.floor(Math.abs(value));
  const int32bit = ((integer % INT32_SIZE) + INT32_SIZE) % INT32_SIZE;

  return int32bit >= INT32_SIGN_BIT ? int32bit - INT32_SIZE : int32bit;
};

const bitwiseNot = (value: number): number => -toInt32(value) - 1;

const getObjectMember = (
  objectValue: unknown,
  property: string | number
): unknown | undefined => {
  if (
    objectValue === null ||
    objectValue === undefined ||
    (typeof objectValue !== 'object' &&
      typeof objectValue !== 'string' &&
      typeof objectValue !== 'number' &&
      typeof objectValue !== 'boolean')
  ) {
    return undefined;
  }

  return (objectValue as Record<string | number, unknown>)[property];
};

type EvalEnv = Map<string, unknown>;

const oxcStaticCallableValue = Symbol('wyw.oxc.staticCallableValue');

type OxcStaticCallableValue = {
  [oxcStaticCallableValue]: unknown;
};

const isOxcStaticCallableValue = (
  value: unknown
): value is OxcStaticCallableValue =>
  typeof value === 'object' &&
  value !== null &&
  oxcStaticCallableValue in value;

const unwrapOxcStaticCallableValue = (value: unknown): unknown =>
  isOxcStaticCallableValue(value) ? value[oxcStaticCallableValue] : value;

export const createOxcStaticCallableValue = (
  value: unknown
): OxcStaticCallableValue => ({
  [oxcStaticCallableValue]: value,
});

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
    return assignPatternValue(
      pattern.left,
      value === undefined
        ? evaluateStatic(pattern.right, ctx, env, stack)
        : value,
      ctx,
      env,
      stack
    );
  }

  if (pattern.type === 'ObjectPattern') {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    return pattern.properties.every((property) => {
      if (property.type === 'RestElement') {
        return false;
      }

      let key: unknown;
      if (property.computed) {
        key = evaluateStatic(property.key as Expression, ctx, env, stack);
      } else if (property.key.type === 'Identifier') {
        key = property.key.name;
      } else if (property.key.type === 'Literal') {
        key = property.key.value;
      }
      if (key === undefined || key === null) {
        return false;
      }

      return assignPatternValue(
        property.value,
        getObjectMember(value, key as string | number),
        ctx,
        env,
        stack
      );
    });
  }

  if (pattern.type === 'ArrayPattern') {
    if (!Array.isArray(value)) {
      return false;
    }

    return pattern.elements.every((element, index) =>
      element
        ? assignPatternValue(element, value[index], ctx, env, stack)
        : true
    );
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
  for (let idx = 0; idx < fn.params.length; idx += 1) {
    if (!assignPatternValue(fn.params[idx], args[idx], ctx, localEnv, stack)) {
      return undefined;
    }
  }

  if (fn.body.type !== 'BlockStatement') {
    return evaluateStatic(fn.body as Expression, ctx, localEnv, stack);
  }

  for (const statement of fn.body.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement.declarations) {
        const value = declarator.init
          ? evaluateStatic(declarator.init, ctx, localEnv, stack)
          : undefined;
        if (!assignPatternValue(declarator.id, value, ctx, localEnv, stack)) {
          return undefined;
        }
      }
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

const isProcessEnvMember = (node: Node): boolean => {
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
  env: EvalEnv
): boolean =>
  expression.type === 'MemberExpression' &&
  isProcessEnvMember(expression.object) &&
  !env.has('process');

const isDeterministicUndefinedExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  env: EvalEnv
): boolean => {
  if (isProcessEnvValueAccess(expression, env)) {
    return true;
  }

  if (expression.type === 'UnaryExpression' && expression.operator === 'void') {
    return true;
  }

  return (
    expression.type === 'Identifier' &&
    expression.name === 'undefined' &&
    !resolveBindingAt(ctx, expression.name, expression.start)
  );
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

  switch (expression.operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '==':
      // eslint-disable-next-line eqeqeq
      return left == right;
    case '!=':
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
      const arg = evaluateStatic(
        expression.argument as Expression,
        ctx,
        env,
        stack
      );
      if (arg === undefined) {
        return argIsProcessEnvAccess || argIsUnboundBareIdentifier
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
    // process.env.X access is the only source we trust as "deterministically
    // undefined" — it's a build-time lookup we control. For everything else,
    // undefined means "couldn't evaluate" and we must bail to avoid inlining
    // a wrong fallback when the runtime value isn't actually nullish.
    const leftIsProcessEnvAccess = isProcessEnvValueAccess(
      expression.left,
      env
    );

    if (left === undefined && !leftIsProcessEnvAccess) {
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
    if (env.has(expression.name)) {
      return unwrapOxcStaticCallableValue(env.get(expression.name));
    }

    const binding = resolveBindingAt(ctx, expression.name, expression.start);
    if (binding?.importedFrom) {
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

    if (stack.includes(binding.name)) {
      return undefined;
    }

    let value: unknown | undefined;
    const { declarator } = binding;
    const init = declarator?.init;
    if (init) {
      if (declarator.id.type !== 'Identifier') {
        return undefined;
      }

      value = evaluateStatic(init, ctx, env, [...stack, binding.name]);
    } else if (binding.functionNode) {
      value = binding.functionNode;
    }

    if (
      value !== undefined &&
      binding.isRoot &&
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const mutations = ctx.rootMutationsByBinding.get(binding.name) ?? [];
      let nextValue = cloneStaticValue(value);
      for (const mutation of mutations) {
        if (mutation.start >= ctx.currentExpressionStart) {
          break;
        }

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

      return nextValue;
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

        Object.assign(result, spreadValue);
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

      result[key] = value;
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
        if (!Array.isArray(spreadValue)) {
          return undefined;
        }

        result.push(...spreadValue);
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

    if (isProcessEnvValueAccess(expression, env) && typeof key === 'string') {
      // Treat process.env.X as deterministically undefined at build time.
      // Reading from real process.env would couple the bundle to whatever
      // happens to be set on the build machine; falling back to the
      // ?? / || branch (or a runtime read) is more predictable.
      return undefined;
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

    const value = evaluateStatic(argument, ctx, env, stack);
    if (value === undefined) {
      return undefined;
    }

    if (expression.callee.name === 'String') {
      return String(value);
    }

    if (expression.callee.name === 'Number') {
      return Number(value);
    }

    if (expression.callee.name === 'Boolean') {
      return Boolean(value);
    }

    return undefined;
  }

  if (expression.type === 'CallExpression') {
    if (expression.callee.type === 'Identifier') {
      const args = expression.arguments.map((arg) =>
        arg.type === 'SpreadElement'
          ? undefined
          : evaluateStatic(arg, ctx, env, stack)
      );
      if (args.some((value) => value === undefined)) {
        return undefined;
      }

      const staticCallable = env.get(expression.callee.name);
      if (
        isOxcStaticCallableValue(staticCallable) &&
        expression.arguments.length === 0
      ) {
        return unwrapOxcStaticCallableValue(staticCallable);
      }

      // Plain function in env (e.g. supplied via staticBindings as a
      // pure helper). Invoke with already-evaluated args.
      if (typeof staticCallable === 'function') {
        try {
          return (staticCallable as (...a: unknown[]) => unknown)(...args);
        } catch {
          return undefined;
        }
      }

      if (expression.callee.name === 'String' && args.length === 1) {
        return String(args[0]);
      }

      if (expression.callee.name === 'Number' && args.length === 1) {
        return Number(args[0]);
      }

      if (expression.callee.name === 'Boolean' && args.length === 1) {
        return Boolean(args[0]);
      }

      const binding = resolveBindingAt(
        ctx,
        expression.callee.name,
        expression.callee.start
      );

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
        if (key === 'toLowerCase' && expression.arguments.length === 0) {
          return objectValue.toLowerCase();
        }

        if (key === 'toUpperCase' && expression.arguments.length === 0) {
          return objectValue.toUpperCase();
        }
      }
    }
  }

  return evaluateBinary(expression, ctx, env, stack);
};
