import type { Binding } from './types';

export const toOxcBindingIdentity = (binding: Binding): string =>
  `${binding.scope.start}:${binding.scope.end}:${binding.declaredAt}:${binding.name}`;
