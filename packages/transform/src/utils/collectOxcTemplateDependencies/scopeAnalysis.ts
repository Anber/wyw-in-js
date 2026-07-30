/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { SourceLocation } from '@wyw-in-js/shared';
import type {
  AssignmentExpression,
  Expression,
  ImportDeclaration,
  ImportSpecifier,
  ModuleExportName,
  Node,
  Program,
  TemplateLiteral,
  UpdateExpression,
  VariableDeclaration,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { parseOxcProgram } from '../oxc/parse';
import { createOxcSourceLocation } from '../oxc/sourceLocations';
import type {
  Binding,
  ExpressionSpan,
  ExtractionContext,
  ProgramAnalysis,
  ReferenceIdentifier,
  Scope,
  ScopedDeclarationKind,
  SpanLookup,
} from './types';

export const containsTaggedTemplateExpression = (node: Node): boolean => {
  if (node.type === 'TaggedTemplateExpression') {
    return true;
  }

  return getOxcNodeChildren(node).some(containsTaggedTemplateExpression);
};

export const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgram(code, filename, 'unambiguous');
};

const toSpanKey = (start: number, end: number): string => `${start}:${end}`;

export const createSpanLookup = (spans?: ExpressionSpan[]): SpanLookup => {
  if (!spans || spans.length === 0) {
    return null;
  }

  return new Set(spans.map((span) => toSpanKey(span.start, span.end)));
};

const matchesSpanLookup = (
  node: Pick<Node, 'start' | 'end'>,
  spanLookup: SpanLookup
): boolean => !spanLookup || spanLookup.has(toSpanKey(node.start, node.end));

export const getSourceLocation = (
  start: number,
  end: number,
  ctx: Pick<ExtractionContext, 'filename' | 'loc'>
): SourceLocation => createOxcSourceLocation(start, end, ctx.loc, ctx.filename);

const createScope = (
  parent: Scope | null,
  node: Pick<Node, 'start' | 'end'>,
  root = false,
  functionBoundary = false
): Scope => ({
  bindings: new Map(),
  depth: parent ? parent.depth + 1 : 0,
  end: node.end,
  functionBoundary,
  params: new Set(),
  parent,
  root,
  start: node.start,
});

const normalizeDeclarationKind = (
  declarationKind: VariableDeclaration['kind']
): ScopedDeclarationKind => {
  if (declarationKind === 'var') {
    return 'var';
  }

  if (declarationKind === 'let') {
    return 'let';
  }

  return 'const';
};

const moduleExportName = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const getImportSpecifierInfo = (
  statement: ImportDeclaration,
  specifier: ImportDeclaration['specifiers'][number]
): { imported: 'default' | '*' | string; local: string } | null => {
  const local = specifier.local?.name;
  if (!local) {
    return null;
  }

  if (specifier.type === 'ImportDefaultSpecifier') {
    return {
      imported: 'default',
      local,
    };
  }

  if (specifier.type === 'ImportNamespaceSpecifier') {
    return {
      imported: '*',
      local,
    };
  }

  if (
    statement.importKind === 'type' ||
    (specifier as ImportSpecifier).importKind === 'type'
  ) {
    return null;
  }

  return {
    imported: moduleExportName((specifier as ImportSpecifier).imported),
    local,
  };
};

const getDeclarationScope = (
  scope: Scope,
  declarationKind: ScopedDeclarationKind
): Scope => {
  if (declarationKind !== 'var') {
    return scope;
  }

  let current: Scope | null = scope;
  while (current && !current.functionBoundary) {
    current = current.parent;
  }

  return current ?? scope;
};

const hasStraightLineVarInitializer = (ancestors: readonly Node[]): boolean => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]!;
    if (
      ancestor.type === 'FunctionDeclaration' ||
      ancestor.type === 'FunctionExpression' ||
      ancestor.type === 'ArrowFunctionExpression' ||
      ancestor.type === 'StaticBlock'
    ) {
      return true;
    }

    if (
      ancestor.type !== 'Program' &&
      ancestor.type !== 'BlockStatement' &&
      ancestor.type !== 'ExportNamedDeclaration'
    ) {
      return false;
    }
  }

  return true;
};

const collectBindingNames = (node: Node): string[] => {
  if (node.type === 'Identifier') {
    return [node.name];
  }

  if (node.type === 'RestElement') {
    return collectBindingNames(node.argument);
  }

  if (node.type === 'AssignmentPattern') {
    return collectBindingNames(node.left);
  }

  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectBindingNames(property.argument)
        : collectBindingNames(property.value)
    );
  }

  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) =>
      element ? collectBindingNames(element) : []
    );
  }

  if (node.type === 'TSParameterProperty') {
    return collectBindingNames(node.parameter);
  }

  return [];
};

const collectPatternDefaultExpressions = (
  pattern: Node,
  expressions: Expression[] = []
): Expression[] => {
  if (pattern.type === 'AssignmentPattern') {
    expressions.push(pattern.right);
    return collectPatternDefaultExpressions(pattern.left, expressions);
  }

  if (pattern.type === 'RestElement') {
    return collectPatternDefaultExpressions(pattern.argument, expressions);
  }

  if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((property) => {
      collectPatternDefaultExpressions(
        property.type === 'RestElement' ? property.argument : property.value,
        expressions
      );
    });
    return expressions;
  }

  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element) => {
      if (element) {
        collectPatternDefaultExpressions(element, expressions);
      }
    });
  }

  return expressions;
};

