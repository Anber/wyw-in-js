/* eslint-disable no-continue,@typescript-eslint/no-use-before-define */

import type { Node } from 'oxc-parser';

import { getOxcNodeChildren } from './ast';
import {
  isOxcFunctionLike,
  isOxcTypescriptRuntimeWrapper,
} from './runtimeSemantics';

type AnyOxcNode = Node & Record<string, unknown>;

export type OxcLexicalScopeBase<TScope> = { parent: TScope | null };
export type OxcLexicalScopeKind =
  | 'block'
  | 'catch'
  | 'class-expression'
  | 'for'
  | 'function-body'
  | 'function-parameters'
  | 'program'
  | 'standalone'
  | 'static-block'
  | 'switch';
export type OxcLexicalScopeBoundary = {
  end: number;
  functionBoundary: boolean;
  kind: OxcLexicalScopeKind;
  root: boolean;
  start: number;
};
export type CreateOxcLexicalScope<TScope extends OxcLexicalScopeBase<TScope>> =
  (parent: TScope | null, boundary: OxcLexicalScopeBoundary) => TScope;
export type EnterOxcLexicalScope<TScope extends OxcLexicalScopeBase<TScope>> = (
  node: Node,
  scope: TScope,
  parent: Node | null,
  ancestors: Node[],
  runtime: boolean,
  reference: boolean
) => void;

const isOxcTypeOnlyNode = (node: Node): boolean =>
  (node.type.startsWith('TS') &&
    node.type !== 'TSEnumDeclaration' &&
    node.type !== 'TSParameterProperty' &&
    !isOxcTypescriptRuntimeWrapper(node)) ||
  node.type.startsWith('JSDoc');

export const isInOxcTypeContext = (ancestors: readonly Node[]): boolean =>
  ancestors.some(isOxcTypeOnlyNode);

export const isOxcPropertyOnlyIdentifier = (
  node: Node,
  parent: Node | null
): boolean =>
  !!parent &&
  parent.type === 'MemberExpression' &&
  parent.property === node &&
  !parent.computed;

export const isOxcObjectPropertyKey = (
  node: Node,
  parent: Node | null
): boolean =>
  !!parent &&
  ((parent.type === 'Property' &&
    parent.key === node &&
    !parent.computed &&
    parent.value !== node) ||
    ((parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition') &&
      parent.key === node &&
      !parent.computed));

export const isOxcBindingPosition = (
  node: Node,
  parent: Node | null
): boolean => {
  if (!parent) {
    return false;
  }

  switch (parent.type) {
    case 'VariableDeclarator':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'TSEnumDeclaration':
      return parent.id === node;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return parent.local === node;
    default:
      return false;
  }
};

const isNestedOxcBindingPosition = (
  node: Node,
  ancestors: readonly Node[]
): boolean => {
  let current = node;

  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index]!;
    if (isOxcBindingPosition(current, parent)) {
      return true;
    }

    if (
      (parent.type === 'AssignmentPattern' && parent.left === current) ||
      (parent.type === 'RestElement' && parent.argument === current) ||
      (parent.type === 'Property' && parent.value === current) ||
      (parent.type === 'ObjectPattern' &&
        (parent.properties as readonly Node[]).includes(current)) ||
      (parent.type === 'ArrayPattern' &&
        (parent.elements as readonly (Node | null)[]).includes(current)) ||
      (parent.type === 'TSParameterProperty' && parent.parameter === current)
    ) {
      current = parent;
      continue;
    }

    if (
      (isOxcFunctionLike(parent) &&
        (parent.params as readonly Node[]).includes(current)) ||
      (parent.type === 'CatchClause' && parent.param === current)
    ) {
      return true;
    }

    return false;
  }

  return false;
};

export const isOxcRuntimeReferenceIdentifier = (
  node: Node,
  parent: Node | null,
  ancestors: readonly Node[]
): boolean => {
  if (
    node.type !== 'Identifier' ||
    isNestedOxcBindingPosition(node, ancestors) ||
    isOxcPropertyOnlyIdentifier(node, parent) ||
    isOxcObjectPropertyKey(node, parent)
  ) {
    return false;
  }

  if (!parent) {
    return true;
  }

  const parentNode = parent as AnyOxcNode;
  if (parent.type === 'ExportSpecifier') {
    if (parentNode.exported === node) {
      return false;
    }

    if (parentNode.local === node) {
      const grandparent = ancestors.at(-2);
      return grandparent?.type !== 'ExportNamedDeclaration'
        ? true
        : !(grandparent as AnyOxcNode).source;
    }
  }

  return parent.type !== 'ImportSpecifier' || parentNode.imported !== node;
};

