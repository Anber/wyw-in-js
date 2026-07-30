/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { Node } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { isOxcFunctionLike } from '../oxc/runtimeSemantics';
import {
  findReferences,
  getRootMutationHazards,
  resolveBindingAt,
  toMutationBindingKey,
} from './scopeAnalysis';
import { isKnownPureStaticCall } from './staticEvaluator';
import type { Binding, ExpressionSpan, ExtractionContext } from './types';

export const allocateHoistedBindingName = (
  originalName: string,
  ctx: ExtractionContext
): string => {
  const sanitized = originalName.replace(/[^A-Za-z0-9_$]/g, '_') || 'hoisted';
  const base = /^[A-Za-z_$]/.test(sanitized) ? `_${sanitized}` : '_hoisted';
  let candidate = base;
  let idx = 2;

  while (ctx.usedNames.has(candidate)) {
    candidate = `${base}${idx}`;
    idx += 1;
  }

  ctx.usedNames.add(candidate);
  return candidate;
};

export const countPatternBindingNames = (pattern: Node): Map<string, number> =>
  collectOxcPatternBindingNames(pattern).reduce((names, name) => {
    names.set(name, (names.get(name) ?? 0) + 1);
    return names;
  }, new Map<string, number>());

export const hasDestructuringIntrinsicMutationBefore = (
  pattern: Node,
  referenceStart: number,
  ctx: ExtractionContext
): boolean => {
  const intrinsicNames =
    pattern.type === 'ArrayPattern' ? ['Array', 'Object'] : ['Object', 'Array'];

  return intrinsicNames.some((name) => {
    const changesUnshadowedIntrinsic = (change: Node): boolean =>
      !resolveBindingAt(ctx, name, change.start);

    return (
      (ctx.rootMutationsByBinding.get(name) ?? []).some(
        (mutation) =>
          mutation.start < referenceStart &&
          changesUnshadowedIntrinsic(mutation)
      ) ||
      getRootMutationHazards(ctx.rootMutationHazardsByBinding, name).some(
        (hazard) =>
          hazard.end <= referenceStart && changesUnshadowedIntrinsic(hazard)
      )
    );
  });
};

export const isOpaqueDestructuringHazard = (
  hazard: Node,
  ctx: ExtractionContext
): boolean => {
  if (hazard.type === 'TaggedTemplateExpression') {
    return !ctx.processorManagedExpressionSpans.has(expressionSpanKey(hazard));
  }

  return !isKnownPureStaticCall(hazard, ctx);
};

export const hasAnyBindingChange = (
  binding: Binding,
  ctx: ExtractionContext
): boolean => {
  const bindingKey = toMutationBindingKey(binding);
  return (
    (ctx.rootMutationsByBinding.get(bindingKey)?.length ?? 0) > 0 ||
    getRootMutationHazards(ctx.rootMutationHazardsByBinding, bindingKey).some(
      (hazard) => isOpaqueDestructuringHazard(hazard, ctx)
    )
  );
};

export const expressionSpanKey = (
  node: Pick<ExpressionSpan, 'end' | 'start'>
): string => `${node.start}:${node.end}`;

export const addHoistedCode = (
  key: string,
  code: string,
  ctx: ExtractionContext
): void => {
  if (ctx.hoistedDeclarations.has(key)) {
    return;
  }

  ctx.hoistedDeclarations.set(key, code);
  const declarations =
    ctx.hoistedDeclarationsByInsertionPoint.get(ctx.currentInsertionPoint) ??
    [];
  declarations.push(code);
  ctx.hoistedDeclarationsByInsertionPoint.set(
    ctx.currentInsertionPoint,
    declarations
  );
};

type OxcBlockStatement = Extract<Node, { type: 'BlockStatement' }>;

export const snapshotReplayError = (): Error =>
  new Error(
    `This identifier cannot be used in the template, because its local snapshot depends on executed side effects that cannot be safely hoisted.`
  );

export class OxcSnapshotWriteUnsupportedError extends Error {
  constructor() {
    super(
      `This identifier cannot be used in the template, because its local snapshot depends on executed side effects that cannot be safely hoisted.`
    );
    this.name = 'OxcSnapshotWriteUnsupportedError';
  }
}

const isFunctionBoundaryNode = isOxcFunctionLike;

const findSnapshotBody = (
  node: Node,
  binding: Binding
): OxcBlockStatement | null => {
  if (
    node.type === 'BlockStatement' &&
    node.start === binding.scope.start &&
    node.end === binding.scope.end
  ) {
    return node;
  }

  for (const child of getOxcNodeChildren(node)) {
    if (child.start <= binding.scope.start && binding.scope.end <= child.end) {
      const result = findSnapshotBody(child, binding);
      if (result) {
        return result;
      }
    }
  }

  return null;
};

