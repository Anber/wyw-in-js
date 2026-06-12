import type { AstNode } from '@wyw-in-js/shared';

import { isNode } from './isNode';

export type VisitorKeys<T extends AstNode> = {
  [K in keyof T]: Exclude<T[K], undefined> extends AstNode | AstNode[] | null
    ? K
    : never;
}[keyof T] &
  string;

export function getVisitorKeys<TNode extends AstNode>(
  node: TNode
): VisitorKeys<TNode>[] {
  return Object.keys(node).filter((key) => {
    const value = node[key as keyof TNode];
    if (isNode(value)) {
      return true;
    }

    return Array.isArray(value) && value.some(isNode);
  }) as VisitorKeys<TNode>[];
}