const collectRestContainerBindingNames = (
  pattern: Node,
  names: string[] = []
): string[] => {
  if (pattern.type === 'RestElement') {
    if (pattern.argument.type === 'Identifier') {
      names.push(pattern.argument.name);
    } else {
      collectRestContainerBindingNames(pattern.argument, names);
    }
    return names;
  }

  if (pattern.type === 'AssignmentPattern') {
    return collectRestContainerBindingNames(pattern.left, names);
  }

  if (pattern.type === 'ObjectPattern') {
    pattern.properties.forEach((property) => {
      collectRestContainerBindingNames(
        property.type === 'RestElement' ? property : property.value,
        names
      );
    });
    return names;
  }

  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((element) => {
      if (element) {
        collectRestContainerBindingNames(element, names);
      }
    });
  }

  return names;
};

export const isInTypeContext = (ancestors: Node[]): boolean =>
  ancestors.some(
    (ancestor) =>
      ancestor.type.startsWith('TS') || ancestor.type.startsWith('JSDoc')
  );

export const isPropertyOnlyIdentifier = (
  node: Node,
  parent: Node | null
): boolean =>
  !!parent &&
  parent.type === 'MemberExpression' &&
  parent.property === node &&
  !parent.computed;

export const isObjectPropertyKey = (node: Node, parent: Node | null): boolean =>
  !!parent &&
  ((parent.type === 'Property' &&
    parent.key === node &&
    !parent.computed &&
    parent.value !== node) ||
    ((parent.type === 'MethodDefinition' ||
      parent.type === 'PropertyDefinition') &&
      parent.key === node &&
      !parent.computed));

export const isBindingPosition = (node: Node, parent: Node | null): boolean => {
  if (!parent) {
    return false;
  }

  if (parent.type === 'VariableDeclarator' && parent.id === node) {
    return true;
  }

  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ClassDeclaration' ||
      parent.type === 'ClassExpression') &&
    parent.id === node
  ) {
    return true;
  }

  if (
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier') &&
    'local' in parent &&
    parent.local === node
  ) {
    return true;
  }

  return false;
};

const isNestedBindingPosition = (
  node: Node,
  ancestors: readonly Node[]
): boolean => {
  let current = node;

  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const parent = ancestors[index]!;
    if (isBindingPosition(current, parent)) {
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
      ((parent.type === 'FunctionDeclaration' ||
        parent.type === 'FunctionExpression' ||
        parent.type === 'ArrowFunctionExpression') &&
        (parent.params as readonly Node[]).includes(current)) ||
      (parent.type === 'CatchClause' && parent.param === current)
    ) {
      return true;
    }

    return false;
  }

  return false;
};

const visit = (
  node: Node,
  scope: Scope | null,
  enter: (
    node: Node,
    scope: Scope,
    parent: Node | null,
    ancestors: Node[]
  ) => void,
  parent: Node | null = null,
  ancestors: Node[] = []
): void => {
  const visitNode = (
    currentNode: Node,
    currentScope: Scope | null,
    currentParent: Node | null
  ): void => {
    let nextScope: Scope;
    if (currentNode.type === 'Program') {
      nextScope = createScope(null, currentNode, true, true);
    } else if (
      currentNode.type === 'BlockStatement' ||
      currentNode.type === 'CatchClause' ||
      currentNode.type === 'ForStatement' ||
      currentNode.type === 'ForInStatement' ||
      currentNode.type === 'ForOfStatement' ||
      currentNode.type === 'SwitchStatement' ||
      currentNode.type === 'StaticBlock' ||
      currentNode.type === 'FunctionDeclaration' ||
      currentNode.type === 'FunctionExpression' ||
      currentNode.type === 'ArrowFunctionExpression' ||
      currentNode.type === 'ClassExpression'
    ) {
      let scopeRange: Pick<Node, 'start' | 'end'> = currentNode;
      if (currentNode.type === 'SwitchStatement') {
        scopeRange = {
          end: currentNode.end,
          start: currentNode.cases[0]?.start ?? currentNode.end,
        };
      }
      nextScope = createScope(
        currentScope,
        scopeRange,
        false,
        currentNode.type === 'FunctionDeclaration' ||
          currentNode.type === 'FunctionExpression' ||
          currentNode.type === 'ArrowFunctionExpression' ||
          currentNode.type === 'StaticBlock'
      );
    } else if (currentScope) {
      nextScope = currentScope;
    } else {
      nextScope = createScope(null, currentNode, false, true);
    }

    if (currentNode.type === 'FunctionExpression' && currentNode.id) {
      nextScope.bindings.set(currentNode.id.name, {
        declaredAt: currentNode.start,
        declaration: null,
        declarator: null,
        functionNode: currentNode,
        isRoot: false,
        kind: 'function',
        name: currentNode.id.name,
        scope: nextScope,
      });
    }

    if (currentNode.type === 'ClassExpression' && currentNode.id) {
      nextScope.bindings.set(currentNode.id.name, {
        declarationKind: 'let',
        declaredAt: currentNode.start,
        declaration: null,
        declarator: null,
        functionNode: null,
        isRoot: false,
        kind: 'variable',
        name: currentNode.id.name,
        scope: nextScope,
      });
    }

    if (
      currentNode.type === 'FunctionDeclaration' ||
      currentNode.type === 'FunctionExpression' ||
      currentNode.type === 'ArrowFunctionExpression'
    ) {
      currentNode.params.forEach((param) => {
        collectBindingNames(param).forEach((name) => {
          nextScope.params.add(name);
          nextScope.bindings.set(name, {
            declaredAt: param.start,
            declaration: null,
            declarator: null,
            functionNode: null,
            isRoot: false,
            kind: 'param',
            name,
            scope: nextScope,
          });
        });
      });
    }

    if (currentNode.type === 'CatchClause' && currentNode.param) {
      collectBindingNames(currentNode.param).forEach((name) => {
        nextScope.bindings.set(name, {
          declarationKind: 'let',
          declaredAt: currentNode.param!.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          isRoot: false,
          kind: 'variable',
          name,
          scope: nextScope,
        });
      });
    }

    enter(currentNode, nextScope, currentParent, ancestors);

    ancestors.push(currentNode);
    getOxcNodeChildren(currentNode).forEach((child) =>
      visitNode(child, nextScope, currentNode)
    );
    ancestors.pop();
  };

  visitNode(node, scope, parent);
};