const directSnapshotOwner = (
  body: OxcBlockStatement,
  node: Node
): Node | null =>
  body.body.find(
    (statement) => statement.start <= node.start && node.end <= statement.end
  ) ?? null;

const findSnapshotReplayBoundary = (
  node: Node,
  position: number,
  ctx: ExtractionContext
): Node | null => {
  if (position < node.start || node.end <= position) {
    return null;
  }

  for (const child of getOxcNodeChildren(node)) {
    const boundary = findSnapshotReplayBoundary(child, position, ctx);
    if (boundary) {
      return boundary;
    }
  }

  return node.type === 'TaggedTemplateExpression' ||
    (node.type === 'CallExpression' &&
      ctx.processorManagedExpressionSpans.has(expressionSpanKey(node)))
    ? node
    : null;
};

const snapshotReplayKey = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const boundary = findSnapshotReplayBoundary(
    ctx.program,
    ctx.currentExpressionStart,
    ctx
  );
  return `\0wyw-static-snapshot:${binding.scope.start}:${binding.scope.end}:${
    boundary
      ? `${boundary.start}:${boundary.end}`
      : `expression:${ctx.currentExpressionStart}`
  }`;
};

const crossesDeferredFunctionBoundary = (
  owner: Node,
  target: Node
): boolean => {
  const visit = (node: Node, crossed: boolean): boolean | null => {
    if (node === target) {
      return crossed;
    }

    for (const child of getOxcNodeChildren(node)) {
      if (child.start <= target.start && target.end <= child.end) {
        const result = visit(
          child,
          crossed || (child !== target && isFunctionBoundaryNode(child))
        );
        if (result !== null) {
          return result;
        }
      }
    }

    return null;
  };

  return visit(owner, false) ?? true;
};

const collectMutationTargetRoots = (node: Node, roots: Node[] = []): Node[] => {
  if (node.type === 'Identifier') {
    roots.push(node);
    return roots;
  }

  if (node.type === 'MemberExpression') {
    return collectMutationTargetRoots(node.object, roots);
  }

  if (node.type === 'AssignmentPattern') {
    return collectMutationTargetRoots(node.left, roots);
  }

  if (node.type === 'RestElement') {
    return collectMutationTargetRoots(node.argument, roots);
  }

  if (node.type === 'ObjectPattern') {
    node.properties.forEach((property) => {
      collectMutationTargetRoots(
        property.type === 'RestElement' ? property.argument : property.value,
        roots
      );
    });
    return roots;
  }

  if (node.type === 'ArrayPattern') {
    node.elements.forEach((element) => {
      if (element) {
        collectMutationTargetRoots(element, roots);
      }
    });
  }

  return roots;
};

const callReferenceRoot = (node: Node): Node | null => {
  let current = node;
  while (
    current.type === 'ParenthesizedExpression' ||
    current.type === 'ChainExpression' ||
    current.type === 'TSAsExpression' ||
    current.type === 'TSSatisfiesExpression' ||
    current.type === 'TSTypeAssertion' ||
    current.type === 'TSNonNullExpression' ||
    current.type === 'TSInstantiationExpression'
  ) {
    const { expression } = current as Node & { expression?: Node };
    if (!expression) {
      return null;
    }
    current = expression;
  }

  if (current.type === 'Identifier') {
    return current;
  }

  if (current.type === 'MemberExpression') {
    return callReferenceRoot(current.object);
  }

  return current;
};

