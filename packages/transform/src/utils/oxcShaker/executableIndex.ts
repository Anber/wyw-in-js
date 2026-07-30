import type { Node } from 'oxc-parser';

import { getOxcNodeChildren as getChildren } from '../oxc/ast';
import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  isOxcTypescriptRuntimeWrapper,
  unwrapOxcRuntimeExpression,
} from '../oxc/runtimeSemantics';

type AnyNode = Node & Record<string, unknown>;

export type CallableNode = Node & {
  body: Node;
  params: Node[];
};

export const unwrapAliasExpression = (node: Node): Node =>
  unwrapOxcRuntimeExpression(node, true);

const isBindingIdentifier = (node: Node, parent: Node | null): boolean => {
  if (node.type !== 'Identifier' || !parent) {
    return false;
  }

  const parentNode = parent as AnyNode;
  if (parent.type === 'VariableDeclarator' && parentNode.id === node) {
    return true;
  }

  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ClassDeclaration' ||
      parent.type === 'ClassExpression' ||
      parent.type === 'TSEnumDeclaration') &&
    parentNode.id === node
  ) {
    return true;
  }

  if (
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier') &&
    parentNode.local === node
  ) {
    return true;
  }

  return false;
};

const isIdentifierReference = (
  node: Node,
  parent: Node | null,
  grandparent: Node | null
): boolean => {
  if (node.type !== 'Identifier') {
    return false;
  }

  if (isBindingIdentifier(node, parent)) {
    return false;
  }

  if (!parent) {
    return true;
  }

  const parentNode = parent as AnyNode;
  if (
    parent.type === 'Property' &&
    parentNode.key === node &&
    !parentNode.computed
  ) {
    return false;
  }

  if (
    parent.type === 'MemberExpression' &&
    parentNode.property === node &&
    !parentNode.computed
  ) {
    return false;
  }

  if (parent.type === 'ExportSpecifier' && parentNode.exported === node) {
    return false;
  }

  if (parent.type === 'ExportSpecifier' && parentNode.local === node) {
    return grandparent?.type === 'ExportNamedDeclaration'
      ? !grandparent.source
      : true;
  }

  // The `imported` name of `import { X as Y }` is what to take from the source
  // module — it does not reference a local binding `X` in the current module.
  if (parent.type === 'ImportSpecifier' && parentNode.imported === node) {
    return false;
  }

  return true;
};

export const collectReferences = (node: Node): Set<string> => {
  const references = new Set<string>();

  const visit = (
    current: Node,
    parent: Node | null = null,
    grandparent: Node | null = null
  ): void => {
    if (isOxcTypescriptRuntimeWrapper(current)) {
      const expression = (current as AnyNode).expression as Node | undefined;
      if (expression) {
        visit(expression, current, parent);
      }
      return;
    }

    if (current.type.startsWith('TS') && current.type !== 'TSEnumDeclaration') {
      return;
    }

    if (isIdentifierReference(current, parent, grandparent)) {
      references.add((current as AnyNode).name as string);
    }

    getChildren(current).forEach((child) => visit(child, current, parent));
  };

  visit(node);

  return references;
};

