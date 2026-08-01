import type { Node } from 'oxc-parser';

type AnyOxcNode = Node & { expression?: Node };

export type OxcFunctionLike = Node & {
  async: boolean;
  body: Node | null;
  id?: { name: string } | null;
  params: Node[];
};

const OXC_TYPESCRIPT_RUNTIME_WRAPPERS = new Set([
  'TSAsExpression',
  'TSInstantiationExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);

export const isOxcTypescriptRuntimeWrapper = (node: Node): boolean =>
  OXC_TYPESCRIPT_RUNTIME_WRAPPERS.has(node.type);

export const isOxcTransparentRuntimeExpression = (
  node: Node,
  includeChainExpression: boolean
): boolean =>
  node.type === 'ParenthesizedExpression' ||
  (includeChainExpression && node.type === 'ChainExpression') ||
  isOxcTypescriptRuntimeWrapper(node);

export const unwrapOxcRuntimeExpression = (
  node: Node,
  includeChainExpression: boolean
): Node => {
  let current = node;
  while (
    isOxcTransparentRuntimeExpression(current, includeChainExpression) &&
    (current as AnyOxcNode).expression
  ) {
    current = (current as AnyOxcNode).expression!;
  }
  return current;
};

export const isOxcFunctionLike = (node: Node): node is OxcFunctionLike =>
  node.type === 'ArrowFunctionExpression' ||
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression';
