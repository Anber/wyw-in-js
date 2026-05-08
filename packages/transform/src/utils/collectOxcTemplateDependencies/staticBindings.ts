import type { StaticBindings } from './types';

export const lookupStaticBinding = (
  staticBindings: StaticBindings | undefined,
  source: string | undefined,
  imported: string | undefined
): { found: true; value: unknown } | { found: false } => {
  if (!staticBindings || !source || !imported) {
    return { found: false };
  }
  const sourceMap = staticBindings[source];
  if (!sourceMap) {
    return { found: false };
  }
  if (!Object.prototype.hasOwnProperty.call(sourceMap, imported)) {
    return { found: false };
  }
  return { found: true, value: sourceMap[imported] };
};