const hasDecorator = (decoratedNode: Node, child: Node): boolean => {
  const { decorators } = decoratedNode as AnyOxcNode;
  return Array.isArray(decorators) && decorators.includes(child);
};

const createBoundary = (
  node: Node,
  kind: OxcLexicalScopeKind,
  functionBoundary = false,
  start = node.start,
  root = false
): OxcLexicalScopeBoundary => ({
  end: node.end,
  functionBoundary,
  kind,
  root,
  start,
});

const getBoundary = (
  node: Node,
  functionBody: boolean
): OxcLexicalScopeBoundary | null => {
  switch (node.type) {
    case 'Program':
      return createBoundary(node, 'program', true, node.start, true);
    case 'ArrowFunctionExpression':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
      return createBoundary(node, 'function-parameters', true);
    case 'BlockStatement':
      return createBoundary(
        node,
        functionBody ? 'function-body' : 'block',
        functionBody
      );
    case 'SwitchStatement':
      return createBoundary(
        node,
        'switch',
        false,
        node.cases[0]?.start ?? node.end
      );
    case 'StaticBlock':
      return createBoundary(node, 'static-block', true);
    case 'CatchClause':
      return createBoundary(node, 'catch');
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
      return createBoundary(node, 'for');
    case 'ClassExpression':
      return createBoundary(node, 'class-expression');
    default:
      return null;
  }
};

export const visitOxcLexicalScopes = <
  TScope extends OxcLexicalScopeBase<TScope>,
>(
  root: Node,
  initialScope: TScope | null,
  createScope: CreateOxcLexicalScope<TScope>,
  enter: EnterOxcLexicalScope<TScope>
): void => {
  let rootScope = initialScope;
  if (
    !rootScope &&
    (isOxcFunctionLike(root) ||
      root.type === 'ClassExpression' ||
      root.type === 'SwitchStatement')
  ) {
    rootScope = createScope(null, createBoundary(root, 'standalone', true));
  }

  const ancestors: Node[] = [];
  const visit = (
    current: Node,
    inheritedScope: TScope | null,
    parent: Node | null,
    decoratorScope: TScope | null,
    functionBody: boolean,
    inheritedRuntime: boolean
  ): void => {
    const boundary = getBoundary(current, functionBody);
    const currentScope = boundary
      ? createScope(inheritedScope, boundary)
      : inheritedScope ??
        createScope(null, createBoundary(current, 'standalone', true));
    const runtime = inheritedRuntime && !isOxcTypeOnlyNode(current);
    const reference =
      runtime && isOxcRuntimeReferenceIdentifier(current, parent, ancestors);

    enter(current, currentScope, parent, ancestors, runtime, reference);

    const functionLike = isOxcFunctionLike(current);
    const runtimeExpression = isOxcTypescriptRuntimeWrapper(current)
      ? ((current as AnyOxcNode).expression as Node | undefined)
      : undefined;
    ancestors.push(current);
    const children = getOxcNodeChildren(current);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      let childDecoratorScope: TScope | null = null;
      let childScope = currentScope;

      if (decoratorScope && hasDecorator(current, child)) {
        childScope = decoratorScope;
      } else if (
        current.type === 'ClassExpression' &&
        hasDecorator(current, child)
      ) {
        childScope = inheritedScope ?? currentScope;
      } else if (
        current.type === 'SwitchStatement' &&
        current.discriminant === child
      ) {
        childScope = inheritedScope ?? currentScope;
      }

      if (
        functionLike &&
        current.params.some((parameter) => parameter === child)
      ) {
        childDecoratorScope = inheritedScope ?? currentScope;
      }

      visit(
        child,
        childScope,
        current,
        childDecoratorScope,
        functionLike &&
          current.body?.type === 'BlockStatement' &&
          current.body === child,
        runtime &&
          (runtimeExpression === undefined || runtimeExpression === child)
      );
    }
    ancestors.pop();
  };

  visit(root, rootScope, null, null, false, true);
};
