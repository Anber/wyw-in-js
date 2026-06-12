import type { Node } from 'oxc-parser';

type AnyOxcNode = Node & Record<string, unknown>;

export const isOxcNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

// Cache visitor-key lists per node.type. oxc-parser AST nodes have a stable
// shape per `type` — optional children are present as null/undefined, not
// omitted — so Object.keys() returns the same key set for every instance of
// the same kind. First instance pays the discovery cost; the rest do an
// indexed lookup. getOxcNodeChildren is invoked tens of millions of times
// on a cold build of a large monorepo, so this matters a lot.
//
// An instance-level WeakMap cache of the resulting Node[] was tried and
// regressed wall time ~20% (WeakMap.get/set per call beat the recompute
// savings for small children arrays + pinned arrays into older generations
// and increased GC pressure). Per-type key cache only.
const META_KEYS = new Set([
  'comments',
  'end',
  'errors',
  'parent',
  'range',
  'span',
  'start',
  'type',
]);
const VISITOR_KEYS_BY_TYPE = new Map<string, readonly string[]>();
const visitorKeysFor = (node: AnyOxcNode): readonly string[] => {
  let keys = VISITOR_KEYS_BY_TYPE.get(node.type);
  if (keys === undefined) {
    keys = Object.keys(node).filter((key) => !META_KEYS.has(key));
    VISITOR_KEYS_BY_TYPE.set(node.type, keys);
  }
  return keys;
};

export const getOxcNodeChildren = (node: Node): Node[] => {
  const result: Node[] = [];
  const record = node as AnyOxcNode;
  const keys = visitorKeysFor(record);
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