export const analyzeProgram = (
  program: Program,
  {
    collectTargetExpressions = false,
    collectTemplateLiterals = false,
    expressionSpanLookup = null,
    mutationHazardIgnoreLookup = null,
    templateSpanLookup = null,
  }: {
    collectTargetExpressions?: boolean;
    collectTemplateLiterals?: boolean;
    expressionSpanLookup?: SpanLookup;
    mutationHazardIgnoreLookup?: SpanLookup;
    templateSpanLookup?: SpanLookup;
  } = {}
): ProgramAnalysis => {
  const bindings = new Map<string, Binding[]>();
  const usedNames = new Set<string>();
  const templateLiterals: TemplateLiteral[] = [];
  const targetExpressions: Expression[] = [];

  const addBinding = (scope: Scope, binding: Binding): void => {
    scope.bindings.set(binding.name, binding);
    const existing = bindings.get(binding.name) ?? [];
    existing.push(binding);
    bindings.set(binding.name, existing);
  };

  const collectTargets = (node: Node, ancestors: Node[]): void => {
    if (
      collectTemplateLiterals &&
      node.type === 'TemplateLiteral' &&
      node.expressions.length > 0 &&
      !ancestors.some((ancestor) => ancestor.type === 'TemplateLiteral') &&
      matchesSpanLookup(node, templateSpanLookup)
    ) {
      templateLiterals.push(node);
    }

    if (
      collectTargetExpressions &&
      expressionSpanLookup &&
      matchesSpanLookup(node, expressionSpanLookup)
    ) {
      targetExpressions.push(node as Expression);
    }
  };

  visit(program, null, (node, scope, parent, ancestors) => {
    collectTargets(node, ancestors);

    if (node.type === 'Identifier') {
      usedNames.add(node.name);
    }

    if (isInTypeContext(ancestors)) {
      return;
    }

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (node.type === 'FunctionExpression' && node.id) {
        const binding = scope.bindings.get(node.id.name);
        if (binding) {
          addBinding(scope, binding);
        }
      }

      node.params.forEach((param) => {
        collectBindingNames(param).forEach((name) => {
          const binding = scope.bindings.get(name);
          if (binding) {
            addBinding(scope, binding);
          }
        });
      });

      if (node.type !== 'FunctionDeclaration') {
        return;
      }
    }

    if (node.type === 'ClassExpression' && node.id) {
      const binding = scope.bindings.get(node.id.name);
      if (binding) {
        addBinding(scope, binding);
      }
      return;
    }

    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      node.specifiers.forEach((specifier) => {
        const importInfo = getImportSpecifierInfo(node, specifier);
        if (!importInfo) {
          return;
        }

        addBinding(scope, {
          declaredAt: specifier.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          imported: importInfo.imported,
          importedFrom: source,
          isRoot: scope.root,
          kind: 'import',
          name: importInfo.local,
          scope,
        });
      });
      return;
    }

    if (node.type === 'CatchClause' && node.param) {
      collectBindingNames(node.param).forEach((name) => {
        const binding = scope.bindings.get(name);
        if (binding) {
          addBinding(scope, binding);
        }
      });
      return;
    }

    if (node.type !== 'VariableDeclaration') {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const declarationScope = scope.parent ?? scope;
        const binding: Binding = {
          declaredAt: node.start,
          declaration: null,
          declarator: null,
          functionNode: node,
          isRoot: declarationScope.root,
          kind: 'function',
          name: node.id.name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      }

      if (node.type === 'ClassDeclaration' && node.id) {
        addBinding(scope, {
          declarationKind: 'let',
          declaredAt: node.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          isRoot: scope.root,
          kind: 'variable',
          name: node.id.name,
          scope,
        });
      }

      return;
    }

    node.declarations.forEach((declarator) => {
      collectBindingNames(declarator.id).forEach((name) => {
        const declarationKind = normalizeDeclarationKind(node.kind);
        const declarationScope = getDeclarationScope(scope, declarationKind);
        const preservesInitializer =
          declarationKind !== 'var' || hasStraightLineVarInitializer(ancestors);
        const binding: Binding = {
          declarationKind,
          declaredAt: declarator.start,
          declaration: node,
          declarator: preservesInitializer ? declarator : null,
          functionNode: null,
          isIteration:
            (parent?.type === 'ForInStatement' ||
              parent?.type === 'ForOfStatement') &&
            parent.left === node,
          isRoot: declarationScope.root,
          kind: 'variable',
          name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      });
    });
  });

  const rootMutationsByBinding = collectRootMutations(program);
  return {
    bindingsByName: bindings,
    rootMutationHazardsByBinding: collectRootMutationHazards(
      program,
      rootMutationsByBinding,
      bindings,
      mutationHazardIgnoreLookup
    ),
    rootMutationsByBinding,
    targetExpressions: targetExpressions.sort((a, b) => a.start - b.start),
    templateLiterals,
    usedNames,
  };
};

