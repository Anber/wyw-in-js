import type { Binding } from './types';

export const memoizeBindingFact = <T>(
  resolve: (binding: Binding) => T
): ((binding: Binding) => T) => {
  const cache = new Map<Binding, T>();
  return (binding) => {
    const cached = cache.get(binding);
    if (cached !== undefined || cache.has(binding)) {
      return cached as T;
    }
    const value = resolve(binding);
    cache.set(binding, value);
    return value;
  };
};

export const toOxcBindingIdentity = (binding: Binding): string =>
  `${binding.scope.start}:${binding.scope.end}:${binding.declaredAt}:${binding.name}`;
