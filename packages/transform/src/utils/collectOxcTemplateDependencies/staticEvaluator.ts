/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Expression, Node } from 'oxc-parser';

import {
  collectOxcPatternBindingNames,
  collectOxcPatternRuntimeExpressions,
} from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import { lookupStaticBinding } from './staticBindings';
import * as timeline from './mutationTimeline';
import { findReferences, resolveBindingAt } from './scopeAnalysis';
import {
  getBindingDirectTimeline,
  getBindingHazardTimeline,
  hasDirectBindingMutationBefore,
  hasLexicalPreDeclarationChange,
  hasStringPrototypeMutationBefore,
  isDestructuringProjection,
  isDeterministicUndefinedExpression,
  isPatternRuntimeExpressionStable,
  isProcessEnvValueAccess,
  mutationDirectlyTargetsBinding,
} from './staticEvaluationSafety';
import {
  cloneStaticValue,
  copyEnumerableOwnDataProperties,
  defineStaticDataProperty,
  getObjectMember,
  isStaticProxy,
} from './staticValues';
import {
  appendDefaultArrayElements,
  applyRootMutation,
  assignPatternValue,
  bindingValueCacheKey,
  bitwiseNot,
  createOxcStaticFunctionValue,
  evaluateBinary,
  evaluateFunctionCall,
  evaluateKnownObjectMember,
  evaluateNumberConversion,
  evaluateStaticPropertyKey,
  evaluateStringConversion,
  isOxcStaticCallableValue,
  isOxcStaticFunctionValue,
  oxcStaticFunctionNode,
  uninitializedStaticBinding,
  unwrapOxcStaticCallableValue,
  type EvalEnv,
} from './staticEvaluationRuntime';
import type { Binding, ExtractionContext } from './types';

