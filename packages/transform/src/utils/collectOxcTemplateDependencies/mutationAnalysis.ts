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
import { getOxcSyntacticPropertyKey } from '../oxc/projections';
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
  ignoredHazardNodes: Set<Node>
): void => {
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

    const key = getOxcSyntacticPropertyKey(node.property, node.computed);
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

const containsOpaqueAliasConstruct = (
  node: Node,
  bindingIndex: BindingIndex
): boolean =>
  node.type === 'CallExpression' ||
  node.type === 'NewExpression' ||
  node.type === 'TaggedTemplateExpression' ||
  node.type === 'ImportExpression' ||
  node.type === 'ThisExpression' ||
  node.type === 'Super' ||
  (node.type === 'MemberExpression' &&
    getReferences(node, bindingIndex).length === 0) ||
  getOxcNodeChildren(node).some((child) =>
    containsOpaqueAliasConstruct(child, bindingIndex)
  );

const containsUnprovenAliasSource = (
  node: Node,
  bindingIndex: BindingIndex
): boolean =>
  getReferences(node, bindingIndex).some(
    (reference) => reference.binding === null
  ) || containsOpaqueAliasConstruct(node, bindingIndex);

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
  bindingIndex: BindingIndex,
  ignoredHazardNodes: ReadonlySet<Node>
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

  const collectReferenceKeys = (node: Node): string[] => [
    ...new Set(
      getReferences(node, bindingIndex).map(({ binding, name }) =>
        binding ? toMutationBindingKey(binding) : name
      )
    ),
  ];

  const processorManagedAliasReferenceStarts = new Set<number>();
  ignoredHazardNodes.forEach((node) => {
    if (node.type !== 'TaggedTemplateExpression') {
      return;
    }
    getReferences(node, bindingIndex).forEach(({ start }) =>
      processorManagedAliasReferenceStarts.add(start)
    );
  });
  const collectAliasReferenceKeys = (node: Node): string[] => [
    ...new Set(
      getReferences(node, bindingIndex)
        .filter(
          (reference) =>
            !processorManagedAliasReferenceStarts.has(reference.start)
        )
        .map(({ binding, name }) =>
          binding ? toMutationBindingKey(binding) : name
        )
    ),
  ];

  const containsUnprovenAlias = (node: Node): boolean =>
    containsUnprovenAliasSource(node, bindingIndex);

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
    collectReferenceKeys(node).forEach((key) => {
      addHazard(key, hazard, canAffectSiblingImport);
    });
  };

  const addUnknownAliasHazard = (node: Node, hazard: Node): void => {
    if (containsUnprovenAlias(node)) {
      addHazard(unknownAliasMutationBinding, hazard);
    }
  };

  visitOxcScopes(program, null, (node) => {
    if (!isEffectiveMutationHazardSeed(node, ignoredHazardNodes)) {
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
  visitOxcScopes(program, null, (node, scope, parent) => {
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
              collectAliasReferenceKeys(expression)
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
            sources: [
              ...new Set(
                sourceExpressions.flatMap((expression) =>
                  collectAliasReferenceKeys(expression)
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
          sources: [
            ...new Set(
              sourceExpressions.flatMap((expression) =>
                collectAliasReferenceKeys(expression)
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
        sources: collectAliasReferenceKeys(node),
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
                collectAliasReferenceKeys(expression)
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
        declaredAt: node.end,
        sources: collectAliasReferenceKeys(node),
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
        sources: collectAliasReferenceKeys(node.right),
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
          collectAliasReferenceKeys(expression)
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
      aliasLinks.push({
        declaredAt: node.end,
        sourceChangesAffectTargets: isFunctionValue ? false : undefined,
        sources,
        targetChangeCanAffectSources: isFunctionValue
          ? (change) =>
              change.type === 'CallExpression' ||
              change.type === 'NewExpression' ||
              change.type === 'TaggedTemplateExpression'
          : undefined,
        targets: directTargets,
        unprovenResult: isFunctionValue ? false : unprovenResult,
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
            !link.targetChangeCanAffectSources(item.change))
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
          ignoredMutationHazardNodes
        );

  return {
    rootMutationHazardsByBinding: sealMutationTimelineMap(
      rootMutationHazardsByBinding
    ),
    rootMutationsByBinding: sealMutationTimelineMap(rootMutationsByBinding),
  };
};