const shouldPreferBindingAt = (
  candidate: Binding,
  current: Binding,
  referenceStart: number
): boolean => {
  if (candidate.scope.depth !== current.scope.depth) {
    return candidate.scope.depth > current.scope.depth;
  }

  if (
    candidate.kind === 'variable' &&
    current.kind === 'variable' &&
    candidate.declarationKind === 'var' &&
    current.declarationKind === 'var'
  ) {
    const candidateHasExecuted = candidate.declaredAt <= referenceStart;
    const currentHasExecuted = current.declaredAt <= referenceStart;
    if (candidateHasExecuted !== currentHasExecuted) {
      return candidateHasExecuted;
    }

    return candidateHasExecuted
      ? candidate.declaredAt > current.declaredAt
      : candidate.declaredAt < current.declaredAt;
  }

  return candidate.declaredAt > current.declaredAt;
};

export const resolveBindingAt = (
  ctx: Pick<ExtractionContext, 'bindingResolutionCache' | 'bindingsByName'>,
  name: string,
  referenceStart: number
): Binding | undefined => {
  const cachedBindings = ctx.bindingResolutionCache.get(name);
  if (cachedBindings?.has(referenceStart)) {
    return cachedBindings.get(referenceStart) ?? undefined;
  }

  const bindings = ctx.bindingsByName.get(name);
  const bindingCache = cachedBindings ?? new Map<number, Binding | null>();
  if (!cachedBindings) {
    ctx.bindingResolutionCache.set(name, bindingCache);
  }

  if (!bindings || bindings.length === 0) {
    bindingCache.set(referenceStart, null);
    return undefined;
  }

  let binding: Binding | undefined;
  bindings.forEach((candidate) => {
    if (
      candidate.scope.start > referenceStart ||
      referenceStart >= candidate.scope.end
    ) {
      return;
    }

    if (!binding || shouldPreferBindingAt(candidate, binding, referenceStart)) {
      binding = candidate;
    }
  });

  bindingCache.set(referenceStart, binding ?? null);
  return binding;
};

const collectRootMutations = (
  program: Program
): Map<string, Array<AssignmentExpression | UpdateExpression>> => {
  const mutations = new Map<
    string,
    Array<AssignmentExpression | UpdateExpression>
  >();

  const getRootMutationTarget = (
    node: Node
  ): { binding: string; path: Array<string | number> } | null => {
    if (node.type === 'Identifier') {
      return {
        binding: node.name,
        path: [],
      };
    }

    if (node.type !== 'MemberExpression') {
      return null;
    }

    const parent = getRootMutationTarget(node.object);
    if (!parent) {
      return null;
    }

    let key: string | number | null = null;
    if (
      node.computed &&
      node.property.type === 'Literal' &&
      (typeof node.property.value === 'string' ||
        typeof node.property.value === 'number')
    ) {
      key = node.property.value;
    } else if (!node.computed && node.property.type === 'Identifier') {
      key = node.property.name;
    }
    if (key === null) {
      return null;
    }

    return {
      binding: parent.binding,
      path: [...parent.path, key],
    };
  };

  program.body.forEach((statement) => {
    if (statement.type !== 'ExpressionStatement') {
      return;
    }

    const { expression } = statement;
    if (expression.type === 'AssignmentExpression') {
      const target = getRootMutationTarget(expression.left);
      if (expression.operator !== '=' || !target || target.path.length === 0) {
        return;
      }

      const bucket = mutations.get(target.binding) ?? [];
      bucket.push(expression);
      mutations.set(target.binding, bucket);
      return;
    }

    if (expression.type === 'UpdateExpression') {
      const target = getRootMutationTarget(expression.argument);
      if (!target || target.path.length === 0) {
        return;
      }

      const bucket = mutations.get(target.binding) ?? [];
      bucket.push(expression);
      mutations.set(target.binding, bucket);
    }
  });

  return mutations;
};

export const unknownAliasMutationBinding =
  '\0wyw-static-unknown-alias-mutation';

export const toMutationBindingKey = (binding: Binding): string =>
  binding.isRoot
    ? binding.name
    : `\0wyw-static-scope:${binding.scope.start}:${binding.declaredAt}:${binding.name}`;

export const getRootMutationHazards = (
  hazards: ReadonlyMap<string, Node[]>,
  binding: string
): Node[] => hazards.get(binding) ?? [];

