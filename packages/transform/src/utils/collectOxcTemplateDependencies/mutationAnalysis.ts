/* eslint-disable no-restricted-syntax,no-continue,no-bitwise,@typescript-eslint/no-use-before-define */

import type {
  AssignmentExpression,
  Expression,
  Node,
  Program,
  UpdateExpression,
  VariableDeclaration,
} from 'oxc-parser';

import {
  appendOxcAssignmentTargetLeaves,
  type OxcAssignmentTargetLeaf,
} from '../oxc/assignmentTargets';
import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import {
  findResolvedReferences as getReferences,
  resolveBindingInIndex,
} from './bindingResolution';
import { memoizeBindingFact } from './bindingIdentity';
import {
  getMutationTimeline,
  sealMutationTimelineMap,
} from './mutationTimeline';
import {
  collectInvocationTargetKeys,
  collectMutationReferenceKeys,
  collectRootMutations,
  collectThrownExpressions,
  containsUnprovenAliasSource,
  createDeferredReferencePolicyCollector,
  findContainingClass,
  getExecutionOwner,
  isImmediatelyInvokedFunction,
  publishDeferredUnknownAliasSources,
  registerExecutionFunction,
  registerExecutionNode,
  type MutationAliasLink,
} from './mutationExecution';
import { visitOxcScopes } from './scopeTraversal';
import type {
  Binding,
  BindingIndex,
  MutationTimeline,
  ProgramAnalysis,
  SpanLookup,
} from './types';

const toSpanKey = (start: number, end: number): string => `${start}:${end}`;

const markIgnoredMutationHazardTree = (
  node: Node,
  ignoredHazardNodes: Set<Node>
): void => {
  ignoredHazardNodes.add(node);
  getOxcNodeChildren(node).forEach((child) =>
    markIgnoredMutationHazardTree(child, ignoredHazardNodes)
  );
};

export const registerMutationHazardNode = (
  node: Node,
  ignoreLookup: SpanLookup,
  ignoreTreeLookup: SpanLookup,
  ignoredHazardNodes: Set<Node>,
  ignoredHazardTreeNodes: Set<Node>
): void => {
  if (ignoreTreeLookup?.has(toSpanKey(node.start, node.end))) {
    markIgnoredMutationHazardTree(node, ignoredHazardNodes);
    markIgnoredMutationHazardTree(node, ignoredHazardTreeNodes);
    return;
  }

  if (!ignoreLookup?.has(toSpanKey(node.start, node.end))) {
    return;
  }

  ignoredHazardNodes.add(node);
  if (node.type === 'TaggedTemplateExpression') {
    // Suppress the processor tag construction/invocation itself. Quasi
    // interpolations remain visible so nested calls and mutations still
    // participate in provenance analysis.
    markIgnoredMutationHazardTree(node.tag, ignoredHazardNodes);
  }
};

const isMutationHazardSeed = (node: Node): boolean =>
  node.type === 'AssignmentExpression' ||
  node.type === 'UpdateExpression' ||
  (node.type === 'UnaryExpression' && node.operator === 'delete') ||
  node.type === 'CallExpression' ||
  node.type === 'NewExpression' ||
  node.type === 'TaggedTemplateExpression';

export const isEffectiveMutationHazardSeed = (
  node: Node,
  ignoredHazardNodes: ReadonlySet<Node>
): boolean => isMutationHazardSeed(node) && !ignoredHazardNodes.has(node);

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

export const unknownAliasMutationBinding =
  '\0wyw-static-unknown-alias-mutation';

const toScopedMutationBindingKey = memoizeBindingFact(
  (binding: Binding): string =>
    `\0wyw-static-scope:${binding.scope.start}:${binding.declaredAt}:${binding.name}`,
  new WeakMap()
);

export const toMutationBindingKey = (binding: Binding): string =>
  binding.isRoot ? binding.name : toScopedMutationBindingKey(binding);

