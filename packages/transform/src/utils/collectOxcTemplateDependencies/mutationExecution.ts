/* eslint-disable no-restricted-syntax,no-continue */

import type {
  AssignmentExpression,
  Expression,
  Node,
  Program,
  UpdateExpression,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { getOxcSyntacticPropertyKey } from '../oxc/projections';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import { findResolvedReferences as getReferences } from './bindingResolution';
import {
  emptyMutationTimeline,
  sealMutationTimeline,
} from './mutationTimeline';
import type { Binding, BindingIndex, MutationTimeline } from './types';

type ExecutionOwner = Node | null;

export type MutationAliasLink = {
  callableNode?: Node;
  classNode?: Node;
  declaredAt: number;
  executionOwner?: Node | null;
  sourceChangeCanAffectTargets?: (change: Node) => boolean;
  sourceChangesAffectTargets?: boolean;
  sources: string[];
  targetChangeCanAffectSources?: (change: Node, target: string) => boolean;
  targets: string[];
  unprovenResult: boolean;
};

type ExecutionIndex = {
  readonly filteredTimelines: WeakMap<
    MutationTimeline<Node>,
    Map<ExecutionOwner, MutationTimeline<Node>>
  >;
  readonly ownerByStart: Map<number, ExecutionOwner>;
  readonly parentByFunction: Map<Node, ExecutionOwner>;
  readonly postChildEvaluationEffects: WeakSet<Node>;
};

const executionIndexes = new WeakMap<BindingIndex, ExecutionIndex>();

const getExecutionIndex = (bindingIndex: BindingIndex): ExecutionIndex => {
  const existing = executionIndexes.get(bindingIndex);
  if (existing) {
    return existing;
  }

  const created: ExecutionIndex = {
    filteredTimelines: new WeakMap(),
    ownerByStart: new Map(),
    parentByFunction: new Map(),
    postChildEvaluationEffects: new WeakSet(),
  };
  executionIndexes.set(bindingIndex, created);
  return created;
};

export const registerExecutionFunction = (
  bindingIndex: BindingIndex,
  node: Node,
  parent: ExecutionOwner
): void => {
  getExecutionIndex(bindingIndex).parentByFunction.set(node, parent);
};

export const registerExecutionNode = (
  bindingIndex: BindingIndex,
  node: Node,
  owner: ExecutionOwner
): void => {
  const { ownerByStart } = getExecutionIndex(bindingIndex);
  if (!ownerByStart.has(node.start)) {
    ownerByStart.set(node.start, owner);
  }
};

export const registerPostChildEvaluationEffect = (
  bindingIndex: BindingIndex,
  node: Node
): void => {
  getExecutionIndex(bindingIndex).postChildEvaluationEffects.add(node);
};

export const getExecutionOwner = (
  bindingIndex: BindingIndex,
  node: Node
): ExecutionOwner =>
  executionIndexes.get(bindingIndex)?.ownerByStart.get(node.start) ?? null;

const isExecutionOwnerVisible = (
  effectOwner: ExecutionOwner,
  targetOwner: ExecutionOwner,
  parentByFunction: ReadonlyMap<Node, ExecutionOwner>
): boolean => {
  if (effectOwner === null) {
    return true;
  }

  let current = targetOwner;
  while (current) {
    if (current === effectOwner) {
      return true;
    }
    current = parentByFunction.get(current) ?? null;
  }
  return false;
};

export const getExecutionVisibleMutationTimeline = (
  bindingIndex: BindingIndex,
  timeline: MutationTimeline<Node>,
  targetStart: number
): MutationTimeline<Node> => {
  if (timeline.byStart.length === 0) {
    return emptyMutationTimeline;
  }

  const index = executionIndexes.get(bindingIndex);
  if (!index) {
    return timeline;
  }

  const targetOwner = index.ownerByStart.get(targetStart) ?? null;
  let timelinesByOwner = index.filteredTimelines.get(timeline);
  if (!timelinesByOwner) {
    timelinesByOwner = new Map();
    index.filteredTimelines.set(timeline, timelinesByOwner);
  }
  const cached = timelinesByOwner.get(targetOwner);
  if (cached) {
    return cached;
  }

  const visible = timeline.byStart.filter((effect) =>
    isExecutionOwnerVisible(
      index.ownerByStart.get(effect.start) ?? null,
      targetOwner,
      index.parentByFunction
    )
  );
  const result =
    visible.length === timeline.byStart.length
      ? timeline
      : sealMutationTimeline(visible);
  timelinesByOwner.set(targetOwner, result);
  return result;
};

export const someExecutionAncestorEffect = (
  bindingIndex: BindingIndex,
  timeline: MutationTimeline<Node>,
  targetStart: number,
  predicate: (effect: Node) => boolean
): boolean => {
  const index = executionIndexes.get(bindingIndex);
  const targetOwner = index?.ownerByStart.get(targetStart) ?? null;
  if (!index || !targetOwner) {
    return false;
  }

  return timeline.byStart.some((effect) => {
    const effectOwner = index.ownerByStart.get(effect.start) ?? null;
    return (
      effectOwner !== targetOwner &&
      !(
        index.postChildEvaluationEffects.has(effect) &&
        effect.start <= targetStart &&
        targetStart < effect.end
      ) &&
      isExecutionOwnerVisible(
        effectOwner,
        targetOwner,
        index.parentByFunction
      ) &&
      predicate(effect)
    );
  });
};

export const findContainingClass = (ancestors: readonly Node[]): Node | null =>
  [...ancestors]
    .reverse()
    .find(
      (ancestor) =>
        ancestor.type === 'ClassDeclaration' ||
        ancestor.type === 'ClassExpression'
    ) ?? null;

export const publishDeferredUnknownAliasSources = (
  aliasLinks: MutationAliasLink[],
  deferredFunctions: Set<Node>,
  containingClassByFunction: ReadonlyMap<Node, Node>,
  unknownAliasKey: string
): void => {
  aliasLinks.forEach((link) => {
    if (link.unprovenResult && link.executionOwner) {
      deferredFunctions.add(link.executionOwner);
    }
  });
  const deferredClasses = new Set(
    [...deferredFunctions]
      .map((node) => containingClassByFunction.get(node))
      .filter((node): node is Node => !!node)
  );
  aliasLinks.forEach((link) => {
    if (
      (link.callableNode && deferredFunctions.has(link.callableNode)) ||
      (link.classNode && deferredClasses.has(link.classNode))
    ) {
      if (!link.sources.includes(unknownAliasKey)) {
        link.sources.push(unknownAliasKey);
      }
    }
  });
};

export type DeferredReferencePolicy = {
  ignoredRoots: ReadonlySet<Node>;
  ignoredStarts: ReadonlySet<number>;
};

export const collectMutationReferenceKeys = (
  node: Node,
  bindingIndex: BindingIndex,
  ignoredStarts: readonly ReadonlySet<number>[],
  toKey: (binding: Binding | null, name: string) => string,
  includeBinding: (binding: Binding | null) => boolean = () => true
): string[] => [
  ...new Set(
    getReferences(node, bindingIndex)
      .filter(
        (reference) =>
          ignoredStarts.every((starts) => !starts.has(reference.start)) &&
          includeBinding(reference.binding)
      )
      .map(({ binding, name }) => toKey(binding, name))
  ),
];

export const collectRootMutations = (
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
      return { binding: node.name, path: [] };
    }
    if (node.type !== 'MemberExpression') {
      return null;
    }

    const parent = getRootMutationTarget(node.object);
    const key = getOxcSyntacticPropertyKey(node.property, node.computed);
    return !parent || key === null
      ? null
      : { binding: parent.binding, path: [...parent.path, key] };
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

const containsOpaqueAliasConstruct = (
  node: Node,
  bindingIndex: BindingIndex,
  ignoredTreeNodes: ReadonlySet<Node>,
  ignoredReferenceStarts: ReadonlySet<number>,
  ignoredSubtreeRootSets: readonly ReadonlySet<Node>[] = [],
  ignoredExtraReferenceStartSets: readonly ReadonlySet<number>[] = []
): boolean => {
  if (
    ignoredTreeNodes.has(node) ||
    ignoredSubtreeRootSets.some((roots) => roots.has(node))
  ) {
    return false;
  }

  return (
    node.type === 'CallExpression' ||
    node.type === 'NewExpression' ||
    node.type === 'TaggedTemplateExpression' ||
    node.type === 'ImportExpression' ||
    node.type === 'ThisExpression' ||
    node.type === 'Super' ||
    (node.type === 'MemberExpression' &&
      getReferences(node, bindingIndex).every(
        (reference) =>
          ignoredReferenceStarts.has(reference.start) ||
          ignoredExtraReferenceStartSets.some((starts) =>
            starts.has(reference.start)
          )
      )) ||
    getOxcNodeChildren(node).some((child) =>
      containsOpaqueAliasConstruct(
        child,
        bindingIndex,
        ignoredTreeNodes,
        ignoredReferenceStarts,
        ignoredSubtreeRootSets,
        ignoredExtraReferenceStartSets
      )
    )
  );
};

export const containsUnprovenAliasSource = (
  node: Node,
  bindingIndex: BindingIndex,
  ignoredTreeNodes: ReadonlySet<Node>,
  ignoredReferenceStarts: ReadonlySet<number>,
  ignoredSubtreeRootSets: readonly ReadonlySet<Node>[] = [],
  ignoredExtraReferenceStartSets: readonly ReadonlySet<number>[] = []
): boolean =>
  !ignoredTreeNodes.has(node) &&
  !ignoredSubtreeRootSets.some((roots) => roots.has(node)) &&
  (getReferences(node, bindingIndex).some(
    (reference) =>
      !ignoredReferenceStarts.has(reference.start) &&
      ignoredExtraReferenceStartSets.every(
        (starts) => !starts.has(reference.start)
      ) &&
      reference.binding === null
  ) ||
    containsOpaqueAliasConstruct(
      node,
      bindingIndex,
      ignoredTreeNodes,
      ignoredReferenceStarts,
      ignoredSubtreeRootSets,
      ignoredExtraReferenceStartSets
    ));

export const collectThrownExpressions = (
  node: Node,
  ignoredTreeNodes: ReadonlySet<Node>,
  expressions: Expression[] = []
): Expression[] => {
  if (ignoredTreeNodes.has(node)) {
    return expressions;
  }

  if (isOxcFunctionLike(node)) {
    return expressions;
  }

  if (node.type === 'ThrowStatement') {
    expressions.push(node.argument);
    return expressions;
  }

  getOxcNodeChildren(node).forEach((child) =>
    collectThrownExpressions(child, ignoredTreeNodes, expressions)
  );
  return expressions;
};

export const isImmediatelyInvokedFunction = (
  functionNode: Node,
  ancestors: readonly Node[]
): boolean => {
  let child = functionNode;
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]!;
    if (
      ancestor.type === 'ParenthesizedExpression' &&
      ancestor.expression === child
    ) {
      child = ancestor;
      continue;
    }
    if (
      ancestor.type === 'SequenceExpression' &&
      ancestor.expressions[ancestor.expressions.length - 1] === child
    ) {
      child = ancestor;
      continue;
    }
    if (
      ancestor.type === 'ConditionalExpression' &&
      (ancestor.consequent === child || ancestor.alternate === child)
    ) {
      child = ancestor;
      continue;
    }
    if (
      ancestor.type === 'LogicalExpression' &&
      (ancestor.left === child || ancestor.right === child)
    ) {
      child = ancestor;
      continue;
    }
    if (ancestor.type === 'AssignmentExpression' && ancestor.right === child) {
      child = ancestor;
      continue;
    }

    return (
      ((ancestor.type === 'CallExpression' ||
        ancestor.type === 'NewExpression') &&
        ancestor.callee === child) ||
      (ancestor.type === 'TaggedTemplateExpression' && ancestor.tag === child)
    );
  }

  return false;
};