export { createOxcStaticCallableValue } from './staticEvaluationRuntime';

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
        timeline.hasTimelineStartInRange(
          getBindingDirectTimeline(binding, ctx),
          start,
          end
        ) ||
        timeline.someTimelineFullyContained(
          getBindingHazardTimeline(binding, ctx),
          start,
          end,
          (hazard) => !isKnownPureStaticCall(hazard, ctx)
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
    !isOxcFunctionLike(fn) ||
    (binding?.declarator && binding.declarator.end > node.start) ||
    node.arguments.some((argument) => argument.type === 'SpreadElement')
  ) {
    return false;
  }

  const proofHazards = new Map(ctx.rootMutationHazardsByBinding);
  proofHazards.forEach((hazardTimeline, key) => {
    const proofTimeline = timeline.withoutTimelineNode(hazardTimeline, node);
    if (proofTimeline !== hazardTimeline) {
      proofHazards.set(key, proofTimeline);
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

      return timeline.someTimelineEndAtOrBefore(
        getBindingHazardTimeline(binding, ctx),
        end,
        (hazard) =>
          !isKnownPureStaticCall(hazard, ctx) &&
          (!ignoredHazard ||
            hazard.start < ignoredHazard.start ||
            ignoredHazard.end < hazard.end)
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
  timeline.someTimelineFullyContained(
    getBindingHazardTimeline(binding, ctx),
    start,
    end,
    (hazard) => !isKnownPureStaticCall(hazard, ctx)
  );

const hasBindingMutationBefore = (
  binding: Binding,
  end: number,
  ctx: ExtractionContext
): boolean =>
  timeline.hasTimelineStartBefore(
    getBindingDirectTimeline(binding, ctx),
    end
  ) ||
  timeline.someTimelineEndAtOrBefore(
    getBindingHazardTimeline(binding, ctx),
    end,
    (hazard) => !isKnownPureStaticCall(hazard, ctx)
  );

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

    const bindingMutations = getBindingDirectTimeline(binding, ctx);
    const bindingMutationHazards = getBindingHazardTimeline(binding, ctx);
    const bindingHasChanges =
      bindingMutations.byStart.length > 0 ||
      bindingMutationHazards.byStart.length > 0;

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
          bindingMutationHazards,
          isKnownPureStaticCall
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
            nextStack,
            evaluateStatic
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
          const siblingBinding = ctx.bindingIndex.bindingsByName
            .get(name)
            ?.find((candidate) => candidate.declarator === declarator);
          const siblingValue = patternEnv.get(name);
          const siblingHasChanges =
            !!siblingBinding &&
            (getBindingDirectTimeline(siblingBinding, ctx).byStart.length > 0 ||
              getBindingHazardTimeline(siblingBinding, ctx).byStart.length > 0);
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
            env.set(
              bindingValueCacheKey(
                siblingBinding,
                ctx,
                undefined,
                undefined,
                isKnownPureStaticCall
              ),
              siblingValue
            );
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

    const hasPriorMutations = timeline.hasTimelineStartBefore(
      bindingMutations,
      ctx.currentExpressionStart
    );
    const isUnreplayedPriorHazard = (hazard: Node): boolean =>
      !isKnownPureStaticCall(hazard, ctx) &&
      !timeline.timelineStartBeforeIncludes(
        bindingMutations,
        ctx.currentExpressionStart,
        hazard
      );
    if (
      value !== undefined &&
      (typeof value !== 'object' || value === null) &&
      (hasPriorMutations ||
        timeline.someTimelineEndAtOrBefore(
          bindingMutationHazards,
          ctx.currentExpressionStart,
          (hazard) =>
            isUnreplayedPriorHazard(hazard) &&
            mutationDirectlyTargetsBinding(hazard, binding, ctx)
        ))
    ) {
      return undefined;
    }

    if (
      value !== undefined &&
      typeof value === 'object' &&
      value !== null &&
      declarator?.id.type === 'Identifier' &&
      timeline.someTimelineEndAtOrBefore(
        bindingMutationHazards,
        ctx.currentExpressionStart,
        isUnreplayedPriorHazard
      )
    ) {
      return undefined;
    }

    if (
      value !== undefined &&
      binding.isRoot &&
      typeof value === 'object' &&
      value !== null
    ) {
      if (!hasPriorMutations) {
        if (valueCacheKey) {
          env.set(valueCacheKey, value);
        }
        return value;
      }

      let nextValue: unknown | undefined = cloneStaticValue(value);
      timeline.forEachTimelineStartBefore(
        bindingMutations,
        ctx.currentExpressionStart,
        (mutation) => {
          if (nextValue !== undefined) {
            nextValue = applyRootMutation(
              binding.name,
              nextValue,
              mutation,
              ctx,
              env,
              [...stack, binding.name],
              evaluateStatic
            );
          }
        }
      );
      if (nextValue === undefined) {
        return undefined;
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

      const key = evaluateStaticPropertyKey(
        property.key,
        property.computed,
        ctx,
        env,
        stack,
        evaluateStatic
      );
      if (key === null) {
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
    const key = evaluateStaticPropertyKey(
      expression.property,
      expression.computed,
      ctx,
      env,
      stack,
      evaluateStatic
    );
    if (key === null) {
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
      stack,
      evaluateStatic
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

      return evaluateFunctionCall(
        inlineCallee,
        args,
        ctx,
        env,
        [...stack, `<inline:${inlineCallee.start}>`],
        evaluateStatic
      );
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
          [...stack, expression.callee.name],
          evaluateStatic
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
      if (fn && isOxcFunctionLike(fn)) {
        return evaluateFunctionCall(
          fn,
          args,
          ctx,
          env,
          [...stack, expression.callee.name],
          evaluateStatic
        );
      }
    }

    if (expression.callee.type === 'MemberExpression') {
      const objectValue = evaluateStatic(
        expression.callee.object,
        ctx,
        env,
        stack
      );
      const key = evaluateStaticPropertyKey(
        expression.callee.property,
        expression.callee.computed,
        ctx,
        env,
        stack,
        evaluateStatic
      );
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

  return evaluateBinary(expression, ctx, env, stack, evaluateStatic);
};