const containsOpaqueAliasConstruct = (node: Node): boolean =>
  node.type === 'CallExpression' ||
  node.type === 'NewExpression' ||
  node.type === 'TaggedTemplateExpression' ||
  node.type === 'ImportExpression' ||
  node.type === 'ThisExpression' ||
  node.type === 'Super' ||
  (node.type === 'MemberExpression' && findReferences(node).length === 0) ||
  getOxcNodeChildren(node).some(containsOpaqueAliasConstruct);

const containsUnprovenAliasSource = (
  node: Node,
  isUnresolvedReference: (reference: ReferenceIdentifier) => boolean
): boolean =>
  findReferences(node).some(isUnresolvedReference) ||
  containsOpaqueAliasConstruct(node);

const collectThrownExpressions = (
  node: Node,
  expressions: Expression[] = []
): Expression[] => {
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    return expressions;
  }

  if (node.type === 'ThrowStatement') {
    expressions.push(node.argument);
    return expressions;
  }

  getOxcNodeChildren(node).forEach((child) =>
    collectThrownExpressions(child, expressions)
  );
  return expressions;
};

const collectRootMutationHazards = (
  program: Program,
  mutations: Map<string, Array<AssignmentExpression | UpdateExpression>>,
  bindingsByName: ReadonlyMap<string, Binding[]>,
  ignoreLookup: SpanLookup = null
): Map<string, Node[]> => {
  const hazards = new Map<string, Node[]>();
  const siblingHazards = new Map<string, Node[]>();
  const ignoredHazardNodes = new Set<Node>();
  const markIgnoredHazardTree = (node: Node): void => {
    ignoredHazardNodes.add(node);
    getOxcNodeChildren(node).forEach(markIgnoredHazardTree);
  };
  const collectIgnoredHazardNodes = (node: Node): void => {
    if (ignoreLookup?.has(toSpanKey(node.start, node.end))) {
      ignoredHazardNodes.add(node);
      if (node.type === 'TaggedTemplateExpression') {
        // Suppress the processor tag construction/invocation itself. Quasi
        // interpolations remain visible so nested calls and mutations still
        // participate in provenance analysis.
        markIgnoredHazardTree(node.tag);
      }
    }

    getOxcNodeChildren(node).forEach(collectIgnoredHazardNodes);
  };
  if (ignoreLookup) {
    collectIgnoredHazardNodes(program);
  }

  const modeledMutations = new Set<Node>(
    [...mutations.values()].flatMap((nodes) => nodes)
  );
  const importedBindingsBySource = new Map<string, string[]>();
  bindingsByName.forEach((bindings) => {
    bindings.forEach((binding) => {
      if (!binding.importedFrom || !binding.isRoot) {
        return;
      }

      const bucket = importedBindingsBySource.get(binding.importedFrom) ?? [];
      if (!bucket.includes(binding.name)) {
        bucket.push(binding.name);
        importedBindingsBySource.set(binding.importedFrom, bucket);
      }
    });
  });

  const resolveReferenceBinding = (
    name: string,
    referenceStart: number
  ): Binding | undefined => {
    const bindings = bindingsByName.get(name);
    let result: Binding | undefined;
    bindings?.forEach((candidate) => {
      if (
        candidate.scope.start > referenceStart ||
        referenceStart >= candidate.scope.end
      ) {
        return;
      }

      if (!result || shouldPreferBindingAt(candidate, result, referenceStart)) {
        result = candidate;
      }
    });
    return result;
  };

  const toReferenceKey = ({ name, start }: ReferenceIdentifier): string => {
    const binding = resolveReferenceBinding(name, start);
    return binding ? toMutationBindingKey(binding) : name;
  };

  const collectReferenceKeys = (node: Node): string[] => [
    ...new Set(findReferences(node).map(toReferenceKey)),
  ];

  const isUnresolvedReference = ({
    name,
    start,
  }: ReferenceIdentifier): boolean =>
    resolveReferenceBinding(name, start) === undefined;

  const containsUnprovenAlias = (node: Node): boolean =>
    containsUnprovenAliasSource(node, isUnresolvedReference);

  const shallowCopyChangeCanAffectBindings = (
    bindings: readonly string[],
    change: Node
  ): boolean => {
    let target: Node | null = null;
    if (change.type === 'AssignmentExpression' && change.operator === '=') {
      target = change.left;
    } else if (
      change.type === 'UnaryExpression' &&
      change.operator === 'delete'
    ) {
      target = change.argument;
    } else {
      return true;
    }

    let memberDepth = 0;
    while (target.type === 'MemberExpression') {
      memberDepth += 1;
      target = target.object;
    }

    if (target.type !== 'Identifier') {
      return true;
    }

    const binding = resolveReferenceBinding(target.name, target.start);
    const targetKey = binding ? toMutationBindingKey(binding) : target.name;
    return !bindings.includes(targetKey) || memberDepth > 1;
  };

  const collectDeclaredBindingKeys = (
    names: string[],
    predicate: (binding: Binding) => boolean
  ): string[] => [
    ...new Set(
      names.flatMap((name) =>
        (bindingsByName.get(name) ?? [])
          .filter(predicate)
          .map(toMutationBindingKey)
      )
    ),
  ];

  const belongsToDeclarator = (
    binding: Binding,
    declarator: Node,
    declaration: VariableDeclaration
  ): boolean =>
    binding.declarator === declarator ||
    (binding.declarator === null &&
      binding.declaration === declaration &&
      binding.declaredAt === declarator.start);

  const collectAssignmentTargetKeys = (target: Node): string[] => {
    if (target.type === 'Identifier') {
      const binding = resolveReferenceBinding(target.name, target.start);
      return [binding ? toMutationBindingKey(binding) : target.name];
    }

    if (target.type === 'MemberExpression') {
      const objectKeys = collectReferenceKeys(target.object);
      return objectKeys.length > 0 ? objectKeys : [unknownAliasMutationBinding];
    }

    if (target.type === 'AssignmentPattern') {
      return collectAssignmentTargetKeys(target.left);
    }

    if (target.type === 'RestElement') {
      return collectAssignmentTargetKeys(target.argument);
    }

    if (target.type === 'ObjectPattern') {
      return target.properties.flatMap((property) =>
        collectAssignmentTargetKeys(
          property.type === 'RestElement' ? property.argument : property.value
        )
      );
    }

    if (target.type === 'ArrayPattern') {
      return target.elements.flatMap((element) =>
        element ? collectAssignmentTargetKeys(element) : []
      );
    }

    return [];
  };

  const addHazard = (
    name: string,
    hazard: Node,
    canAffectSiblingImport = false
  ): boolean => {
    const bucket = hazards.get(name) ?? [];
    let changed = false;
    if (!bucket.includes(hazard)) {
      bucket.push(hazard);
      hazards.set(name, bucket);
      changed = true;
    }

    if (canAffectSiblingImport) {
      const siblingBucket = siblingHazards.get(name) ?? [];
      if (!siblingBucket.includes(hazard)) {
        siblingBucket.push(hazard);
        siblingHazards.set(name, siblingBucket);
        changed = true;
      }
    }

    return changed;
  };

  const addReferences = (
    node: Node,
    hazard: Node,
    canAffectSiblingImport = false
  ): void => {
    collectReferenceKeys(node).forEach((key) => {
      addHazard(key, hazard, canAffectSiblingImport);
    });
  };

  const addUnknownAliasHazard = (node: Node, hazard: Node): void => {
    if (containsUnprovenAlias(node)) {
      addHazard(unknownAliasMutationBinding, hazard);
    }
  };

  visit(program, null, (node) => {
    if (ignoredHazardNodes.has(node)) {
      return;
    }

    if (node.type === 'AssignmentExpression') {
      // The RHS can similarly create an alias even when the LHS write itself
      // is one of the simple statically modeled root mutations.
      addReferences(node.right, node);
      if (!modeledMutations.has(node)) {
        addReferences(node.left, node, true);
        addUnknownAliasHazard(node.left, node);
      }
      return;
    }

    if (node.type === 'UpdateExpression') {
      if (!modeledMutations.has(node)) {
        addReferences(node.argument, node, true);
        addUnknownAliasHazard(node.argument, node);
      }
      return;
    }

    if (node.type === 'UnaryExpression' && node.operator === 'delete') {
      addReferences(node.argument, node, true);
      addUnknownAliasHazard(node.argument, node);
      return;
    }

    if (node.type === 'CallExpression') {
      // Any object passed to unknown code, or used as a method receiver, can
      // be mutated. Pure calls are intentionally rejected here rather than
      // risking a stale static snapshot.
      addReferences(node.callee, node, true);
      addUnknownAliasHazard(node.callee, node);
      node.arguments.forEach((argument) => {
        addReferences(argument, node, true);
        addUnknownAliasHazard(argument, node);
      });
      return;
    }

    if (node.type === 'NewExpression') {
      addReferences(node.callee, node, true);
      addUnknownAliasHazard(node.callee, node);
      node.arguments.forEach((argument) => {
        addReferences(argument, node, true);
        addUnknownAliasHazard(argument, node);
      });
      return;
    }

    if (node.type === 'TaggedTemplateExpression') {
      // A call used as a tag is visited separately. Keeping that call as the
      // hazard lets known static processor calls remain classifiable, while a
      // direct/aliased tag still represents an opaque invocation.
      if (node.tag.type !== 'CallExpression') {
        addReferences(node.tag, node, true);
        addUnknownAliasHazard(node.tag, node);
      }
      node.quasi.expressions.forEach((expression) => {
        // The escape occurs when the tag is invoked, after interpolation
        // evaluation. Anchoring it on the quasi prevents a target
        // interpolation from invalidating its own pre-call snapshot, while
        // later destructuring still observes an opaque (non-call-classified)
        // escape.
        addReferences(expression, node.quasi, true);
        addUnknownAliasHazard(expression, node.quasi);
      });
    }
  });

  const aliasLinks: Array<{
    declaredAt: number;
    sourceChangeCanAffectTargets?: (change: Node) => boolean;
    sourceChangesAffectTargets?: boolean;
    sources: string[];
    targetChangeCanAffectSources?: (change: Node) => boolean;
    targets: string[];
    unprovenResult: boolean;
  }> = [];
  visit(program, null, (node, scope, parent) => {
    if (
      node.type === 'CatchClause' &&
      node.param &&
      parent?.type === 'TryStatement'
    ) {
      const thrownExpressions = collectThrownExpressions(parent.block);
      const sourceExpressions = [
        ...thrownExpressions,
        ...collectPatternDefaultExpressions(node.param),
      ];
      aliasLinks.push({
        declaredAt: node.param.end,
        sources: [
          ...new Set(
            sourceExpressions.flatMap((expression) =>
              collectReferenceKeys(expression)
            )
          ),
        ],
        targets: collectDeclaredBindingKeys(
          collectBindingNames(node.param),
          (binding) =>
            binding.declarator === null &&
            binding.declaredAt === node.param!.start &&
            binding.scope.start === node.start
        ),
        // Calls, accessors, proxies, and host operations inside the try block
        // can throw values with provenance that is not represented by an
        // explicit ThrowStatement.
        unprovenResult: true,
      });
      return;
    }

    if (node.type === 'ForOfStatement') {
      if (node.left.type === 'VariableDeclaration') {
        const declaration = node.left;
        declaration.declarations.forEach((declarator) => {
          const sourceExpressions = [
            node.right,
            ...collectPatternDefaultExpressions(declarator.id),
          ];
          aliasLinks.push({
            declaredAt: node.right.end,
            sources: [
              ...new Set(
                sourceExpressions.flatMap((expression) =>
                  collectReferenceKeys(expression)
                )
              ),
            ],
            targets: collectDeclaredBindingKeys(
              collectBindingNames(declarator.id),
              (binding) => belongsToDeclarator(binding, declarator, declaration)
            ),
            unprovenResult: sourceExpressions.some(containsUnprovenAlias),
          });
        });
      } else {
        const sourceExpressions = [
          node.right,
          ...collectPatternDefaultExpressions(node.left),
        ];
        aliasLinks.push({
          declaredAt: node.right.end,
          sources: [
            ...new Set(
              sourceExpressions.flatMap((expression) =>
                collectReferenceKeys(expression)
              )
            ),
          ],
          targets: [...new Set(collectAssignmentTargetKeys(node.left))],
          unprovenResult: sourceExpressions.some(containsUnprovenAlias),
        });
      }
      return;
    }

    if (node.type === 'FunctionDeclaration' && node.id) {
      aliasLinks.push({
        declaredAt: scope.parent?.start ?? 0,
        sourceChangesAffectTargets: false,
        sources: collectReferenceKeys(node),
        targetChangeCanAffectSources: (change) =>
          change.type === 'CallExpression' ||
          change.type === 'NewExpression' ||
          change.type === 'TaggedTemplateExpression',
        targets: collectDeclaredBindingKeys(
          [node.id.name],
          (binding) => binding.functionNode === node
        ),
        unprovenResult: false,
      });
    }

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      node.params.forEach((param) => {
        const defaultExpressions = collectPatternDefaultExpressions(param);
        if (defaultExpressions.length === 0) {
          return;
        }

        aliasLinks.push({
          declaredAt: param.end,
          sources: [
            ...new Set(
              defaultExpressions.flatMap((expression) =>
                collectReferenceKeys(expression)
              )
            ),
          ],
          targets: collectDeclaredBindingKeys(
            collectBindingNames(param),
            (binding) =>
              binding.kind === 'param' && binding.scope.start === node.start
          ),
          unprovenResult: defaultExpressions.some(containsUnprovenAlias),
        });
      });
      return;
    }

    if (node.type === 'ClassDeclaration' && node.id) {
      aliasLinks.push({
        declaredAt: node.end,
        sources: collectReferenceKeys(node),
        targets: collectDeclaredBindingKeys(
          [node.id.name],
          (binding) =>
            binding.kind === 'variable' &&
            binding.declarationKind === 'let' &&
            binding.declaration === null &&
            binding.declarator === null &&
            binding.declaredAt === node.start
        ),
        unprovenResult: false,
      });
      return;
    }

    if (node.type === 'AssignmentExpression') {
      aliasLinks.push({
        declaredAt: node.end,
        sources: collectReferenceKeys(node.right),
        targets: collectReferenceKeys(node.left),
        unprovenResult: containsUnprovenAlias(node.right),
      });
      return;
    }

    if (node.type !== 'VariableDeclarator') {
      return;
    }

    const defaultExpressions = collectPatternDefaultExpressions(node.id);
    const sourceExpressions = [
      ...(node.init ? [node.init] : []),
      ...defaultExpressions,
    ];
    if (sourceExpressions.length === 0) {
      return;
    }

    const sources = [
      ...new Set(
        sourceExpressions.flatMap((expression) =>
          collectReferenceKeys(expression)
        )
      ),
    ];
    const targets = collectDeclaredBindingKeys(
      collectBindingNames(node.id),
      (binding) =>
        parent?.type === 'VariableDeclaration' &&
        belongsToDeclarator(binding, node, parent)
    );
    const restTargets = collectDeclaredBindingKeys(
      collectRestContainerBindingNames(node.id),
      (binding) =>
        parent?.type === 'VariableDeclaration' &&
        belongsToDeclarator(binding, node, parent)
    );
    const directTargets = targets.filter(
      (target) => !restTargets.includes(target)
    );
    const unprovenResult = sourceExpressions.some(containsUnprovenAlias);

    if (directTargets.length > 0) {
      aliasLinks.push({
        declaredAt: node.end,
        sources,
        targets: directTargets,
        unprovenResult,
      });
    }
    if (restTargets.length > 0) {
      aliasLinks.push({
        declaredAt: node.end,
        sourceChangeCanAffectTargets: (change) =>
          shallowCopyChangeCanAffectBindings(sources, change),
        sources,
        targetChangeCanAffectSources: (change) =>
          shallowCopyChangeCanAffectBindings(restTargets, change),
        targets: restTargets,
        unprovenResult,
      });
    }
  });

  // Propagate actual writes/escapes through local aliases. Merely reading a
  // source into another const is safe; a later change through that alias is
  // not. Iterate to cover chains such as `const b = a; const c = b`.
  const canAffectSiblingImport = (keys: string[], change: Node): boolean =>
    keys.some(
      (key) =>
        (mutations.get(key) ?? []).includes(
          change as AssignmentExpression | UpdateExpression
        ) || (siblingHazards.get(key) ?? []).includes(change)
    );

  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const {
      declaredAt,
      sourceChangeCanAffectTargets = () => true,
      sourceChangesAffectTargets = true,
      sources,
      targetChangeCanAffectSources = () => true,
      targets,
      unprovenResult,
    } of aliasLinks) {
      const targetChanges = targets.flatMap((target) => [
        ...(mutations.get(target) ?? []),
        ...(hazards.get(target) ?? []),
      ]);
      for (const change of targetChanges) {
        if (
          change.start < declaredAt ||
          !targetChangeCanAffectSources(change)
        ) {
          continue;
        }

        if (unprovenResult) {
          propagated =
            addHazard(unknownAliasMutationBinding, change) || propagated;
        }
        for (const source of sources) {
          propagated =
            addHazard(
              source,
              change,
              canAffectSiblingImport(targets, change)
            ) || propagated;
        }
      }

      const sourceChanges = sourceChangesAffectTargets
        ? sources.flatMap((source) => [
            ...(mutations.get(source) ?? []),
            ...(hazards.get(source) ?? []),
          ])
        : [];
      for (const change of sourceChanges) {
        if (
          change.start < declaredAt ||
          !sourceChangeCanAffectTargets(change)
        ) {
          continue;
        }

        for (const target of targets) {
          propagated =
            addHazard(
              target,
              change,
              canAffectSiblingImport(sources, change)
            ) || propagated;
        }
      }
    }

    for (const bindings of importedBindingsBySource.values()) {
      const sourceChanges = bindings.flatMap((binding) => [
        ...(mutations.get(binding) ?? []),
        ...(siblingHazards.get(binding) ?? []),
      ]);
      for (const change of sourceChanges) {
        for (const binding of bindings) {
          propagated = addHazard(binding, change, true) || propagated;
        }
      }
    }
  }

  importedBindingsBySource.forEach((bindings) => {
    bindings.forEach((binding) => {
      [
        ...(mutations.get(binding) ?? []),
        ...(siblingHazards.get(binding) ?? []),
      ].forEach((change) => {
        addHazard(unknownAliasMutationBinding, change);
      });
    });
  });

  hazards.forEach((nodes) => {
    nodes.sort((left, right) => left.start - right.start);
  });
  return hazards;
};