export const getRootMutationHazards = (
  hazards: ReadonlyMap<string, MutationTimeline<Node>>,
  binding: string
): readonly Node[] => getMutationTimeline(hazards, binding).byStart;
const collectRootMutationHazards = (
  program: Program,
  mutations: Map<string, Array<AssignmentExpression | UpdateExpression>>,
  bindingIndex: BindingIndex,
  ignoredHazardNodes: ReadonlySet<Node>,
  ignoredHazardTreeNodes: ReadonlySet<Node>
): Map<string, Node[]> => {
  const { bindingsByName } = bindingIndex;
  const hazards = new Map<string, Node[]>();
  const factPublished = 1;
  const factStrong = 2;
  const factsByBinding = new Map<string, Map<Node, number>>();
  const getFacts = (key: string): Map<Node, number> => {
    const existing = factsByBinding.get(key);
    if (existing) {
      return existing;
    }
    const created = new Map<Node, number>();
    factsByBinding.set(key, created);
    return created;
  };

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
  ): Binding | undefined =>
    resolveBindingInIndex(bindingIndex, name, referenceStart);

  const ignoredHazardTreeReferenceStarts = new Set<number>();
  ignoredHazardTreeNodes.forEach((node) => {
    if (node.type === 'Identifier') {
      ignoredHazardTreeReferenceStarts.add(node.start);
    }
  });

  const toReferenceKey = (binding: Binding | null, name: string): string =>
    binding ? toMutationBindingKey(binding) : name;
  const collectReferenceKeys = (node: Node): string[] =>
    collectMutationReferenceKeys(
      node,
      bindingIndex,
      [ignoredHazardTreeReferenceStarts],
      toReferenceKey
    );

  const collectDeferredReferencePolicy =
    createDeferredReferencePolicyCollector(bindingIndex);
  const collectEagerReferenceKeys = (
    node: Node,
    includeBinding: (binding: Binding | null) => boolean = () => true
  ): string[] => {
    const { ignoredStarts } = collectDeferredReferencePolicy(node);
    return collectMutationReferenceKeys(
      node,
      bindingIndex,
      [ignoredHazardTreeReferenceStarts, ignoredStarts],
      toReferenceKey,
      includeBinding
    );
  };

  const processorManagedAliasReferenceStarts = new Set<number>();
  ignoredHazardNodes.forEach((node) => {
    if (node.type !== 'TaggedTemplateExpression') {
      return;
    }
    getReferences(node, bindingIndex).forEach(({ start }) =>
      processorManagedAliasReferenceStarts.add(start)
    );
  });
  const collectAliasReferenceKeys = (
    node: Node,
    includeBinding: (binding: Binding | null) => boolean = () => true
  ): string[] =>
    collectMutationReferenceKeys(
      node,
      bindingIndex,
      [processorManagedAliasReferenceStarts, ignoredHazardTreeReferenceStarts],
      toReferenceKey,
      includeBinding
    );
  const collectCapturedAliasReferenceKeys = (node: Node): string[] =>
    collectAliasReferenceKeys(
      node,
      (binding) =>
        !binding ||
        binding.declaredAt < node.start ||
        node.end <= binding.declaredAt
    );

  const containsUnprovenAlias = (node: Node): boolean =>
    containsUnprovenAliasSource(
      node,
      bindingIndex,
      ignoredHazardTreeNodes,
      ignoredHazardTreeReferenceStarts
    );
  const containsEagerUnprovenAlias = (node: Node): boolean => {
    const { ignoredRoots, ignoredStarts } =
      collectDeferredReferencePolicy(node);
    return containsUnprovenAliasSource(
      node,
      bindingIndex,
      ignoredHazardTreeNodes,
      ignoredHazardTreeReferenceStarts,
      ignoredRoots,
      ignoredStarts
    );
  };

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
    names: readonly string[],
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
    const targets: OxcAssignmentTargetLeaf[] = [];
    appendOxcAssignmentTargetLeaves(target, targets);
    const keys: string[] = [];
    for (let i = 0; i < targets.length; i += 1) {
      const leaf = targets[i]!;
      if (leaf.type === 'Identifier') {
        const binding = resolveReferenceBinding(leaf.name, leaf.start);
        keys.push(binding ? toMutationBindingKey(binding) : leaf.name);
      } else {
        const objectKeys = collectReferenceKeys(leaf.object);
        if (objectKeys.length > 0) {
          keys.push(...objectKeys);
        } else {
          keys.push(unknownAliasMutationBinding);
        }
      }
    }
    return keys;
  };

  const addHazard = (
    name: string,
    hazard: Node,
    canAffectSiblingImport = false
  ): void => {
    const facts = getFacts(name);
    const current = facts.get(hazard) ?? 0;
    if ((current & factPublished) === 0) {
      const bucket = hazards.get(name) ?? [];
      bucket.push(hazard);
      hazards.set(name, bucket);
    }
    facts.set(
      hazard,
      current | factPublished | (canAffectSiblingImport ? factStrong : 0)
    );
  };

  const addReferences = (
    node: Node,
    hazard: Node,
    canAffectSiblingImport = false
  ): void => {
    collectEagerReferenceKeys(node).forEach((key) => {
      addHazard(key, hazard, canAffectSiblingImport);
    });
  };

  const addUnknownAliasHazard = (node: Node, hazard: Node): void => {
    if (containsEagerUnprovenAlias(node)) {
      addHazard(unknownAliasMutationBinding, hazard);
    }
  };

  const deferredFunctionsWithUnknownAlias = new Set<Node>();
  const containingClassByDeferredFunction = new Map<Node, Node>();
  visitOxcScopes(program, null, (node, scope, _parent, ancestors) => {
    const executionOwner = scope.deferredFunctionNode ?? null;
    registerExecutionNode(bindingIndex, node, executionOwner);
    if (
      isOxcFunctionLike(node) &&
      !isImmediatelyInvokedFunction(node, ancestors)
    ) {
      registerExecutionFunction(bindingIndex, node, executionOwner);
      const containingClass = findContainingClass(ancestors);
      if (containingClass) {
        containingClassByDeferredFunction.set(node, containingClass);
      }
      // Scope state is intentionally inherited by scopes created below it.
      // eslint-disable-next-line no-param-reassign
      scope.deferredFunctionNode = node;
    }

    if (!isEffectiveMutationHazardSeed(node, ignoredHazardNodes)) {
      return;
    }

    const deferredFunction = scope.deferredFunctionNode;
    const addExecutionUnknownAliasHazard = (
      referenceNode: Node,
      hazard: Node
    ): void => {
      if (deferredFunction && containsEagerUnprovenAlias(referenceNode)) {
        deferredFunctionsWithUnknownAlias.add(deferredFunction);
      }
      addUnknownAliasHazard(referenceNode, hazard);
    };

    if (node.type === 'AssignmentExpression') {
      // The RHS can similarly create an alias even when the LHS write itself
      // is one of the simple statically modeled root mutations.
      addReferences(node.right, node);
      if (!modeledMutations.has(node)) {
        addReferences(node.left, node, true);
        addExecutionUnknownAliasHazard(node.left, node);
      }
      return;
    }

    if (node.type === 'UpdateExpression') {
      if (!modeledMutations.has(node)) {
        addReferences(node.argument, node, true);
        addExecutionUnknownAliasHazard(node.argument, node);
      }
      return;
    }

    if (node.type === 'UnaryExpression' && node.operator === 'delete') {
      addReferences(node.argument, node, true);
      addExecutionUnknownAliasHazard(node.argument, node);
      return;
    }

    if (node.type === 'CallExpression') {
      // Any object passed to unknown code, or used as a method receiver, can
      // be mutated. Pure calls are intentionally rejected here rather than
      // risking a stale static snapshot.
      // Starting at the invocation keeps an inline IIFE body eager while the
      // deferred-reference policy still skips callback arguments.
      addReferences(node, node, true);
      addExecutionUnknownAliasHazard(node.callee, node);
      node.arguments.forEach((argument) => {
        addExecutionUnknownAliasHazard(argument, node);
      });
      return;
    }

    if (node.type === 'NewExpression') {
      addReferences(node, node, true);
      addExecutionUnknownAliasHazard(node.callee, node);
      node.arguments.forEach((argument) => {
        addExecutionUnknownAliasHazard(argument, node);
      });
      return;
    }

    if (node.type === 'TaggedTemplateExpression') {
      // A call used as a tag is visited separately. Keeping that call as the
      // hazard lets known static processor calls remain classifiable, while a
      // direct/aliased tag still represents an opaque invocation.
      if (node.tag.type !== 'CallExpression') {
        addReferences(node.tag, node, true);
        addExecutionUnknownAliasHazard(node.tag, node);
      }
      node.quasi.expressions.forEach((expression) => {
        // The escape occurs when the tag is invoked, after interpolation
        // evaluation. Anchoring it on the quasi prevents a target
        // interpolation from invalidating its own pre-call snapshot, while
        // later destructuring still observes an opaque (non-call-classified)
        // escape.
        addReferences(expression, node.quasi, true);
        addExecutionUnknownAliasHazard(expression, node.quasi);
      });
    }
  });

  const aliasLinks: MutationAliasLink[] = [];
  visitOxcScopes(program, null, (node, scope, parent) => {
    if (ignoredHazardTreeNodes.has(node)) {
      return;
    }

    if (
      node.type === 'CatchClause' &&
      node.param &&
      parent?.type === 'TryStatement'
    ) {
      const thrownExpressions = collectThrownExpressions(
        parent.block,
        ignoredHazardTreeNodes
      );
      const sourceExpressions = [
        ...thrownExpressions,
        ...collectPatternDefaultExpressions(node.param),
      ];
      aliasLinks.push({
        declaredAt: node.param.end,
        executionOwner: getExecutionOwner(bindingIndex, node),
        sources: [
          ...new Set(
            sourceExpressions.flatMap((expression) =>
              collectCapturedAliasReferenceKeys(expression)
            )
          ),
        ],
        targets: collectDeclaredBindingKeys(
          collectOxcPatternBindingNames(node.param),
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
            executionOwner: getExecutionOwner(bindingIndex, node),
            sources: [
              ...new Set(
                sourceExpressions.flatMap((expression) =>
                  collectCapturedAliasReferenceKeys(expression)
                )
              ),
            ],
            targets: collectDeclaredBindingKeys(
              collectOxcPatternBindingNames(declarator.id),
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
          executionOwner: getExecutionOwner(bindingIndex, node),
          sources: [
            ...new Set(
              sourceExpressions.flatMap((expression) =>
                collectCapturedAliasReferenceKeys(expression)
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
      const sources = collectCapturedAliasReferenceKeys(node);
      if (deferredFunctionsWithUnknownAlias.has(node)) {
        sources.push(unknownAliasMutationBinding);
      }
      aliasLinks.push({
        callableNode: node,
        declaredAt: scope.parent?.start ?? 0,
        executionOwner: getExecutionOwner(bindingIndex, node),
        sourceChangesAffectTargets: false,
        sources: [...new Set(sources)],
        targetChangeCanAffectSources: (change, target) =>
          collectInvocationTargetKeys(change, collectReferenceKeys).includes(
            target
          ),
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
          executionOwner: getExecutionOwner(bindingIndex, node),
          sources: [
            ...new Set(
              defaultExpressions.flatMap((expression) =>
                collectCapturedAliasReferenceKeys(expression)
              )
            ),
          ],
          targets: collectDeclaredBindingKeys(
            collectOxcPatternBindingNames(param),
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
        classNode: node,
        declaredAt: node.end,
        executionOwner: getExecutionOwner(bindingIndex, node),
        sources: collectCapturedAliasReferenceKeys(node),
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
        executionOwner: getExecutionOwner(bindingIndex, node),
        sources: collectCapturedAliasReferenceKeys(node.right),
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
          collectCapturedAliasReferenceKeys(expression)
        )
      ),
    ];
    const targets = collectDeclaredBindingKeys(
      collectOxcPatternBindingNames(node.id),
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
      const isFunctionValue = !!node.init && isOxcFunctionLike(node.init);
      const directSources =
        isFunctionValue && node.init
          ? collectCapturedAliasReferenceKeys(node.init)
          : sources;
      if (
        isFunctionValue &&
        node.init &&
        deferredFunctionsWithUnknownAlias.has(node.init)
      ) {
        directSources.push(unknownAliasMutationBinding);
      }
      aliasLinks.push({
        callableNode: isFunctionValue ? node.init! : undefined,
        declaredAt: node.end,
        executionOwner: getExecutionOwner(bindingIndex, node),
        sourceChangesAffectTargets: isFunctionValue ? false : undefined,
        sources: [...new Set(directSources)],
        targetChangeCanAffectSources: isFunctionValue
          ? (change, target) =>
              collectInvocationTargetKeys(
                change,
                collectReferenceKeys
              ).includes(target)
          : undefined,
        targets: directTargets,
        unprovenResult: isFunctionValue ? false : unprovenResult,
      });
    }
    if (restTargets.length > 0) {
      aliasLinks.push({
        declaredAt: node.end,
        executionOwner: getExecutionOwner(bindingIndex, node),
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

  publishDeferredUnknownAliasSources(
    aliasLinks,
    deferredFunctionsWithUnknownAlias,
    containingClassByDeferredFunction,
    unknownAliasMutationBinding
  );

  // Propagation capability forms an absent < weak < strong lattice, while
  // published hazard membership is tracked separately from modeled mutation
  // seeds. The indexes let each new fact or promotion visit only adjacent
  // links instead of rescanning the complete alias graph.
  type WorkItem = { change: Node; key: string; strong: boolean };
  const worklist: WorkItem[] = [];
  mutations.forEach((changes, key) => {
    const facts = getFacts(key);
    changes.forEach((change) => {
      facts.set(change, (facts.get(change) ?? 0) | factStrong);
    });
  });
  factsByBinding.forEach((facts, key) => {
    facts.forEach((state, change) => {
      worklist.push({
        change,
        key,
        strong: (state & factStrong) !== 0,
      });
    });
  });

  const publishHazard = (key: string, change: Node): void => {
    const facts = getFacts(key);
    const current = facts.get(change) ?? 0;
    if ((current & factPublished) !== 0) {
      return;
    }
    facts.set(change, current | factPublished);
    const bucket = hazards.get(key) ?? [];
    bucket.push(change);
    hazards.set(key, bucket);
  };
  const addFact = (key: string, change: Node, sibling: boolean): void => {
    const facts = getFacts(key);
    const state = facts.get(change);
    publishHazard(key, change);
    if (state === undefined) {
      facts.set(change, factPublished | (sibling ? factStrong : 0));
      worklist.push({ change, key, strong: sibling });
      return;
    }
    if ((state & factStrong) === 0 && sibling) {
      facts.set(change, state | factPublished | factStrong);
      worklist.push({ change, key, strong: true });
    }
  };
  const endpointIsStrong = (keys: readonly string[], change: Node): boolean => {
    for (const key of keys) {
      if (((factsByBinding.get(key)?.get(change) ?? 0) & factStrong) !== 0) {
        return true;
      }
    }
    return false;
  };

  const linksBySource = new Map<string, typeof aliasLinks>();
  const linksByTarget = new Map<string, typeof aliasLinks>();
  const indexLink = (
    index: Map<string, typeof aliasLinks>,
    key: string,
    link: (typeof aliasLinks)[number]
  ): void => {
    const bucket = index.get(key) ?? [];
    bucket.push(link);
    index.set(key, bucket);
  };
  aliasLinks.forEach((link) => {
    // Link producers canonicalize both endpoint lists before registration.
    link.sources.forEach((key) => indexLink(linksBySource, key, link));
    link.targets.forEach((key) => indexLink(linksByTarget, key, link));
  });

  type ImportGroup = {
    bindings: string[];
    broadcasted: Set<Node>;
  };
  const importGroupsByBinding = new Map<string, ImportGroup[]>();
  const importGroups: ImportGroup[] = [];
  importedBindingsBySource.forEach((bindings) => {
    const group = { bindings, broadcasted: new Set<Node>() };
    importGroups.push(group);
    bindings.forEach((binding) => {
      const groups = importGroupsByBinding.get(binding) ?? [];
      groups.push(group);
      importGroupsByBinding.set(binding, groups);
    });
  });

  let cursor = 0;
  while (cursor < worklist.length) {
    const item = worklist[cursor]!;
    cursor += 1;
    const current = factsByBinding.get(item.key)?.get(item.change);
    if (
      current === undefined ||
      (!item.strong && (current & factStrong) !== 0)
    ) {
      continue;
    }

    const targetLinks = linksByTarget.get(item.key);
    if (targetLinks) {
      for (const link of targetLinks) {
        if (
          item.change.start < link.declaredAt ||
          (link.targetChangeCanAffectSources &&
            !link.targetChangeCanAffectSources(item.change, item.key))
        ) {
          continue;
        }
        if (link.unprovenResult) {
          addFact(unknownAliasMutationBinding, item.change, false);
        }
        const strong = endpointIsStrong(link.targets, item.change);
        for (const source of link.sources) {
          addFact(source, item.change, strong);
        }
      }
    }

    const sourceLinks = linksBySource.get(item.key);
    if (sourceLinks) {
      for (const link of sourceLinks) {
        if (
          link.sourceChangesAffectTargets === false ||
          item.change.start < link.declaredAt ||
          (link.sourceChangeCanAffectTargets &&
            !link.sourceChangeCanAffectTargets(item.change))
        ) {
          continue;
        }
        const strong = endpointIsStrong(link.sources, item.change);
        for (const target of link.targets) {
          addFact(target, item.change, strong);
        }
      }
    }

    if ((current & factStrong) !== 0) {
      const importGroupsForBinding = importGroupsByBinding.get(item.key);
      if (importGroupsForBinding) {
        for (const importGroup of importGroupsForBinding) {
          if (importGroup.broadcasted.has(item.change)) {
            continue;
          }
          importGroup.broadcasted.add(item.change);
          for (const binding of importGroup.bindings) {
            addFact(binding, item.change, true);
          }
        }
      }
    }
  }

  // Imported mutation/sibling facts conservatively affect unknown aliases,
  // but this final publication is intentionally weak and does not re-enter the
  // worklist.
  importGroups.forEach(({ broadcasted }) => {
    broadcasted.forEach((change) =>
      publishHazard(unknownAliasMutationBinding, change)
    );
  });

  // Independent worklist paths can discover nested equal-end nodes in either
  // order. Canonical source order preserves the stable tie behavior when O6
  // seals the separate start and end timelines.
  hazards.forEach((nodes) => {
    if (nodes.length > 1) {
      nodes.sort((left, right) => left.start - right.start);
    }
  });

  return hazards;
};

export const collectProgramMutationAnalysis = (
  program: Program,
  bindingIndex: BindingIndex,
  ignoredMutationHazardNodes: ReadonlySet<Node>,
  ignoredMutationHazardTreeNodes: ReadonlySet<Node>,
  hasEffectiveMutationHazardSeed: boolean
): Pick<
  ProgramAnalysis,
  'rootMutationHazardsByBinding' | 'rootMutationsByBinding'
> => {
  const rootMutationsByBinding = collectRootMutations(program);
  const rootMutationHazardsByBinding =
    rootMutationsByBinding.size === 0 && !hasEffectiveMutationHazardSeed
      ? new Map<string, Node[]>()
      : collectRootMutationHazards(
          program,
          rootMutationsByBinding,
          bindingIndex,
          ignoredMutationHazardNodes,
          ignoredMutationHazardTreeNodes
        );

  return {
    rootMutationHazardsByBinding: sealMutationTimelineMap(
      rootMutationHazardsByBinding
    ),
    rootMutationsByBinding: sealMutationTimelineMap(rootMutationsByBinding),
  };
};
