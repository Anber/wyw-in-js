import type { Binding, BindingIndex, ExtractionContext, Scope } from './types';

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

export const resolveBindingInIndex = (
  index: BindingIndex,
  name: string,
  referenceStart: number
): Binding | undefined => {
  const bindings = index.bindingsByName.get(name);
  if (!bindings || bindings.length === 0) {
    return undefined;
  }

  let referenceScope = index.referenceScopesByStart.get(referenceStart) ?? null;
  if (referenceScope) {
    while (referenceScope) {
      let binding: Binding | undefined;
      for (
        let candidateIndex = 0;
        candidateIndex < bindings.length;
        candidateIndex += 1
      ) {
        const candidate = bindings[candidateIndex]!;
        if (
          candidate.scope === referenceScope &&
          (!binding ||
            shouldPreferBindingAt(candidate, binding, referenceStart))
        ) {
          binding = candidate;
        }
      }

      if (binding) {
        return binding;
      }
      referenceScope = referenceScope.parent;
    }

    return undefined;
  }

  // Some callers intentionally resolve synthetic offsets which do not point
  // at an Identifier node. Preserve the range-based resolver for those spans.
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

  return binding;
};

export const resolveBindingAt = (
  ctx: Pick<ExtractionContext, 'bindingIndex' | 'bindingResolutionCache'>,
  name: string,
  referenceStart: number
): Binding | undefined => {
  const cachedBindings = ctx.bindingResolutionCache.get(name);
  if (cachedBindings?.has(referenceStart)) {
    return cachedBindings.get(referenceStart) ?? undefined;
  }

  const bindingCache = cachedBindings ?? new Map<number, Binding | null>();
  if (!cachedBindings) {
    ctx.bindingResolutionCache.set(name, bindingCache);
  }

  const binding = resolveBindingInIndex(ctx.bindingIndex, name, referenceStart);
  bindingCache.set(referenceStart, binding ?? null);
  return binding;
};

export const createBindingIndex = (
  bindingsByName: ReadonlyMap<string, readonly Binding[]>,
  referenceScopesByStart: ReadonlyMap<number, Scope> = new Map()
): BindingIndex => ({
  bindingsByName,
  referenceScopesByStart,
});