const hasLocalBinding = (scope: Scope, name: string): boolean => {
  let current: Scope | null = scope;

  while (current) {
    if (current.bindings.has(name)) {
      return true;
    }

    current = current.parent;
  }

  return false;
};

const hasLocalBindingCached = (
  scope: Scope,
  name: string,
  cache: WeakMap<Scope, Map<string, boolean>>
): boolean => {
  const scopeCache = cache.get(scope);
  if (scopeCache?.has(name)) {
    return scopeCache.get(name)!;
  }

  const result = hasLocalBinding(scope, name);
  const nextScopeCache = scopeCache ?? new Map<string, boolean>();
  nextScopeCache.set(name, result);
  if (!scopeCache) {
    cache.set(scope, nextScopeCache);
  }

  return result;
};

export const findReferences = (
  node: Node,
  referenceCache?: WeakMap<Node, ReferenceIdentifier[]>
): ReferenceIdentifier[] => {
  const cachedReferences = referenceCache?.get(node);
  if (cachedReferences) {
    return cachedReferences;
  }

  const refs = new Map<string, ReferenceIdentifier>();
  const localBindingCache = new WeakMap<Scope, Map<string, boolean>>();

  visit(node, null, (current, scope, parent, ancestors) => {
    if (
      current.type !== 'Identifier' ||
      isInTypeContext(ancestors) ||
      isNestedBindingPosition(current, ancestors) ||
      isPropertyOnlyIdentifier(current, parent) ||
      isObjectPropertyKey(current, parent) ||
      hasLocalBindingCached(scope, current.name, localBindingCache)
    ) {
      return;
    }

    const key = `${current.start}:${current.end}:${current.name}`;
    refs.set(key, {
      end: current.end,
      name: current.name,
      start: current.start,
    });
  });

  const resolvedReferences = [...refs.values()];
  referenceCache?.set(node, resolvedReferences);
  return resolvedReferences;
};

export const isBindingDeclaredWithin = (
  binding: Binding,
  container: Node
): boolean =>
  container.start <= binding.declaredAt && binding.declaredAt < container.end;
