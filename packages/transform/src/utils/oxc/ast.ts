import { visitorKeys, type Node } from 'oxc-parser';

type AnyOxcNode = Node & Record<string, unknown>;

const identifierVisitorKeys = visitorKeys.Identifier ?? [];
const canFastPathIdentifier =
  identifierVisitorKeys.length === 2 &&
  identifierVisitorKeys.includes('decorators') &&
  identifierVisitorKeys.includes('typeAnnotation');
const EMPTY_OXC_NODE_CHILDREN: readonly Node[] = Object.freeze([]);

export const isOxcNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

export const getOxcNodeChildren = (node: Node): readonly Node[] => {
  const record = node as AnyOxcNode;

  // Identifier is by far the most common OXC node. Its only visitor keys are
  // the optional decorators and type annotation, so avoid the visitor-key
  // lookup and loop when both are empty. Keep every non-empty shape on the
  // authoritative visitorKeys path below: TS and decorated Identifiers must
  // still expose their children regardless of which shape was seen first. The
  // optimization disables itself if a future OXC version adds another key.
  if (
    canFastPathIdentifier &&
    node.type === 'Identifier' &&
    (record.decorators == null ||
      (Array.isArray(record.decorators) && record.decorators.length === 0)) &&
    record.typeAnnotation == null
  ) {
    return EMPTY_OXC_NODE_CHILDREN;
  }

  const result: Node[] = [];
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