export const collectExternalReferences = (node: Node): Set<string> => {
  type ReferenceScope = {
    activeFrom: number;
    bindings: Set<string>;
    functionScope: boolean;
    parent: ReferenceScope | null;
  };

  const rootScope: ReferenceScope = {
    activeFrom: Number.NEGATIVE_INFINITY,
    bindings: new Set(),
    functionScope: true,
    parent: null,
  };
  const scopes = new Map<Node, ReferenceScope>();
  const addPattern = (
    scope: ReferenceScope,
    pattern: Node | null | undefined
  ): void => {
    collectPatternNames(pattern).forEach((binding) =>
      scope.bindings.add(binding)
    );
  };
  const nearestFunctionScope = (scope: ReferenceScope): ReferenceScope => {
    let current = scope;
    while (!current.functionScope && current.parent) {
      current = current.parent;
    }
    return current;
  };

  const assignScopes = (
    current: Node,
    inheritedScope: ReferenceScope
  ): void => {
    let currentScope = inheritedScope;
    const isFunction =
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression';

    if (isFunction) {
      if (current.type === 'FunctionDeclaration' && current.id) {
        addPattern(inheritedScope, current.id);
      }
      currentScope = {
        activeFrom: Number.NEGATIVE_INFINITY,
        bindings: new Set(),
        functionScope: true,
        parent: inheritedScope,
      };
      if (current.type === 'FunctionExpression' && current.id) {
        addPattern(currentScope, current.id);
      }
      current.params.forEach((parameter) =>
        addPattern(currentScope, parameter)
      );
    } else if (current.type === 'ClassExpression') {
      currentScope = {
        activeFrom: Number.NEGATIVE_INFINITY,
        bindings: new Set(),
        functionScope: false,
        parent: inheritedScope,
      };
      if (current.id) {
        addPattern(currentScope, current.id);
      }
    } else if (current.type === 'StaticBlock') {
      currentScope = {
        activeFrom: Number.NEGATIVE_INFINITY,
        bindings: new Set(),
        functionScope: true,
        parent: inheritedScope,
      };
    } else if (current.type === 'SwitchStatement') {
      currentScope = {
        activeFrom: current.cases[0]?.start ?? current.end,
        bindings: new Set(),
        functionScope: false,
        parent: inheritedScope,
      };
    } else if (
      current !== node &&
      (current.type === 'BlockStatement' ||
        current.type === 'CatchClause' ||
        current.type === 'ForStatement' ||
        current.type === 'ForInStatement' ||
        current.type === 'ForOfStatement')
    ) {
      currentScope = {
        activeFrom: Number.NEGATIVE_INFINITY,
        bindings: new Set(),
        functionScope: false,
        parent: inheritedScope,
      };
    }

    scopes.set(current, currentScope);

    if (current.type === 'VariableDeclaration') {
      const declarationScope =
        current.kind === 'var'
          ? nearestFunctionScope(currentScope)
          : currentScope;
      current.declarations.forEach((declaration) =>
        addPattern(declarationScope, declaration.id)
      );
    } else if (
      (current.type === 'ClassDeclaration' ||
        current.type === 'TSEnumDeclaration') &&
      current.id
    ) {
      addPattern(currentScope, current.id);
    } else if (current.type === 'CatchClause') {
      addPattern(currentScope, current.param);
    } else if (current.type === 'ImportDeclaration') {
      current.specifiers.forEach((specifier) =>
        addPattern(currentScope, specifier.local)
      );
    }

    getChildren(current).forEach((child) => assignScopes(child, currentScope));
  };

  assignScopes(node, rootScope);

  const references = new Set<string>();
  const visit = (
    current: Node,
    parent: Node | null = null,
    grandparent: Node | null = null
  ): void => {
    if (isOxcTypescriptRuntimeWrapper(current)) {
      const expression = (current as AnyNode).expression as Node | undefined;
      if (expression) {
        visit(expression, current, parent);
      }
      return;
    }

    if (current.type.startsWith('TS') && current.type !== 'TSEnumDeclaration') {
      return;
    }

    if (isIdentifierReference(current, parent, grandparent)) {
      const name = (current as AnyNode).name as string;
      let scope: ReferenceScope | null = scopes.get(current) ?? rootScope;
      while (
        scope &&
        (current.start < scope.activeFrom || !scope.bindings.has(name))
      ) {
        scope = scope.parent;
      }
      if (!scope) {
        references.add(name);
      }
    }

    getChildren(current).forEach((child) => visit(child, current, parent));
  };

  visit(node);
  return references;
};

export const getMutatedBinding = (node: Node): string | null => {
  const current = unwrapAliasExpression(node);
  if (current.type === 'Identifier') {
    return current.name;
  }

  if (current.type === 'MemberExpression') {
    return getMutatedBinding(current.object);
  }

  return null;
};

const getMutationPath = (
  node: Node,
  memberDepth = 0
): { binding: string; memberDepth: number } | null => {
  const current = unwrapAliasExpression(node);
  if (current.type === 'Identifier') {
    return { binding: current.name, memberDepth };
  }

  return current.type === 'MemberExpression'
    ? getMutationPath(current.object, memberDepth + 1)
    : null;
};

