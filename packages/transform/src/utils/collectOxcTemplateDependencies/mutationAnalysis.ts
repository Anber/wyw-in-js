/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  AssignmentExpression,
  Expression,
  Node,
  Program,
  UpdateExpression,
  VariableDeclaration,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { resolveBindingInIndex } from './bindingResolution';
import { findReferences, visitOxcScopes } from './scopeTraversal';
import type {
  Binding,
  BindingIndex,
  ProgramAnalysis,
  ReferenceIdentifier,
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
  bindingIndex: BindingIndex,
  ignoredHazardNodes: ReadonlySet<Node>
): Map<string, Node[]> => {
  const { bindingsByName } = bindingIndex;
  const hazards = new Map<string, Node[]>();
  const siblingHazards = new Map<string, Node[]>();

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
              collectReferenceKeys(expression)
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
                  collectReferenceKeys(expression)
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
    rootMutationHazardsByBinding,
    rootMutationsByBinding,
  };
};
