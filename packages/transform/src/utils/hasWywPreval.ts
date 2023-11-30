import type { Value } from '@wyw-in-js/processor-utils';

export default function hasWywPreval(exports: unknown): exports is {
  __wywPreval: Record<string, () => Value> | null | undefined;
} {
  if (!exports || typeof exports !== 'object') {
    return false;
  }

  return '__wywPreval' in exports;
}