export const createDeferredReferencePolicyCollector = (
  bindingIndex: BindingIndex
): ((node: Node) => DeferredReferencePolicy) => {
  const cache = new WeakMap<Node, DeferredReferencePolicy>();
  return (node: Node): DeferredReferencePolicy => {
    const cached = cache.get(node);
    if (cached) {
      return cached;
    }

    const ignoredRoots = new Set<Node>();
    const ignoredStarts = new Set<number>();
    const ancestors: Node[] = [];
    const visit = (current: Node): void => {
      if (
        isOxcFunctionLike(current) &&
        !isImmediatelyInvokedFunction(current, ancestors)
      ) {
        ignoredRoots.add(current);
        getReferences(current, bindingIndex).forEach(({ start }) =>
          ignoredStarts.add(start)
        );
        return;
      }

      ancestors.push(current);
      getOxcNodeChildren(current).forEach(visit);
      ancestors.pop();
    };
    visit(node);

    const policy = { ignoredRoots, ignoredStarts };
    cache.set(node, policy);
    return policy;
  };
};

export const collectInvocationTargetKeys = (
  change: Node,
  collectReferenceKeys: (node: Node) => readonly string[]
): string[] => {
  let invocationTarget: Node | null = null;
  if (change.type === 'CallExpression' || change.type === 'NewExpression') {
    invocationTarget = change.callee;
  } else if (change.type === 'TaggedTemplateExpression') {
    invocationTarget = change.tag;
  }
  if (!invocationTarget) {
    return [];
  }

  const keys = new Set<string>();
  const collect = (target: Node): void => {
    if (
      target.type === 'ParenthesizedExpression' ||
      target.type === 'TSAsExpression' ||
      target.type === 'TSInstantiationExpression' ||
      target.type === 'TSNonNullExpression' ||
      target.type === 'TSSatisfiesExpression' ||
      target.type === 'TSTypeAssertion' ||
      target.type === 'ChainExpression'
    ) {
      collect(target.expression);
      return;
    }
    if (target.type === 'SequenceExpression') {
      const last = target.expressions[target.expressions.length - 1];
      if (last) {
        collect(last);
      }
      return;
    }
    if (target.type === 'ConditionalExpression') {
      collect(target.consequent);
      collect(target.alternate);
      return;
    }
    if (target.type === 'LogicalExpression') {
      collect(target.left);
      collect(target.right);
      return;
    }
    if (target.type === 'AssignmentExpression') {
      collect(target.right);
      return;
    }
    if (target.type === 'Identifier') {
      collectReferenceKeys(target).forEach((key) => keys.add(key));
      return;
    }
    if (target.type === 'MemberExpression') {
      const property = getOxcSyntacticPropertyKey(
        target.property,
        target.computed
      );
      if (property === 'call' || property === 'apply') {
        collect(target.object);
      }
    }
  };
  collect(invocationTarget);
  return [...keys];
};