const collectMutationTargets = (node: Node): Node[] => {
  const current = unwrapAliasExpression(node);
  if (current.type === 'Identifier' || current.type === 'MemberExpression') {
    return [current];
  }

  if (current.type === 'AssignmentPattern') {
    return collectMutationTargets(current.left);
  }

  if (current.type === 'RestElement') {
    return collectMutationTargets(current.argument);
  }

  if (current.type === 'ObjectPattern') {
    return current.properties.flatMap((property) =>
      collectMutationTargets(
        property.type === 'RestElement' ? property.argument : property.value
      )
    );
  }

  if (current.type === 'ArrayPattern') {
    return current.elements.flatMap((element) =>
      element ? collectMutationTargets(element) : []
    );
  }

  return [];
};

const getMutationCallTargetNode = (node: Node): Node | null => {
  if (node.type !== 'CallExpression') {
    return null;
  }

  const { callee } = node;
  if (
    callee.type !== 'MemberExpression' ||
    callee.object.type !== 'Identifier' ||
    callee.object.name !== 'Object' ||
    callee.computed ||
    callee.property.type !== 'Identifier'
  ) {
    return null;
  }

  if (
    callee.property.name !== 'assign' &&
    callee.property.name !== 'defineProperty' &&
    callee.property.name !== 'defineProperties'
  ) {
    return null;
  }

  const [target] = node.arguments;
  if (!target || target.type === 'SpreadElement') {
    return null;
  }

  return target;
};

const getMutationCallTarget = (node: Node): string | null => {
  const target = getMutationCallTargetNode(node);
  return target ? getMutatedBinding(target) : null;
};

export const getImmediatelyInvokedFunction = (
  node: Node
): CallableNode | null => {
  const callee = unwrapAliasExpression(node);
  return callee.type === 'FunctionExpression' ||
    callee.type === 'ArrowFunctionExpression'
    ? (callee as CallableNode)
    : null;
};

type ModuleExecutedNodeEntry = {
  node: Node;
  parent: Node | null;
};

const moduleExecutedNodesCache = new WeakMap<
  Node,
  readonly ModuleExecutedNodeEntry[]
>();

const getModuleExecutedNodes = (
  node: Node
): readonly ModuleExecutedNodeEntry[] => {
  const cached = moduleExecutedNodesCache.get(node);
  if (cached) {
    return cached;
  }

  const entries: ModuleExecutedNodeEntry[] = [];
  const visit = (current: Node, parent: Node | null): void => {
    entries.push({ node: current, parent });

    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return;
    }

    if (current.type === 'CallExpression') {
      const invoked = getImmediatelyInvokedFunction(current.callee);
      getChildren(current).forEach((child) => visit(child, current));
      if (invoked) {
        visit(invoked.body, invoked);
      }
      return;
    }

    getChildren(current).forEach((child) => visit(child, current));
  };

  visit(node, null);
  moduleExecutedNodesCache.set(node, entries);
  return entries;
};

export const forEachModuleExecutedNode = (
  node: Node,
  visitor: (node: Node) => void
): void => {
  getModuleExecutedNodes(node).forEach(({ node: current }) => {
    visitor(current);
  });
};

export const forEachModuleExecutedNodeWithParent = (
  node: Node,
  visitor: (node: Node, parent: Node | null) => void
): void => {
  getModuleExecutedNodes(node).forEach(({ node: current, parent }) => {
    visitor(current, parent);
  });
};

export const isMemberRead = (node: Node, parent: Node | null): boolean => {
  if (node.type !== 'MemberExpression' || !parent) {
    return node.type === 'MemberExpression';
  }

  if (parent.type === 'AssignmentExpression' && parent.left === node) {
    return parent.operator !== '=';
  }

  if (
    (parent.type === 'UpdateExpression' && parent.argument === node) ||
    (parent.type === 'UnaryExpression' &&
      parent.operator === 'delete' &&
      parent.argument === node) ||
    ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') &&
      parent.left === node)
  ) {
    return false;
  }

  return true;
};