const collectSnapshotStatements = (
  binding: Binding,
  ctx: ExtractionContext
): Node[] => {
  const { declarator } = binding;
  const functionScope = binding.scope.parent;
  const body = findSnapshotBody(ctx.program, binding);
  if (
    !declarator ||
    !body ||
    !functionScope?.functionBoundary ||
    !functionScope.parent?.root
  ) {
    throw snapshotReplayError();
  }

  if (
    (declarator.id.type === 'ObjectPattern' ||
      declarator.id.type === 'ArrayPattern') &&
    hasDestructuringIntrinsicMutationBefore(
      declarator.id,
      Number.POSITIVE_INFINITY,
      ctx
    )
  ) {
    throw snapshotReplayError();
  }

  const selectedStatements = new Set<Node>();
  const pendingStatements: Node[] = [];
  const relevantBindings = new Set<Binding>();
  const pendingBindings: Binding[] = [];
  const directClasses = new Map<string, Node>();
  body.body.forEach((statement) => {
    if (statement.type === 'ClassDeclaration' && statement.id) {
      directClasses.set(statement.id.name, statement);
    }
  });

  const includeStatement = (statement: Node): void => {
    if (
      selectedStatements.has(statement) ||
      statement.end > ctx.currentExpressionStart
    ) {
      return;
    }

    if (
      statement.type === 'VariableDeclaration' &&
      statement.declarations.length !== 1
    ) {
      throw snapshotReplayError();
    }

    selectedStatements.add(statement);
    pendingStatements.push(statement);
  };

  const declarationOwner = (candidate: Binding): Node | null => {
    const declaration = candidate.declaration ?? candidate.functionNode;
    return declaration ? directSnapshotOwner(body, declaration) : null;
  };

  const includeBinding = (candidate: Binding): void => {
    if (relevantBindings.has(candidate)) {
      return;
    }

    relevantBindings.add(candidate);
    pendingBindings.push(candidate);

    const directClass = directClasses.get(candidate.name);
    const owner =
      declarationOwner(candidate) ??
      (directClass?.start === candidate.declaredAt ? directClass : null);
    if (owner) {
      if (candidate.declaredAt >= ctx.currentExpressionStart) {
        throw snapshotReplayError();
      }
      includeStatement(owner);
    }
  };

  const targetOwner = directSnapshotOwner(
    body,
    binding.declaration ?? declarator
  );
  if (!targetOwner) {
    throw snapshotReplayError();
  }
  includeStatement(targetOwner);
  includeBinding(binding);

  while (pendingStatements.length > 0 || pendingBindings.length > 0) {
    while (pendingStatements.length > 0) {
      const statement = pendingStatements.shift()!;
      findReferences(statement, ctx.referencesByNode).forEach(
        ({ name, start }) => {
          const dependency = resolveBindingAt(ctx, name, start);
          if (dependency) {
            includeBinding(dependency);
            return;
          }

          const classDeclaration = directClasses.get(name);
          if (classDeclaration) {
            includeStatement(classDeclaration);
          }
        }
      );
    }

    while (pendingBindings.length > 0) {
      const dependency = pendingBindings.shift()!;
      const dependencyKey = toMutationBindingKey(dependency);
      const changes: Node[] = [
        ...(ctx.rootMutationsByBinding.get(dependencyKey) ?? []),
        ...getRootMutationHazards(
          ctx.rootMutationHazardsByBinding,
          dependencyKey
        ).filter((hazard) => isOpaqueDestructuringHazard(hazard, ctx)),
      ];

      changes.forEach((change) => {
        if (
          change.start < body.start ||
          change.end > ctx.currentExpressionStart
        ) {
          return;
        }

        const owner = directSnapshotOwner(body, change);
        if (owner && !crossesDeferredFunctionBoundary(owner, change)) {
          includeStatement(owner);
        }
      });
    }
  }

  const selected = [...selectedStatements].sort(
    (left, right) => left.start - right.start
  );
  const selectedClassNames = new Set(
    selected.flatMap((statement) =>
      statement.type === 'ClassDeclaration' && statement.id
        ? [statement.id.name]
        : []
    )
  );
  const isInternalBinding = (candidate: Binding): boolean =>
    selected.some(
      (statement) =>
        (statement.start <= candidate.declaredAt &&
          candidate.declaredAt < statement.end) ||
        (statement.start <= candidate.scope.start &&
          candidate.scope.end <= statement.end)
    );
  const assertInternalReference = (name: string, start: number): void => {
    if (selectedClassNames.has(name)) {
      return;
    }

    const dependency = resolveBindingAt(ctx, name, start);
    if (
      !dependency &&
      (name === 'undefined' || name === 'NaN' || name === 'Infinity')
    ) {
      return;
    }
    if (dependency && isInternalBinding(dependency)) {
      return;
    }

    if (dependency?.importedFrom && !hasAnyBindingChange(dependency, ctx)) {
      return;
    }

    if (
      dependency?.kind === 'variable' &&
      dependency.isRoot &&
      dependency.declarationKind === 'const' &&
      !!dependency.declaration &&
      dependency.declaration.end <= ctx.currentInsertionPoint &&
      (ctx.rootMutationsByBinding.get(toMutationBindingKey(dependency))
        ?.length ?? 0) === 0 &&
      getRootMutationHazards(
        ctx.rootMutationHazardsByBinding,
        toMutationBindingKey(dependency)
      ).every((hazard) => !isOpaqueDestructuringHazard(hazard, ctx))
    ) {
      return;
    }

    throw snapshotReplayError();
  };
  const assertInternalCall = (callee: Node): void => {
    const root = callReferenceRoot(callee);
    if (
      root?.type === 'FunctionExpression' ||
      root?.type === 'ArrowFunctionExpression'
    ) {
      if (root.async) {
        throw snapshotReplayError();
      }
      return;
    }

    if (!root || root.type !== 'Identifier') {
      throw snapshotReplayError();
    }

    if (selectedClassNames.has(root.name)) {
      return;
    }

    const dependency = resolveBindingAt(ctx, root.name, root.start);
    if (!dependency || !isInternalBinding(dependency)) {
      throw snapshotReplayError();
    }
  };
  const assertInternalMutation = (target: Node): void => {
    const roots = collectMutationTargetRoots(target);
    if (roots.length === 0) {
      throw snapshotReplayError();
    }

    roots.forEach((root) => {
      if (root.type !== 'Identifier') {
        throw snapshotReplayError();
      }
      if (selectedClassNames.has(root.name)) {
        return;
      }

      const dependency = resolveBindingAt(ctx, root.name, root.start);
      if (!dependency || !isInternalBinding(dependency)) {
        throw snapshotReplayError();
      }
    });
  };
  const validateNode = (node: Node): void => {
    if (
      node.type === 'ThisExpression' ||
      node.type === 'Super' ||
      node.type === 'AwaitExpression' ||
      node.type === 'YieldExpression' ||
      node.type === 'MetaProperty'
    ) {
      throw snapshotReplayError();
    }

    if (node.type === 'AssignmentExpression') {
      assertInternalMutation(node.left);
    } else if (node.type === 'UpdateExpression') {
      assertInternalMutation(node.argument);
    } else if (node.type === 'UnaryExpression' && node.operator === 'delete') {
      assertInternalMutation(node.argument);
    } else if (
      node.type === 'CallExpression' ||
      node.type === 'NewExpression'
    ) {
      assertInternalCall(node.callee);
    } else if (node.type === 'TaggedTemplateExpression') {
      assertInternalCall(node.tag);
    }

    getOxcNodeChildren(node).forEach(validateNode);
  };

  selected.forEach((statement) => {
    findReferences(statement, ctx.referencesByNode).forEach(
      ({ name, start }) => {
        if (name === 'arguments') {
          throw snapshotReplayError();
        }
        assertInternalReference(name, start);
      }
    );
    validateNode(statement);
  });

  return selected;
};

