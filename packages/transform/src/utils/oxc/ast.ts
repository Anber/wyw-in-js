import { visitorKeys, type Node } from 'oxc-parser';

type AnyOxcNode = Node & Record<string, unknown>;

export const isOxcNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

export const getOxcNodeChildren = (node: Node): Node[] => {
  const result: Node[] = [];
  const record = node as AnyOxcNode;
  // OXC exposes the complete visitor-key union for each node type. Unlike
  // Object.keys(node), it remains stable when JS and TS instances of the same
  // type have different shapes (for example, decorated TS Identifiers).
  const keys = visitorKeys[node.type] ?? [];
  for (let i = 0; i < keys.length; i += 1) {
    const value = record[keys[i]];
    if (isOxcNode(value)) {
      result.push(value);
    } else if (Array.isArray(value)) {
      for (let j = 0; j < value.length; j += 1) {
        const item = value[j];
        if (isOxcNode(item)) {
          result.push(item);
        }
      }
    }
  }
  return result;
};

export const walkOxc = (
  node: Node,
  enter: (node: Node, parent: Node | null) => void,
  parent: Node | null = null
): void => {
  enter(node, parent);
  const children = getOxcNodeChildren(node);
  for (let i = 0; i < children.length; i += 1) {
    walkOxc(children[i], enter, node);
  }
};