export const hasModuleInvocationCandidate = (node: Node): boolean =>
  getModuleExecutedNodes(node).some(({ node: current, parent }) => {
    if (
      current.type === 'CallExpression' ||
      current.type === 'NewExpression' ||
      current.type === 'TaggedTemplateExpression' ||
      current.type === 'ForInStatement' ||
      current.type === 'ForOfStatement' ||
      (current.type === 'BinaryExpression' && current.operator === 'in') ||
      (current.type === 'YieldExpression' &&
        current.delegate &&
        !!current.argument)
    ) {
      return true;
    }

    if (current.type === 'VariableDeclaration') {
      return current.declarations.some(
        (declarator) =>
          !!declarator.init &&
          (declarator.id.type === 'ArrayPattern' ||
            declarator.id.type === 'ObjectPattern')
      );
    }

    if (current.type === 'MemberExpression') {
      return isMemberRead(current, parent);
    }

    if (current.type === 'AssignmentExpression') {
      return (
        current.left.type === 'MemberExpression' ||
        (current.operator === '=' &&
          (current.left.type === 'ArrayPattern' ||
            current.left.type === 'ObjectPattern'))
      );
    }

    if (
      current.type === 'UpdateExpression' ||
      (current.type === 'UnaryExpression' && current.operator === 'delete')
    ) {
      return current.argument.type === 'MemberExpression';
    }

    return (
      current.type === 'SpreadElement' &&
      (parent?.type === 'ArrayExpression' ||
        parent?.type === 'ObjectExpression')
    );
  });

export const collectMutations = (node: Node): Set<string> => {
  const mutations = new Set<string>();

  const addTargets = (targets: Node[]): void => {
    targets.forEach((target) => {
      const mutated = getMutatedBinding(target);
      if (mutated) {
        mutations.add(mutated);
      }
    });
  };

  forEachModuleExecutedNode(node, (current) => {
    if (current.type === 'AssignmentExpression') {
      addTargets(collectMutationTargets(current.left));
    } else if (current.type === 'UpdateExpression') {
      addTargets(collectMutationTargets(current.argument));
    } else if (
      current.type === 'UnaryExpression' &&
      current.operator === 'delete'
    ) {
      addTargets(collectMutationTargets(current.argument));
    } else if (
      (current.type === 'ForInStatement' ||
        current.type === 'ForOfStatement') &&
      current.left.type !== 'VariableDeclaration'
    ) {
      addTargets(collectMutationTargets(current.left));
    } else {
      const mutated = getMutationCallTarget(current);
      if (mutated) {
        mutations.add(mutated);
      }
    }
  });
  return mutations;
};

export const collectNestedMutations = (node: Node): Set<string> => {
  const mutations = new Set<string>();

  const addNestedTargets = (targets: Node[], minimumDepth: number): void => {
    targets.forEach((target) => {
      const mutation = getMutationPath(target);
      if (mutation && mutation.memberDepth >= minimumDepth) {
        mutations.add(mutation.binding);
      }
    });
  };

  forEachModuleExecutedNode(node, (current) => {
    if (
      current.type === 'AssignmentExpression' ||
      current.type === 'UpdateExpression'
    ) {
      const target =
        current.type === 'AssignmentExpression'
          ? current.left
          : current.argument;
      addNestedTargets(collectMutationTargets(target), 2);
      return;
    }

    if (current.type === 'UnaryExpression' && current.operator === 'delete') {
      addNestedTargets(collectMutationTargets(current.argument), 2);
      return;
    }

    if (
      (current.type === 'ForInStatement' ||
        current.type === 'ForOfStatement') &&
      current.left.type !== 'VariableDeclaration'
    ) {
      addNestedTargets(collectMutationTargets(current.left), 2);
      return;
    }

    const target = getMutationCallTargetNode(current);
    const mutation = target ? getMutationPath(target) : null;
    if (mutation && mutation.memberDepth >= 1) {
      mutations.add(mutation.binding);
    }
  });

  return mutations;
};