type SnapshotReplayGroup = {
  bindings: Set<Binding>;
  insertionPoint: number;
  name: string;
  statements: Set<Node>;
};

const snapshotReplayGroups = new WeakMap<
  ExtractionContext,
  Map<string, SnapshotReplayGroup>
>();

const snapshotReplayCode = (
  group: SnapshotReplayGroup,
  ctx: ExtractionContext
): string => {
  const bindingNames = [
    ...new Set(
      [...group.bindings].flatMap(({ declarator }) =>
        declarator ? [...countPatternBindingNames(declarator.id).keys()] : []
      )
    ),
  ];
  const statements = [...group.statements].sort(
    (left, right) => left.start - right.start
  );

  return `const ${
    group.name
  } = (() => {\nlet initialized = false;\nlet value;\nreturn () => {\nif (!initialized) {\nvalue = (() => {\n${statements
    .map((statement) => ctx.code.slice(statement.start, statement.end))
    .join('\n')}\nreturn { ${bindingNames.join(
    ', '
  )} };\n})();\ninitialized = true;\n}\nreturn value;\n};\n})();`;
};

export const addHoistedSnapshotReplay = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const { declarator } = binding;
  if (!declarator) {
    throw snapshotReplayError();
  }

  const replayKey = snapshotReplayKey(binding, ctx);
  let groups = snapshotReplayGroups.get(ctx);
  if (!groups) {
    groups = new Map();
    snapshotReplayGroups.set(ctx, groups);
  }

  let group = groups.get(replayKey);
  if (!group) {
    group = {
      bindings: new Set(),
      insertionPoint: ctx.currentInsertionPoint,
      name: allocateHoistedBindingName('snapshot', ctx),
      statements: new Set(),
    };
    groups.set(replayKey, group);
    ctx.hoistedBindingNames.set(replayKey, group.name);
  }

  collectSnapshotStatements(binding, ctx).forEach((statement) =>
    group.statements.add(statement)
  );
  group.bindings.add(binding);

  const nextCode = snapshotReplayCode(group, ctx);
  const previousCode = ctx.hoistedDeclarations.get(replayKey);
  if (!previousCode) {
    addHoistedCode(replayKey, nextCode, ctx);
  } else if (previousCode !== nextCode) {
    const declarations = ctx.hoistedDeclarationsByInsertionPoint.get(
      group.insertionPoint
    );
    const declarationIndex = declarations?.indexOf(previousCode) ?? -1;
    if (!declarations || declarationIndex < 0) {
      throw snapshotReplayError();
    }
    declarations[declarationIndex] = nextCode;
    ctx.hoistedDeclarations.set(replayKey, nextCode);
  }

  return `${group.name}().${binding.name}`;
};
