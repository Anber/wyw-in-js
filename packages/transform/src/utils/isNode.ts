import type { AstNode } from '@wyw-in-js/shared';

export const isNode = (obj: unknown): obj is AstNode =>
  typeof obj === 'object' &&
  obj !== null &&
  typeof (obj as { type?: unknown }).type === 'string';
