import type { Binding, ExtractionContext } from './types';

const shouldPreferBindingAt = (
  candidate: Binding,
  current: Binding,
  referenceStart: number
): boolean => {
  if (candidate.scope.depth !== current.scope.depth) {
    return candidate.scope.depth > current.scope.depth;
  }

  if (
    candidate.kind === 'variable' &&
    current.kind === 'variable' &&
    candidate.declarationKind === 'var' &&
    current.declarationKind === 'var'
  ) {
    const candidateHasExecuted = candidate.declaredAt <= referenceStart;
    const currentHasExecuted = current.declaredAt <= referenceStart;
    if (candidateHasExecuted !== currentHasExecuted) {
      return candidateHasExecuted;
    }

    return candidateHasExecuted
      ? candidate.declaredAt > current.declaredAt
      : candidate.declaredAt < current.declaredAt;
  }

  return candidate.declaredAt > current.declaredAt;
};

export const resolveBindingAt = (
  ctx: Pick<ExtractionContext, 'bindingResolutionCache' | 'bindingsByName'>,
  name: string,
  referenceStart: number
): Binding | undefined => {
  const cachedBindings = ctx.bindingResolutionCache.get(name);
  if (cachedBindings?.has(referenceStart)) {
    return cachedBindings.get(referenceStart) ?? undefined;
  }

  const bindings = ctx.bindingsByName.get(name);
  const bindingCache = cachedBindings ?? new Map<number, Binding | null>();
  if (!cachedBindings) {
    ctx.bindingResolutionCache.set(name, bindingCache);
  }

  if (!bindings || bindings.length === 0) {
    bindingCache.set(referenceStart, null);
    return undefined;
  }

  let binding: Binding | undefined;
  bindings.forEach((candidate) => {
    if (
      candidate.scope.start > referenceStart ||
      referenceStart >= candidate.scope.end
    ) {
      return;
    }

    if (!binding || shouldPreferBindingAt(candidate, binding, referenceStart)) {
      binding = candidate;
    }
  });

  bindingCache.set(referenceStart, binding ?? null);
  return binding;
};

export { shouldPreferBindingAt };
