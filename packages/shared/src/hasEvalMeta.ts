import type { WYWEvalMeta } from './types';

export function hasEvalMeta(value: unknown): value is WYWEvalMeta {
  return typeof value === 'object' && value !== null && '__wyw_meta' in value;
}
