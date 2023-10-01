import type { WYWMeta } from './types';

export function hasMeta(value: unknown): value is WYWMeta {
  return typeof value === 'object' && value !== null && '__wyw_meta' in value;
}
