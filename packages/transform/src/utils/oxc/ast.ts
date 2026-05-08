import type { Node } from 'oxc-parser';

type AnyOxcNode = Node & Record<string, unknown>;

export const isOxcNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

export const getOxcNodeChildren = (node: Node): Node[] => {
  const result: Node[] = [];
  const record = node as AnyOxcNode;

  Object.keys(record).forEach((key) => {
    if (
      key === 'comments' ||
      key === 'end' ||
      key === 'errors' ||
      key === 'parent' ||
      key === 'range' ||
      key === 'span' ||
      key === 'start' ||
      key === 'type'
    ) {
      return;
    }

    const value = record[key];
    if (isOxcNode(value)) {
      result.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isOxcNode(item)) {
          result.push(item);
        }
      });
    }
  });

  return result;
};

export const walkOxc = (
  node: Node,
  enter: (node: Node, parent: Node | null) => void,
  parent: Node | null = null
): void => {
  enter(node, parent);
  getOxcNodeChildren(node).forEach((child) => walkOxc(child, enter, node));
};
