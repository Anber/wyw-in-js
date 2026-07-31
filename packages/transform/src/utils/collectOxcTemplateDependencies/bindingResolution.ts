import type { Binding, BindingIndex, ExtractionContext, Scope } from './types';

const resolutionCaches = new WeakMap<
  BindingIndex,
  Map<number, Binding | string>
>();

const getResolutionCache = (
  index: BindingIndex
): Map<number, Binding | string> => {
  let cache = resolutionCaches.get(index);
  if (!cache) {
    cache = new Map();
    resolutionCaches.set(index, cache);
  }

  return cache;
};

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

  if (bindings.length === 1) {
    const binding = bindings[0]!;
    let referenceScope =
      index.referenceScopesByStart.get(referenceStart) ?? null;
    if (!referenceScope) {
      return binding.scope.start <= referenceStart &&
        referenceStart < binding.scope.end
        ? binding
        : undefined;
    }

    while (referenceScope) {
      if (binding.scope === referenceScope) {
        return binding;
      }
      referenceScope = referenceScope.parent;
    }

    return undefined;
  }

  // Multiple declarations require a candidate search, so repeated queries
  // are worth memoizing across analysis consumers.
  const cache = getResolutionCache(index);
  const cached = cache.get(referenceStart);
  if (typeof cached === 'string' ? cached === name : cached?.name === name) {
    return typeof cached === 'string' ? undefined : cached;
  }
  const shouldCache = cached === undefined;

  let referenceScope = index.referenceScopesByStart.get(referenceStart) ?? null;
  let binding: Binding | undefined;
  if (referenceScope) {
    while (referenceScope && !binding) {
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
      referenceScope = referenceScope.parent;
    }
  } else {
    // Some callers intentionally resolve synthetic offsets which do not point
    // at an Identifier node. Preserve the range-based resolver for those spans.
    bindings.forEach((candidate) => {
      if (
        candidate.scope.start > referenceStart ||
        referenceStart >= candidate.scope.end
      ) {
        return;
      }

      if (
        !binding ||
        shouldPreferBindingAt(candidate, binding, referenceStart)
      ) {
        binding = candidate;
      }
    });
  }

  if (shouldCache) {
    cache.set(referenceStart, binding ?? name);
  }
  return binding;
};

export const resolveBindingAt = (
  ctx: Pick<ExtractionContext, 'bindingIndex'>,
  name: string,
  referenceStart: number
): Binding | undefined =>
  resolveBindingInIndex(ctx.bindingIndex, name, referenceStart);

export const createBindingIndex = (
  bindingsByName: ReadonlyMap<string, readonly Binding[]>,
  referenceScopesByStart: ReadonlyMap<number, Scope> = new Map()
): BindingIndex => ({
  bindingsByName,
  referenceScopesByStart,
});
