import type { Node } from 'oxc-parser';

import { unwrapOxcRuntimeExpression } from './runtimeSemantics';

const unwrapProjectionExpression = (node: Node): Node =>
  unwrapOxcRuntimeExpression(node, true);

export type OxcPropertyKeyPart =
  | {
      kind: 'identifier';
      value: string;
    }
  | {
      kind: 'literal';
      value: unknown;
    };

export type OxcProjectionPath = Readonly<{
  root: string;
  segments: readonly OxcPropertyKeyPart[];
}>;

declare const runtimePropertyPathKey: unique symbol;

export type OxcRuntimePropertyPathKey = string & {
  readonly [runtimePropertyPathKey]: true;
};

export type OxcRuntimePropertyPath = Readonly<{
  key: OxcRuntimePropertyPathKey;
  root: string;
  segments: readonly string[];
}>;

const encodePathPart = (part: string): string => `${part.length}:${part}`;

const assertRuntimePathRoot = (root: string): string => {
  if (root.includes('#')) {
    throw new Error('An OXC runtime property-path root must not contain "#"');
  }
  return root;
};

const createRuntimePath = (
  root: string,
  segments: readonly string[]
): OxcRuntimePropertyPath => {
  let key = root;
  segments.forEach((segment) => {
    key += `#${encodePathPart(segment)}`;
  });
  return {
    key: key as OxcRuntimePropertyPathKey,
    root,
    segments,
  };
};

export const classifyOxcPropertyKey = (
  key: Node,
  computed: boolean
): OxcPropertyKeyPart | null => {
  if (!computed && key.type === 'Identifier') {
    return { kind: 'identifier', value: key.name };
  }

  if (key.type === 'Literal') {
    return { kind: 'literal', value: key.value };
  }

  return null;
};

export const decomposeOxcMemberPath = (
  node: Node
): OxcProjectionPath | null => {
  const reversedSegments: OxcPropertyKeyPart[] = [];
  let current = unwrapProjectionExpression(node);

  while (current.type === 'MemberExpression') {
    const property = classifyOxcPropertyKey(current.property, current.computed);
    if (!property) {
      return null;
    }

    reversedSegments.push(property);
    current = unwrapProjectionExpression(current.object);
  }

  if (current.type !== 'Identifier') {
    return null;
  }

  return {
    root: current.name,
    segments: reversedSegments.reverse(),
  };
};

export const toOxcRuntimePropertyKey = (part: OxcPropertyKeyPart): string =>
  String(part.value);

export const toOxcRuntimePropertyPath = (
  path: OxcProjectionPath
): OxcRuntimePropertyPath =>
  createRuntimePath(
    assertRuntimePathRoot(path.root),
    path.segments.map(toOxcRuntimePropertyKey)
  );

const runtimePropertyPaths = new WeakMap<Node, OxcRuntimePropertyPath | null>();

export const getOxcRuntimePropertyPath = (
  node: Node
): OxcRuntimePropertyPath | null => {
  const cached = runtimePropertyPaths.get(node);
  if (cached !== undefined) {
    return cached;
  }

  const reversedSegments: string[] = [];
  let current = unwrapProjectionExpression(node);
  while (current.type === 'MemberExpression') {
    let property: string | null = null;
    if (!current.computed && current.property.type === 'Identifier') {
      property = current.property.name;
    } else if (current.property.type === 'Literal') {
      property = String(current.property.value);
    }
    if (property === null) {
      runtimePropertyPaths.set(node, null);
      return null;
    }

    reversedSegments.push(property);
    current = unwrapProjectionExpression(current.object);
  }

  const path =
    current.type === 'Identifier'
      ? createRuntimePath(current.name, reversedSegments.reverse())
      : null;
  runtimePropertyPaths.set(node, path);
  return path;
};

export const createOxcRuntimePropertyPath = (
  root: string
): OxcRuntimePropertyPath => createRuntimePath(assertRuntimePathRoot(root), []);

export const appendOxcRuntimePropertyPath = (
  path: OxcRuntimePropertyPath,
  property: string
): OxcRuntimePropertyPath => ({
  key: `${path.key}#${encodePathPart(property)}` as OxcRuntimePropertyPathKey,
  root: path.root,
  segments: [...path.segments, property],
});

export const replaceOxcRuntimePropertyPathRoot = (
  path: OxcRuntimePropertyPath,
  root: string
): OxcRuntimePropertyPath => ({
  key: `${assertRuntimePathRoot(root)}${path.key.slice(
    path.root.length
  )}` as OxcRuntimePropertyPathKey,
  root,
  segments: path.segments,
});

export const isOxcRuntimePropertyPathEqualOrDescendant = (
  candidate: OxcRuntimePropertyPath,
  ancestor: OxcRuntimePropertyPath
): boolean =>
  candidate.root === ancestor.root &&
  (candidate.key === ancestor.key ||
    candidate.key.startsWith(`${ancestor.key}#`));

export const appendOxcRuntimePropertyPathKey = (
  path: OxcRuntimePropertyPathKey,
  property: string
): OxcRuntimePropertyPathKey =>
  `${path}#${encodePathPart(property)}` as OxcRuntimePropertyPathKey;

export const getOxcRuntimePropertyPathKeyRoot = (
  path: OxcRuntimePropertyPathKey
): string => {
  const separator = path.indexOf('#');
  return separator === -1 ? path : path.slice(0, separator);
};

export const replaceOxcRuntimePropertyPathKeyRoot = (
  path: OxcRuntimePropertyPathKey,
  root: string
): OxcRuntimePropertyPathKey => {
  const separator = path.indexOf('#');
  return `${assertRuntimePathRoot(root)}${
    separator === -1 ? '' : path.slice(separator)
  }` as OxcRuntimePropertyPathKey;
};

export const isOxcRuntimePropertyPathKeyEqualOrDescendant = (
  candidate: OxcRuntimePropertyPathKey,
  ancestor: OxcRuntimePropertyPathKey
): boolean => candidate === ancestor || candidate.startsWith(`${ancestor}#`);

export const matchesOxcRuntimePropertyPath = (
  path: OxcRuntimePropertyPath | null,
  root: string,
  ...segments: readonly string[]
): boolean =>
  path !== null &&
  path.root === root &&
  path.segments.length === segments.length &&
  path.segments.every((segment, index) => segment === segments[index]);
