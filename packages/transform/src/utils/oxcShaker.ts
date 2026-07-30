/* eslint-disable no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';

import type { ImportOverrides } from '@wyw-in-js/shared';

import { collectOxcExportsAndImportsFromProgram } from './collectOxcExportsAndImports';
import type {
  collectOxcExportsAndImports,
  OxcCollectedImport,
} from './collectOxcExportsAndImports';
import { isOxcNode as isNode } from './oxc/ast';
import { collectOxcPatternIdentifierNames as collectPatternNames } from './oxc/patterns';
import {
  appendOxcRuntimePropertyPathKey,
  appendOxcRuntimePropertyPath,
  createOxcRuntimePropertyPath,
  getOxcRuntimePropertyPathKeyRoot,
  isOxcRuntimePropertyPathKeyEqualOrDescendant,
  matchesOxcRuntimePropertyPath,
  replaceOxcRuntimePropertyPathKeyRoot,
  replaceOxcRuntimePropertyPathRoot,
  type OxcRuntimePropertyPath,
  type OxcRuntimePropertyPathKey,
} from './oxc/projections';
import {
  collectAssignedAliasRoots,
  collectClassAccessors,
  collectClassCallables,
  collectObjectAccessors,
  collectObjectCallables,
  collectTopLevelAccessors,
  collectTopLevelAliases,
  collectTopLevelCallables,
  collectTopLevelClasses,
  getCalleeBinding,
  getStaticMemberPath,
  type ClassNode,
} from './oxcShaker/bindingProvenance';
import {
  collectExternalReferences,
  collectMutations,
  collectNestedMutations,
  collectReferences,
  forEachModuleExecutedNode,
  forEachModuleExecutedNodeWithParent,
  getImmediatelyInvokedFunction,
  hasModuleInvocationCandidate,
  isMemberRead,
  unwrapAliasExpression,
  type CallableNode,
} from './oxcShaker/executableIndex';
import {
  finalizeShakenModule,
  hasImportOverride,
  parseShakerModule,
  removeExportKeyword,
  splitExportedVariableDeclaration,
  type Replacement,
} from './oxcShaker/moduleRewrites';
import {
  isPattern,
  isProvenNonAbruptPatternEvaluation,
  isReceiverOperationProvenInert as proveReceiverOperationInert,
  type PatternInitializerResolver,
  type ReceiverOperation,
} from './oxcShaker/patternEffects';

type AnyNode = Node & Record<string, unknown>;

type OxcShakerOptions = {
  importOverrides?: ImportOverrides;
  keepSideEffects?: boolean;
  onlyExports: string[];
  root?: string;
};

type StatementInfo = {
  bindings: Set<string>;
  exportNames: Set<string>;
  imports: OxcCollectedImport[];
  mutations: Set<string>;
  node: Node;
  references: Set<string>;
  sideEffectImport: boolean;
};

export type OxcShakerResult = {
  code: string;
  imports: Map<string, string[]>;
};

const declarationBindings = (
  declaration: Node | null | undefined
): string[] => {
  if (!declaration) {
    return [];
  }

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((item) =>
      collectPatternNames(item.id)
    );
  }

  if (
    (declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'ClassDeclaration' ||
      declaration.type === 'TSEnumDeclaration') &&
    declaration.id
  ) {
    return [declaration.id.name];
  }

  return [];
};

const moduleExportName = (node: Node): string | null => {
  if (node.type === 'Identifier' || node.type === 'Literal') {
    return String((node as AnyNode).name ?? (node as AnyNode).value);
  }

  return null;
};

const hasModuleExecutedImportedCall = (
  node: Node,
  aliasesImportedRoot: (binding: string) => boolean
): boolean => {
  let found = false;

  forEachModuleExecutedNode(node, (current) => {
    if (found) {
      return;
    }

    let callee: string | null = null;
    if (current.type === 'CallExpression' || current.type === 'NewExpression') {
      callee = getCalleeBinding(current.callee);
    } else if (current.type === 'TaggedTemplateExpression') {
      callee = getCalleeBinding(current.tag);
    }
    if (callee !== null && aliasesImportedRoot(callee)) {
      found = true;
    }
  });

  return found;
};

type ModuleInvocationEffects = {
  bindings: Set<string>;
  opaqueImportedCall: boolean;
};

const collectModuleInvocationEffects = (
  node: Node,
  rootImportedBindings: ReadonlySet<string>,
  aliasesImportedRoot: (binding: string) => boolean,
  resolveCallable: (binding: string) => CallableNode | undefined,
  resolveAccessor: (binding: string) => CallableNode | undefined,
  resolveClass: (binding: string) => ClassNode | undefined,
  resolveCallableResultRoots: (
    binding: OxcRuntimePropertyPathKey,
    includeDescendants?: boolean
  ) => ReadonlySet<string>,
  resolveCallableCaptureRoots: (binding: string) => ReadonlySet<string>,
  collectInlineCallableCaptureRoots: (
    callable: CallableNode
  ) => ReadonlySet<string>,
  collectCallableExpressionRoots: (value: Node) => ReadonlySet<string>,
  isReceiverOperationProvenInert: (operation: ReceiverOperation) => boolean,
  resolveReceiverOperationRoots: (binding: string) => ReadonlySet<string>
): ModuleInvocationEffects => {
  if (!hasModuleInvocationCandidate(node)) {
    return { bindings: new Set(), opaqueImportedCall: false };
  }

  const bindings = new Set<string>();
  let opaqueImportedCall = false;

  type AliasEnvironment = ReadonlyMap<string, ReadonlySet<string>>;
  const emptyAliases: AliasEnvironment = new Map();

  const resolveAliasBinding = (
    binding: string,
    aliases: AliasEnvironment,
    resolving = new Set<string>()
  ): Set<string> => {
    const mapped = aliases.get(binding);
    if (!mapped) {
      return new Set([binding]);
    }
    if (mapped.size === 0 || resolving.has(binding)) {
      return new Set();
    }

    const roots = new Set<string>();
    const nextResolving = new Set(resolving);
    nextResolving.add(binding);
    mapped.forEach((alias) => {
      resolveAliasBinding(alias, aliases, nextResolving).forEach((root) =>
        roots.add(root)
      );
    });
    return roots;
  };

  const collectContextualRoots = (
    value: Node,
    aliases: AliasEnvironment
  ): Set<string> => {
    const current = unwrapAliasExpression(value);
    if (current.type === 'Identifier') {
      const roots = resolveAliasBinding(current.name, aliases);
      [...roots].forEach((root) => {
        resolveCallableCaptureRoots(root).forEach((capture) =>
          roots.add(capture)
        );
        resolveCallableResultRoots(
          createOxcRuntimePropertyPath(root).key
        ).forEach((capture) => roots.add(capture));
      });
      return roots;
    }

    if (current.type === 'MemberExpression') {
      const roots = collectContextualRoots(current.object, aliases);
      const staticPath = getStaticMemberPath(current);
      if (staticPath) {
        resolveCallableCaptureRoots(staticPath.key).forEach((capture) =>
          roots.add(capture)
        );
        resolveCallableResultRoots(staticPath.key).forEach((capture) =>
          roots.add(capture)
        );
      } else {
        [...roots].forEach((root) => {
          resolveCallableResultRoots(
            createOxcRuntimePropertyPath(root).key,
            true
          ).forEach((capture) => roots.add(capture));
        });
      }
      return roots;
    }

    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return new Set(
        collectInlineCallableCaptureRoots(current as CallableNode)
      );
    }

    if (current.type === 'ConditionalExpression') {
      return new Set([
        ...collectContextualRoots(current.consequent, aliases),
        ...collectContextualRoots(current.alternate, aliases),
      ]);
    }

    if (current.type === 'LogicalExpression') {
      return new Set([
        ...collectContextualRoots(current.left, aliases),
        ...collectContextualRoots(current.right, aliases),
      ]);
    }

    if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      return last ? collectContextualRoots(last, aliases) : new Set();
    }

    if (current.type === 'AssignmentExpression') {
      return collectContextualRoots(current.right, aliases);
    }

    if (current.type === 'ArrayExpression') {
      const roots = new Set<string>();
      current.elements.forEach((element) => {
        if (element) {
          const item =
            element.type === 'SpreadElement' ? element.argument : element;
          collectContextualRoots(item, aliases).forEach((root) =>
            roots.add(root)
          );
        }
      });
      return roots;
    }

    if (current.type === 'ObjectExpression') {
      const roots = new Set<string>();
      current.properties.forEach((property) => {
        const item =
          property.type === 'SpreadElement'
            ? property.argument
            : property.value;
        collectContextualRoots(item, aliases).forEach((root) =>
          roots.add(root)
        );
      });
      return roots;
    }

    if (current.type === 'AwaitExpression') {
      return collectContextualRoots(current.argument, aliases);
    }

    if (current.type === 'CallExpression') {
      const roots = new Set(collectCallableExpressionRoots(current));
      const calleeBinding = getCalleeBinding(current.callee);
      if (
        calleeBinding &&
        [...resolveAliasBinding(calleeBinding, aliases)].some(
          aliasesImportedRoot
        )
      ) {
        rootImportedBindings.forEach((root) => roots.add(root));
      }
      return roots;
    }

    return new Set();
  };

  const addRoots = (
    value: Node,
    aliases: AliasEnvironment = emptyAliases
  ): void => {
    collectContextualRoots(value, aliases).forEach((root) =>
      bindings.add(root)
    );
  };

  const addReceiverOperationEffects = (
    operation: ReceiverOperation,
    aliases: AliasEnvironment
  ): void => {
    if (isReceiverOperationProvenInert(operation)) {
      return;
    }

    const roots = collectContextualRoots(operation.receiver, aliases);
    collectExternalReferences(operation.receiver).forEach((binding) => {
      resolveAliasBinding(binding, aliases).forEach((root) => roots.add(root));
    });
    roots.add('Object');
    if (operation.kind === 'iterate') {
      roots.add('Array');
    }
    [...roots].forEach((root) => {
      bindings.add(root);
      resolveReceiverOperationRoots(root).forEach((resolved) =>
        bindings.add(resolved)
      );
    });
  };

  const addReceiverOperationsForNode = (
    current: Node,
    parent: Node | null,
    aliases: AliasEnvironment
  ): void => {
    const addMemberOperation = (
      member: Extract<Node, { type: 'MemberExpression' }>,
      kind: ReceiverOperation['kind']
    ): void => {
      addReceiverOperationEffects(
        {
          kind,
          property: {
            computed: member.computed,
            key: member.property,
          },
          receiver: member.object,
        },
        aliases
      );
    };

    const addPatternOperations = (pattern: Node, value: Node): void => {
      const currentPattern = unwrapAliasExpression(pattern);
      if (currentPattern.type === 'ArrayPattern') {
        addReceiverOperationEffects(
          { kind: 'iterate', receiver: value },
          aliases
        );
        return;
      }
      if (currentPattern.type !== 'ObjectPattern') {
        return;
      }

      currentPattern.properties.forEach((property) => {
        if (property.type === 'RestElement') {
          addReceiverOperationEffects(
            { kind: 'copy', receiver: value },
            aliases
          );
          return;
        }
        addReceiverOperationEffects(
          {
            kind: 'get',
            property: {
              computed: property.computed,
              key: property.key,
            },
            receiver: value,
          },
          aliases
        );
      });
    };

    if (current.type === 'VariableDeclaration') {
      current.declarations.forEach((declarator) => {
        if (declarator.init) {
          addPatternOperations(declarator.id, declarator.init);
        }
      });
      return;
    }

    if (current.type === 'MemberExpression' && isMemberRead(current, parent)) {
      addMemberOperation(current, 'get');
      return;
    }

    if (
      current.type === 'AssignmentExpression' &&
      current.left.type === 'MemberExpression'
    ) {
      addMemberOperation(current.left, 'set');
      return;
    }
    if (current.type === 'AssignmentExpression' && current.operator === '=') {
      addPatternOperations(current.left, current.right);
    }

    if (
      current.type === 'UpdateExpression' &&
      current.argument.type === 'MemberExpression'
    ) {
      addMemberOperation(current.argument, 'set');
      return;
    }

    if (
      current.type === 'UnaryExpression' &&
      current.operator === 'delete' &&
      current.argument.type === 'MemberExpression'
    ) {
      addMemberOperation(current.argument, 'delete');
      return;
    }

    if (current.type === 'BinaryExpression' && current.operator === 'in') {
      addReceiverOperationEffects(
        {
          kind: 'has',
          property: {
            computed: true,
            key: current.left,
          },
          receiver: current.right,
        },
        aliases
      );
      return;
    }

    if (current.type === 'ForInStatement') {
      addReceiverOperationEffects(
        { kind: 'ownKeys', receiver: current.right },
        aliases
      );
      return;
    }

    if (current.type === 'ForOfStatement') {
      addReceiverOperationEffects(
        { kind: 'iterate', receiver: current.right },
        aliases
      );
      return;
    }

    if (
      current.type === 'YieldExpression' &&
      current.delegate &&
      current.argument
    ) {
      addReceiverOperationEffects(
        { kind: 'iterate', receiver: current.argument },
        aliases
      );
      return;
    }

    if (current.type === 'SpreadElement') {
      if (parent?.type === 'ArrayExpression') {
        addReceiverOperationEffects(
          { kind: 'iterate', receiver: current.argument },
          aliases
        );
      } else if (parent?.type === 'ObjectExpression') {
        addReceiverOperationEffects(
          { kind: 'copy', receiver: current.argument },
          aliases
        );
      }
      return;
    }

    if (current.type !== 'CallExpression') {
      return;
    }

    const intrinsic = getStaticMemberPath(current.callee);
    const firstArgument = current.arguments[0];
    if (!firstArgument || firstArgument.type === 'SpreadElement') {
      return;
    }

    if (
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'keys') ||
      matchesOxcRuntimePropertyPath(
        intrinsic,
        'Object',
        'getOwnPropertyNames'
      ) ||
      matchesOxcRuntimePropertyPath(
        intrinsic,
        'Object',
        'getOwnPropertySymbols'
      ) ||
      matchesOxcRuntimePropertyPath(
        intrinsic,
        'Object',
        'getOwnPropertyDescriptors'
      ) ||
      matchesOxcRuntimePropertyPath(intrinsic, 'Reflect', 'ownKeys')
    ) {
      addReceiverOperationEffects(
        { kind: 'ownKeys', receiver: firstArgument },
        aliases
      );
    } else if (
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'values') ||
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'entries')
    ) {
      addReceiverOperationEffects(
        { kind: 'copy', receiver: firstArgument },
        aliases
      );
    } else if (
      matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'fromEntries') ||
      matchesOxcRuntimePropertyPath(intrinsic, 'Array', 'from')
    ) {
      addReceiverOperationEffects(
        { kind: 'iterate', receiver: firstArgument },
        aliases
      );
    } else if (matchesOxcRuntimePropertyPath(intrinsic, 'Object', 'assign')) {
      current.arguments.slice(1).forEach((argument) => {
        if (argument.type !== 'SpreadElement') {
          addReceiverOperationEffects(
            { kind: 'copy', receiver: argument },
            aliases
          );
        }
      });
    }
  };

  const addInvokedBinding = (
    binding: string,
    aliases: AliasEnvironment,
    staticPath: OxcRuntimePropertyPath | null
  ): void => {
    resolveAliasBinding(binding, aliases).forEach((root) => {
      bindings.add(root);
      const resultBinding =
        staticPath?.root === binding
          ? replaceOxcRuntimePropertyPathRoot(staticPath, root).key
          : createOxcRuntimePropertyPath(root).key;
      resolveCallableResultRoots(resultBinding, staticPath === null).forEach(
        (resultRoot) => bindings.add(resultRoot)
      );
    });
  };

  const addInvokedCalleeBindings = (
    callee: Node,
    aliases: AliasEnvironment
  ): void => {
    const current = unwrapAliasExpression(callee);
    if (current.type === 'Identifier' || current.type === 'MemberExpression') {
      const binding = getCalleeBinding(current);
      if (binding) {
        addInvokedBinding(binding, aliases, getStaticMemberPath(current));
        if (
          [...resolveAliasBinding(binding, aliases)].some(aliasesImportedRoot)
        ) {
          opaqueImportedCall = true;
        }
      } else if (
        current.type === 'MemberExpression' &&
        unwrapAliasExpression(current.object).type === 'CallExpression'
      ) {
        collectCallableExpressionRoots(current.object).forEach((root) =>
          bindings.add(root)
        );
      }
      return;
    }

    const addExpression = (expression: Node): void =>
      addInvokedCalleeBindings(expression, aliases);
    if (current.type === 'ConditionalExpression') {
      addExpression(current.consequent);
      addExpression(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addExpression(current.left);
      addExpression(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        addExpression(last);
      }
    } else if (current.type === 'AssignmentExpression') {
      addExpression(current.right);
    } else if (current.type === 'AwaitExpression') {
      addExpression(current.argument);
    } else if (current.type === 'CallExpression') {
      collectCallableExpressionRoots(current).forEach((root) =>
        bindings.add(root)
      );
    }
  };

  const collectScopedCallables = (
    body: Node,
    inherited: ReadonlyMap<string, CallableNode>
  ): Map<string, CallableNode> => {
    const scoped = new Map(inherited);
    forEachModuleExecutedNode(body, (current) => {
      if (current.type === 'FunctionDeclaration' && current.id) {
        scoped.set(current.id.name, current as CallableNode);
        return;
      }

      if (current.type === 'ClassDeclaration' && current.id) {
        collectClassCallables(
          current,
          createOxcRuntimePropertyPath(current.id.name).key,
          scoped
        );
        return;
      }

      if (current.type !== 'VariableDeclaration') {
        return;
      }
      current.declarations.forEach((declarator) => {
        if (declarator.id.type !== 'Identifier' || !declarator.init) {
          return;
        }

        const initializer = unwrapAliasExpression(declarator.init);
        if (
          initializer.type === 'FunctionExpression' ||
          initializer.type === 'ArrowFunctionExpression'
        ) {
          scoped.set(declarator.id.name, initializer as CallableNode);
        } else if (initializer.type === 'ClassExpression') {
          collectClassCallables(
            initializer,
            createOxcRuntimePropertyPath(declarator.id.name).key,
            scoped
          );
        } else if (initializer.type === 'ObjectExpression') {
          collectObjectCallables(
            initializer,
            createOxcRuntimePropertyPath(declarator.id.name).key,
            scoped
          );
        }
      });
    });
    return scoped;
  };

  const collectScopedClasses = (
    body: Node,
    inherited: ReadonlyMap<string, ClassNode>
  ): Map<string, ClassNode> => {
    const scoped = new Map(inherited);
    forEachModuleExecutedNode(body, (current) => {
      if (current.type === 'ClassDeclaration' && current.id) {
        scoped.set(current.id.name, current as ClassNode);
        return;
      }

      if (current.type !== 'VariableDeclaration') {
        return;
      }
      current.declarations.forEach((declarator) => {
        if (declarator.id.type !== 'Identifier' || !declarator.init) {
          return;
        }

        const initializer = unwrapAliasExpression(declarator.init);
        if (initializer.type === 'ClassExpression') {
          scoped.set(declarator.id.name, initializer as ClassNode);
        }
      });
    });
    return scoped;
  };

  const collectScopedAccessors = (
    body: Node,
    inherited: ReadonlyMap<string, CallableNode>
  ): Map<string, CallableNode> => {
    const scoped = new Map(inherited);
    forEachModuleExecutedNode(body, (current) => {
      if (current.type === 'ClassDeclaration' && current.id) {
        collectClassAccessors(
          current,
          createOxcRuntimePropertyPath(current.id.name).key,
          scoped
        );
        return;
      }

      if (current.type !== 'VariableDeclaration') {
        return;
      }
      current.declarations.forEach((declarator) => {
        if (declarator.id.type !== 'Identifier' || !declarator.init) {
          return;
        }

        const initializer = unwrapAliasExpression(declarator.init);
        if (initializer.type === 'ClassExpression') {
          collectClassAccessors(
            initializer,
            createOxcRuntimePropertyPath(declarator.id.name).key,
            scoped
          );
        } else if (initializer.type === 'ObjectExpression') {
          collectObjectAccessors(
            initializer,
            createOxcRuntimePropertyPath(declarator.id.name).key,
            scoped
          );
        }
      });
    });
    return scoped;
  };

  const collectCallableAliases = (
    callable: CallableNode,
    args: readonly (Node | null)[],
    callerAliases: AliasEnvironment
  ): Map<string, Set<string>> => {
    const aliases = new Map<string, Set<string>>();
    const addBindingRoots = (
      pattern: Node,
      roots: ReadonlySet<string>
    ): boolean => {
      let changed = false;
      collectPatternNames(pattern).forEach((binding) => {
        const previous = aliases.get(binding);
        if (!previous) {
          aliases.set(binding, new Set(roots));
          changed = true;
          return;
        }
        roots.forEach((root) => {
          if (!previous.has(root)) {
            previous.add(root);
            changed = true;
          }
        });
      });
      return changed;
    };

    callable.params.forEach((parameter, index) => {
      const argument = args[index];
      const roots =
        argument && argument.type !== 'SpreadElement'
          ? collectContextualRoots(argument, callerAliases)
          : new Set<string>();
      if (parameter.type === 'AssignmentPattern') {
        collectContextualRoots(parameter.right, aliases).forEach((root) =>
          roots.add(root)
        );
      }
      addBindingRoots(parameter, roots);
    });

    const assignments: Array<{ pattern: Node; value: Node }> = [];
    forEachModuleExecutedNode(callable.body, (current) => {
      if (current.type === 'VariableDeclaration') {
        current.declarations.forEach((declarator) => {
          if (declarator.init) {
            assignments.push({
              pattern: declarator.id,
              value: declarator.init,
            });
          }
        });
      } else if (
        current.type === 'AssignmentExpression' &&
        current.operator === '=' &&
        collectPatternNames(current.left).length > 0
      ) {
        assignments.push({
          pattern: current.left,
          value: current.right,
        });
      }
    });

    let changed = true;
    let passes = assignments.length + 1;
    while (changed && passes > 0) {
      passes -= 1;
      changed = assignments
        .map(({ pattern, value }) =>
          addBindingRoots(pattern, collectContextualRoots(value, aliases))
        )
        .some(Boolean);
    }

    return aliases;
  };

  const resolveCalleeCallables = (
    callee: Node,
    aliases: AliasEnvironment,
    scopedCallables: ReadonlyMap<string, CallableNode>
  ): Set<CallableNode> => {
    const current = unwrapAliasExpression(callee);
    const resolved = new Set<CallableNode>();
    const addBinding = (binding: string): void => {
      resolveAliasBinding(binding, aliases).forEach((alias) => {
        const callable = scopedCallables.get(alias) ?? resolveCallable(alias);
        if (callable) {
          resolved.add(callable);
        }
      });
    };
    const addExpression = (expression: Node): void => {
      resolveCalleeCallables(expression, aliases, scopedCallables).forEach(
        (callable) => resolved.add(callable)
      );
    };

    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      resolved.add(current as CallableNode);
      return resolved;
    }

    const staticPath = getStaticMemberPath(current);
    if (staticPath) {
      if (staticPath.segments.length === 0) {
        addBinding(staticPath.key);
      } else {
        resolveAliasBinding(staticPath.root, aliases).forEach((alias) =>
          addBinding(replaceOxcRuntimePropertyPathRoot(staticPath, alias).key)
        );
      }
      if (resolved.size > 0) {
        return resolved;
      }
    }

    if (current.type === 'ConditionalExpression') {
      addExpression(current.consequent);
      addExpression(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addExpression(current.left);
      addExpression(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        addExpression(last);
      }
    } else if (current.type === 'AssignmentExpression') {
      addExpression(current.right);
    } else if (current.type === 'AwaitExpression') {
      addExpression(current.argument);
    } else if (current.type === 'MemberExpression') {
      const object = unwrapAliasExpression(current.object);
      let propertyName: string | null = null;
      if (!current.computed && current.property.type === 'Identifier') {
        propertyName = current.property.name;
      } else if (current.property.type === 'Literal') {
        propertyName = String(current.property.value);
      }

      if (object.type === 'NewExpression' && propertyName !== null) {
        const constructorPath = getStaticMemberPath(object.callee);
        if (constructorPath) {
          resolveAliasBinding(constructorPath.root, aliases).forEach(
            (alias) => {
              const aliasedConstructor = replaceOxcRuntimePropertyPathRoot(
                constructorPath,
                alias
              );
              addBinding(
                appendOxcRuntimePropertyPath(
                  appendOxcRuntimePropertyPath(aliasedConstructor, 'prototype'),
                  propertyName
                ).key
              );
            }
          );
        }
      } else if (object.type === 'ArrayExpression') {
        const index =
          propertyName !== null && /^\d+$/.test(propertyName)
            ? Number(propertyName)
            : null;
        const elements =
          index === null ? object.elements : [object.elements[index]];
        elements.forEach((element) => {
          if (element) {
            addExpression(
              element.type === 'SpreadElement' ? element.argument : element
            );
          }
        });
      } else if (object.type === 'ObjectExpression') {
        object.properties.forEach((property) => {
          if (property.type === 'SpreadElement') {
            if (propertyName === null) {
              addExpression(property.argument);
            }
            return;
          }

          let candidateName: string | null = null;
          if (!property.computed && property.key.type === 'Identifier') {
            candidateName = property.key.name;
          } else if (property.key.type === 'Literal') {
            candidateName = String(property.key.value);
          }
          if (propertyName === null || candidateName === propertyName) {
            addExpression(property.value);
          }
        });
      }
    }

    return resolved;
  };

  const resolveCalleeClasses = (
    callee: Node,
    aliases: AliasEnvironment,
    scopedClasses: ReadonlyMap<string, ClassNode>
  ): Set<ClassNode> => {
    const current = unwrapAliasExpression(callee);
    const resolved = new Set<ClassNode>();
    const addBinding = (binding: string): void => {
      resolveAliasBinding(binding, aliases).forEach((alias) => {
        const classNode = scopedClasses.get(alias) ?? resolveClass(alias);
        if (classNode) {
          resolved.add(classNode);
        }
      });
    };
    const addExpression = (expression: Node): void => {
      resolveCalleeClasses(expression, aliases, scopedClasses).forEach(
        (classNode) => resolved.add(classNode)
      );
    };

    if (current.type === 'ClassExpression') {
      resolved.add(current as ClassNode);
      return resolved;
    }

    const staticPath = getStaticMemberPath(current);
    if (staticPath) {
      addBinding(staticPath.key);
      if (resolved.size > 0) {
        return resolved;
      }
    }

    if (current.type === 'ConditionalExpression') {
      addExpression(current.consequent);
      addExpression(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addExpression(current.left);
      addExpression(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        addExpression(last);
      }
    } else if (current.type === 'AssignmentExpression') {
      addExpression(current.right);
    } else if (current.type === 'AwaitExpression') {
      addExpression(current.argument);
    }

    return resolved;
  };

  const resolveMemberAccessors = (
    member: Node,
    aliases: AliasEnvironment,
    scopedAccessors: ReadonlyMap<string, CallableNode>
  ): Set<CallableNode> => {
    const staticPath = getStaticMemberPath(member);
    if (!staticPath) {
      return new Set();
    }

    const resolved = new Set<CallableNode>();
    resolveAliasBinding(staticPath.root, aliases).forEach((alias) => {
      const accessorPath = replaceOxcRuntimePropertyPathRoot(
        staticPath,
        alias
      ).key;
      const accessor =
        scopedAccessors.get(accessorPath) ?? resolveAccessor(accessorPath);
      if (accessor) {
        resolved.add(accessor);
      }
    });
    return resolved;
  };

  let addClassConstructionEffects: (
    classNode: ClassNode,
    args: readonly (Node | null)[],
    callerAliases: AliasEnvironment,
    visiting: Set<CallableNode>,
    inheritedCallables: ReadonlyMap<string, CallableNode>,
    inheritedAccessors: ReadonlyMap<string, CallableNode>,
    inheritedClasses: ReadonlyMap<string, ClassNode>,
    visitingClasses: Set<ClassNode>
  ) => void;

  const addCallableEffects = (
    callable: CallableNode,
    args: readonly (Node | null)[],
    callerAliases: AliasEnvironment,
    visiting: Set<CallableNode>,
    inheritedCallables: ReadonlyMap<string, CallableNode>,
    inheritedAccessors: ReadonlyMap<string, CallableNode>,
    inheritedClasses: ReadonlyMap<string, ClassNode>
  ): void => {
    if (visiting.has(callable)) {
      return;
    }
    visiting.add(callable);

    const aliases = collectCallableAliases(callable, args, callerAliases);
    const scopedCallables = collectScopedCallables(
      callable.body,
      inheritedCallables
    );
    const scopedAccessors = collectScopedAccessors(
      callable.body,
      inheritedAccessors
    );
    const scopedClasses = collectScopedClasses(callable.body, inheritedClasses);
    callable.params.forEach((parameter) => {
      collectPatternNames(parameter).forEach((binding) => {
        resolveAliasBinding(binding, aliases).forEach((root) =>
          bindings.add(root)
        );
      });
    });

    collectMutations(callable.body).forEach((binding) => {
      resolveAliasBinding(binding, aliases).forEach((root) =>
        bindings.add(root)
      );
    });
    if (
      hasModuleExecutedImportedCall(callable.body, (binding) =>
        [...resolveAliasBinding(binding, aliases)].some(aliasesImportedRoot)
      )
    ) {
      opaqueImportedCall = true;
    }

    forEachModuleExecutedNodeWithParent(callable.body, (current, parent) => {
      addReceiverOperationsForNode(current, parent, aliases);

      if (
        current.type === 'MemberExpression' &&
        isMemberRead(current, parent)
      ) {
        resolveMemberAccessors(current, aliases, scopedAccessors).forEach(
          (accessor) =>
            addCallableEffects(
              accessor,
              [],
              aliases,
              visiting,
              scopedCallables,
              scopedAccessors,
              scopedClasses
            )
        );
      }

      if (current.type === 'CallExpression') {
        addInvokedCalleeBindings(current.callee, aliases);
        current.arguments.forEach((argument) => {
          addRoots(
            argument.type === 'SpreadElement' ? argument.argument : argument,
            aliases
          );
        });
        const nestedCallables = resolveCalleeCallables(
          current.callee,
          aliases,
          scopedCallables
        );
        nestedCallables.forEach((nestedCallable) => {
          addCallableEffects(
            nestedCallable,
            current.arguments,
            aliases,
            visiting,
            scopedCallables,
            scopedAccessors,
            scopedClasses
          );
        });
      } else if (current.type === 'NewExpression') {
        addInvokedCalleeBindings(current.callee, aliases);
        current.arguments.forEach((argument) => {
          addRoots(
            argument.type === 'SpreadElement' ? argument.argument : argument,
            aliases
          );
        });
        resolveCalleeCallables(
          current.callee,
          aliases,
          scopedCallables
        ).forEach((constructor) => {
          addCallableEffects(
            constructor,
            current.arguments,
            aliases,
            visiting,
            scopedCallables,
            scopedAccessors,
            scopedClasses
          );
        });
        resolveCalleeClasses(current.callee, aliases, scopedClasses).forEach(
          (classNode) =>
            addClassConstructionEffects(
              classNode,
              current.arguments,
              aliases,
              visiting,
              scopedCallables,
              scopedAccessors,
              scopedClasses,
              new Set()
            )
        );
      } else if (current.type === 'TaggedTemplateExpression') {
        addInvokedCalleeBindings(current.tag, aliases);
        current.quasi.expressions.forEach((expression) =>
          addRoots(expression, aliases)
        );
        const tagArguments: Array<Node | null> = [
          null,
          ...current.quasi.expressions,
        ];
        resolveCalleeCallables(current.tag, aliases, scopedCallables).forEach(
          (tag) => {
            addCallableEffects(
              tag,
              tagArguments,
              aliases,
              visiting,
              scopedCallables,
              scopedAccessors,
              scopedClasses
            );
          }
        );
      }
    });

    visiting.delete(callable);
  };

  addClassConstructionEffects = (
    classNode,
    args,
    callerAliases,
    visiting,
    inheritedCallables,
    inheritedAccessors,
    inheritedClasses,
    visitingClasses
  ): void => {
    if (visitingClasses.has(classNode)) {
      return;
    }
    visitingClasses.add(classNode);

    const constructor = classNode.body.body.find(
      (element) =>
        element.type === 'MethodDefinition' &&
        element.kind === 'constructor' &&
        element.value
    );
    if (constructor?.type === 'MethodDefinition' && constructor.value) {
      addCallableEffects(
        constructor.value as CallableNode,
        args,
        callerAliases,
        visiting,
        inheritedCallables,
        inheritedAccessors,
        inheritedClasses
      );
    }

    classNode.body.body.forEach((element) => {
      if (
        element.type !== 'PropertyDefinition' ||
        element.static === true ||
        !element.value
      ) {
        return;
      }

      collectMutations(element.value).forEach((binding) => {
        resolveAliasBinding(binding, callerAliases).forEach((root) =>
          bindings.add(root)
        );
      });
      if (
        hasModuleExecutedImportedCall(element.value, (binding) =>
          [...resolveAliasBinding(binding, callerAliases)].some(
            aliasesImportedRoot
          )
        )
      ) {
        opaqueImportedCall = true;
      }
      forEachModuleExecutedNodeWithParent(element.value, (current, parent) => {
        addReceiverOperationsForNode(current, parent, callerAliases);

        if (
          current.type === 'MemberExpression' &&
          isMemberRead(current, parent)
        ) {
          resolveMemberAccessors(
            current,
            callerAliases,
            inheritedAccessors
          ).forEach((accessor) =>
            addCallableEffects(
              accessor,
              [],
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses
            )
          );
        }

        if (current.type === 'CallExpression') {
          addInvokedCalleeBindings(current.callee, callerAliases);
          current.arguments.forEach((argument) =>
            addRoots(
              argument.type === 'SpreadElement' ? argument.argument : argument,
              callerAliases
            )
          );
          resolveCalleeCallables(
            current.callee,
            callerAliases,
            inheritedCallables
          ).forEach((callable) =>
            addCallableEffects(
              callable,
              current.arguments,
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses
            )
          );
        } else if (current.type === 'NewExpression') {
          addInvokedCalleeBindings(current.callee, callerAliases);
          current.arguments.forEach((argument) =>
            addRoots(
              argument.type === 'SpreadElement' ? argument.argument : argument,
              callerAliases
            )
          );
          resolveCalleeClasses(
            current.callee,
            callerAliases,
            inheritedClasses
          ).forEach((nestedClass) =>
            addClassConstructionEffects(
              nestedClass,
              current.arguments,
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses,
              visitingClasses
            )
          );
        } else if (current.type === 'TaggedTemplateExpression') {
          addInvokedCalleeBindings(current.tag, callerAliases);
          current.quasi.expressions.forEach((expression) =>
            addRoots(expression, callerAliases)
          );
          const tagArguments: Array<Node | null> = [
            null,
            ...current.quasi.expressions,
          ];
          resolveCalleeCallables(
            current.tag,
            callerAliases,
            inheritedCallables
          ).forEach((tag) =>
            addCallableEffects(
              tag,
              tagArguments,
              callerAliases,
              visiting,
              inheritedCallables,
              inheritedAccessors,
              inheritedClasses
            )
          );
        }
      });
    });

    if (classNode.superClass) {
      resolveCalleeClasses(
        classNode.superClass,
        callerAliases,
        inheritedClasses
      ).forEach((baseClass) =>
        addClassConstructionEffects(
          baseClass,
          args,
          callerAliases,
          visiting,
          inheritedCallables,
          inheritedAccessors,
          inheritedClasses,
          visitingClasses
        )
      );
    }

    visitingClasses.delete(classNode);
  };

  forEachModuleExecutedNodeWithParent(node, (current, parent) => {
    addReceiverOperationsForNode(current, parent, emptyAliases);

    if (current.type === 'MemberExpression' && isMemberRead(current, parent)) {
      resolveMemberAccessors(current, emptyAliases, new Map()).forEach(
        (accessor) =>
          addCallableEffects(
            accessor,
            [],
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map()
          )
      );
    }

    if (current.type === 'CallExpression') {
      addInvokedCalleeBindings(current.callee, emptyAliases);
      current.arguments.forEach((argument) => {
        addRoots(
          argument.type === 'SpreadElement' ? argument.argument : argument
        );
      });

      const callablesForCallee = resolveCalleeCallables(
        current.callee,
        emptyAliases,
        new Map()
      );
      callablesForCallee.forEach((callable) => {
        addCallableEffects(
          callable,
          current.arguments,
          emptyAliases,
          new Set(),
          new Map(),
          new Map(),
          new Map()
        );
      });
      return;
    }

    if (current.type === 'NewExpression') {
      addInvokedCalleeBindings(current.callee, emptyAliases);
      current.arguments.forEach((argument) => {
        addRoots(
          argument.type === 'SpreadElement' ? argument.argument : argument
        );
      });
      resolveCalleeCallables(current.callee, emptyAliases, new Map()).forEach(
        (constructor) => {
          addCallableEffects(
            constructor,
            current.arguments,
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map()
          );
        }
      );
      resolveCalleeClasses(current.callee, emptyAliases, new Map()).forEach(
        (classNode) =>
          addClassConstructionEffects(
            classNode,
            current.arguments,
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map(),
            new Set()
          )
      );
      return;
    }

    if (current.type === 'TaggedTemplateExpression') {
      addInvokedCalleeBindings(current.tag, emptyAliases);
      current.quasi.expressions.forEach((expression) => addRoots(expression));
      const tagArguments: Array<Node | null> = [
        null,
        ...current.quasi.expressions,
      ];
      resolveCalleeCallables(current.tag, emptyAliases, new Map()).forEach(
        (tag) => {
          addCallableEffects(
            tag,
            tagArguments,
            emptyAliases,
            new Set(),
            new Map(),
            new Map(),
            new Map()
          );
        }
      );
    }
  });

  return { bindings, opaqueImportedCall };
};

const hasPotentiallyAbruptPatternEvaluation = (
  node: Node,
  resolveInitializer: PatternInitializerResolver
): boolean => {
  let potentiallyAbrupt = false;
  forEachModuleExecutedNode(node, (current) => {
    if (potentiallyAbrupt) {
      return;
    }

    if (current.type === 'VariableDeclaration') {
      potentiallyAbrupt = current.declarations.some(
        (declarator) =>
          isPattern(declarator.id) &&
          (!declarator.init ||
            !isProvenNonAbruptPatternEvaluation(
              declarator.id,
              declarator.init,
              resolveInitializer
            ))
      );
      return;
    }

    if (
      current.type === 'AssignmentExpression' &&
      current.operator === '=' &&
      isPattern(current.left)
    ) {
      potentiallyAbrupt = !isProvenNonAbruptPatternEvaluation(
        current.left,
        current.right,
        resolveInitializer
      );
    }
  });
  return potentiallyAbrupt;
};

const buildStatementInfo = (
  program: Program,
  collected: ReturnType<typeof collectOxcExportsAndImports>
): StatementInfo[] => {
  const { exports: collectedExports, imports: collectedImports } = collected;
  const importsByStart = new Map<number, OxcCollectedImport[]>();
  collectedImports.forEach((item) => {
    const bucket = importsByStart.get(item.local.start) ?? [];
    bucket.push(item);
    importsByStart.set(item.local.start, bucket);
  });

  return program.body.map((statement) => {
    const node = statement as Node;
    const exportNames = new Set<string>();
    const bindings = new Set<string>();
    const imports: OxcCollectedImport[] = [];
    const references = collectReferences(node);
    let sideEffectImport = false;

    if (node.type === 'ImportDeclaration') {
      sideEffectImport = node.specifiers.length === 0;
      node.specifiers.forEach((specifier) => {
        bindings.add(specifier.local.name);
        const matched = importsByStart.get(specifier.local.start) ?? [];
        imports.push(...matched);
      });

      if (sideEffectImport) {
        const matched = collectedImports.filter(
          (item) =>
            item.imported === 'side-effect' &&
            item.local.start === node.start &&
            item.local.end === node.end
        );
        imports.push(...matched);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
      if (node.declaration) {
        declarationBindings(node.declaration).forEach((name) =>
          exportNames.add(name)
        );
      }

      node.specifiers.forEach((specifier) => {
        const local = moduleExportName(specifier.local);
        const exported = moduleExportName(specifier.exported);
        if (local && !node.source) references.add(local);
        if (exported) exportNames.add(exported);
      });
    } else if (node.type === 'ExportDefaultDeclaration') {
      exportNames.add('default');
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exported) {
        const exported = moduleExportName(node.exported);
        if (exported) {
          exportNames.add(exported);
        }
      } else {
        exportNames.add('*');
      }
    } else {
      Object.entries(collectedExports).forEach(([exported, local]) => {
        if (local.start >= node.start && local.end <= node.end) {
          exportNames.add(exported);
        }
      });
      declarationBindings(node).forEach((name) => bindings.add(name));
    }

    return {
      bindings,
      exportNames,
      imports,
      mutations: collectMutations(node),
      node,
      references,
      sideEffectImport,
    };
  });
};

export const shakeOxcToESM = (
  code: string,
  filename: string,
  options: OxcShakerOptions
): OxcShakerResult => {
  const parsed = parseShakerModule(code, filename);
  const { program } = parsed;
  const collected = collectOxcExportsAndImportsFromProgram(
    program,
    code,
    parsed.isEsModule
  );
  const statements = buildStatementInfo(program, collected);
  const bindingOwners = new Map<string, StatementInfo>();
  statements.forEach((statement) => {
    statement.bindings.forEach((binding) => {
      if (!bindingOwners.has(binding)) {
        bindingOwners.set(binding, statement);
      }
    });
  });
  const patternInitializers = new Map<
    string,
    {
      declarationKind: string;
      owner: StatementInfo;
      value: Node;
    }
  >();
  program.body.forEach((statement, index) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (declaration?.type !== 'VariableDeclaration') {
      return;
    }

    declaration.declarations.forEach((declarator) => {
      if (declarator.id.type === 'Identifier' && declarator.init) {
        patternInitializers.set(declarator.id.name, {
          declarationKind: declaration.kind,
          owner: statements[index]!,
          value: declarator.init,
        });
      } else if (
        declarator.init &&
        (declarator.id.type === 'ObjectPattern' ||
          declarator.id.type === 'ArrayPattern')
      ) {
        const elements =
          declarator.id.type === 'ObjectPattern'
            ? declarator.id.properties
            : declarator.id.elements;
        elements.forEach((element) => {
          if (
            element?.type === 'RestElement' &&
            element.argument.type === 'Identifier'
          ) {
            patternInitializers.set(element.argument.name, {
              declarationKind: declaration.kind,
              owner: statements[index]!,
              value: declarator.init!,
            });
          }
        });
      }
    });
  });

  const requested = new Set(options.onlyExports);
  const keepAllExports = requested.has('*');
  const liveStatements = new Set<StatementInfo>();
  const liveExportStatements = new Set<StatementInfo>();
  const queue: StatementInfo[] = [];
  const bindingQueue: string[] = [];
  const liveBindings = new Set<string>();
  const effectsByBinding = new Map<string, Set<StatementInfo>>();

  const addEffect = (binding: string, statement: StatementInfo): void => {
    const bucket = effectsByBinding.get(binding) ?? new Set<StatementInfo>();
    bucket.add(statement);
    effectsByBinding.set(binding, bucket);
  };

  statements.forEach((statement) => {
    statement.mutations.forEach((binding) => {
      addEffect(binding, statement);
    });
  });

  const rootImportedBindings = new Set<string>();
  statements.forEach((statement) => {
    const { node } = statement;
    if (
      node.type !== 'ImportDeclaration' ||
      (node as AnyNode).importKind === 'type'
    ) {
      return;
    }

    node.specifiers.forEach((specifier) => {
      if ((specifier as AnyNode).importKind !== 'type') {
        rootImportedBindings.add(specifier.local.name);
      }
    });
  });

  // Alias declarations themselves stay dead unless an effect through that
  // alias matters. Only the effects are shared across each alias component;
  // marking one later pulls in the declaration chain via ordinary references.
  const { aliases, nestedAliases } = collectTopLevelAliases(
    program,
    rootImportedBindings
  );
  const aliasComponents = new Map<string, Set<string>>();
  const visitedAliases = new Set<string>();
  aliases.forEach((_directAliases, binding) => {
    if (visitedAliases.has(binding)) {
      return;
    }

    const component = new Set<string>();
    const pending = [binding];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (!component.has(current)) {
        component.add(current);
        visitedAliases.add(current);
        aliasComponents.set(current, component);
        aliases.get(current)?.forEach((alias) => pending.push(alias));
      }
    }
  });

  const aliasesImportedRoot = (binding: string): boolean => {
    if (rootImportedBindings.has(binding)) {
      return true;
    }

    return [...(aliasComponents.get(binding) ?? [])].some((alias) =>
      rootImportedBindings.has(alias)
    );
  };

  const nestedAliasSources = (binding: string): Set<string> => {
    const sources = new Set<string>();
    const visited = new Set<string>();
    const pending = [binding];

    while (pending.length > 0) {
      const current = pending.pop()!;
      const component = aliasComponents.get(current) ?? new Set([current]);
      component.forEach((alias) => {
        if (visited.has(alias)) {
          return;
        }

        visited.add(alias);
        nestedAliases.get(alias)?.forEach((source) => {
          sources.add(source);
          pending.push(source);
        });
      });
    }

    return sources;
  };

  // Import binding identity is not knowable at the root module boundary.
  // Therefore a module-executed mutation through any imported alias, or an
  // opaque imported call, can affect every otherwise-live root import.
  const importedEffects = new Set<StatementInfo>();
  const callables = collectTopLevelCallables(program);
  const accessors = collectTopLevelAccessors(program);
  const classes = collectTopLevelClasses(program);
  const resolveCallable = (binding: string): CallableNode | undefined => {
    const direct = callables.get(binding);
    if (direct) {
      return direct;
    }

    const bindingPath = binding as OxcRuntimePropertyPathKey;
    const root = getOxcRuntimePropertyPathKeyRoot(bindingPath);
    if (root !== binding) {
      const throughObjectAlias = [...(aliasComponents.get(root) ?? [])]
        .map((alias) =>
          callables.get(
            replaceOxcRuntimePropertyPathKeyRoot(bindingPath, alias)
          )
        )
        .find((callable) => callable !== undefined);
      if (throughObjectAlias) {
        return throughObjectAlias;
      }
    }

    return [...(aliasComponents.get(binding) ?? [])]
      .map((alias) => callables.get(alias))
      .find((callable) => callable !== undefined);
  };
  const resolveAccessor = (binding: string): CallableNode | undefined => {
    const direct = accessors.get(binding);
    if (direct) {
      return direct;
    }

    const bindingPath = binding as OxcRuntimePropertyPathKey;
    const root = getOxcRuntimePropertyPathKeyRoot(bindingPath);
    if (root !== binding) {
      const throughObjectAlias = [...(aliasComponents.get(root) ?? [])]
        .map((alias) =>
          accessors.get(
            replaceOxcRuntimePropertyPathKeyRoot(bindingPath, alias)
          )
        )
        .find((accessor) => accessor !== undefined);
      if (throughObjectAlias) {
        return throughObjectAlias;
      }
    }

    return [...(aliasComponents.get(binding) ?? [])]
      .map((alias) => accessors.get(alias))
      .find((accessor) => accessor !== undefined);
  };
  const resolveClass = (binding: string): ClassNode | undefined => {
    const direct = classes.get(binding);
    if (direct) {
      return direct;
    }

    return [...(aliasComponents.get(binding) ?? [])]
      .map((alias) => classes.get(alias))
      .find((classNode) => classNode !== undefined);
  };

  // A separately invoked call result can close over arguments passed while it
  // was created or over bindings reachable from its factory. Keep this
  // fail-closed provenance distinct from object aliases: it becomes an effect
  // only when the result (or one of its aliases) is actually invoked.
  const callableResultRoots = new Map<OxcRuntimePropertyPathKey, Set<string>>();
  const externalReferencesByStatement = new Map<StatementInfo, Set<string>>();
  const getExternalStatementReferences = (
    statement: StatementInfo
  ): Set<string> => {
    const cached = externalReferencesByStatement.get(statement);
    if (cached) {
      return cached;
    }

    const references = collectExternalReferences(statement.node);
    externalReferencesByStatement.set(statement, references);
    return references;
  };
  const collectReachableFactoryReferences = (binding: string): Set<string> => {
    const references = new Set<string>();
    const visited = new Set<string>();
    const pending = [binding];

    while (pending.length > 0) {
      const current = pending.pop()!;
      const component = aliasComponents.get(current) ?? new Set([current]);
      component.forEach((alias) => {
        if (visited.has(alias)) {
          return;
        }
        visited.add(alias);

        const owner = bindingOwners.get(alias);
        if (!owner) {
          return;
        }
        getExternalStatementReferences(owner).forEach((reference) => {
          references.add(reference);
          if (bindingOwners.has(reference)) {
            pending.push(reference);
          }
        });
      });
    }

    return references;
  };

  const callableCaptureRoots = new Map<CallableNode, Set<string>>();
  const collectInlineCallableCaptureRoots = (
    callable: CallableNode
  ): Set<string> => {
    const cached = callableCaptureRoots.get(callable);
    if (cached) {
      return cached;
    }

    const roots = collectExternalReferences(callable);
    [...roots].forEach((root) => {
      collectReachableFactoryReferences(root).forEach((reference) =>
        roots.add(reference)
      );
    });
    callableCaptureRoots.set(callable, roots);
    return roots;
  };
  const resolveCallableCaptureRoots = (binding: string): Set<string> => {
    const callable = resolveCallable(binding);
    return callable
      ? collectInlineCallableCaptureRoots(callable)
      : new Set<string>();
  };

  const addCallableResultRoots = (
    binding: OxcRuntimePropertyPathKey,
    roots: ReadonlySet<string>
  ): void => {
    if (roots.size === 0) {
      return;
    }

    const bucket = callableResultRoots.get(binding) ?? new Set<string>();
    roots.forEach((root) => bucket.add(root));
    callableResultRoots.set(binding, bucket);
  };
  const collectCallResultRoots = (initializer: Node): Set<string> => {
    const current = unwrapAliasExpression(initializer);
    if (current.type !== 'CallExpression') {
      return new Set();
    }

    const roots = new Set<string>();
    const inlineFactory = getImmediatelyInvokedFunction(current.callee);
    if (inlineFactory) {
      collectInlineCallableCaptureRoots(inlineFactory).forEach((root) =>
        roots.add(root)
      );
    }
    const factoryBinding = getCalleeBinding(current.callee);
    if (factoryBinding) {
      collectReachableFactoryReferences(factoryBinding).forEach((root) =>
        roots.add(root)
      );
    }
    current.arguments.forEach((argument) => {
      collectAssignedAliasRoots(
        argument.type === 'SpreadElement' ? argument.argument : argument,
        rootImportedBindings,
        aliases,
        nestedAliases
      ).forEach((root) => roots.add(root));
    });
    return roots;
  };
  const collectCallableExpressionRoots = (value: Node): Set<string> => {
    const current = unwrapAliasExpression(value);
    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      return new Set(
        collectInlineCallableCaptureRoots(current as CallableNode)
      );
    }
    if (current.type === 'CallExpression') {
      return collectCallResultRoots(current);
    }
    if (current.type === 'Identifier') {
      return new Set(resolveCallableCaptureRoots(current.name));
    }
    if (current.type === 'MemberExpression') {
      const staticPath = getStaticMemberPath(current);
      return staticPath
        ? new Set(resolveCallableCaptureRoots(staticPath.key))
        : collectCallableExpressionRoots(current.object);
    }

    const roots = new Set<string>();
    const addValue = (item: Node): void => {
      collectCallableExpressionRoots(item).forEach((root) => roots.add(root));
    };
    if (current.type === 'ArrayExpression') {
      current.elements.forEach((element) => {
        if (element) {
          addValue(
            element.type === 'SpreadElement' ? element.argument : element
          );
        }
      });
    } else if (current.type === 'ObjectExpression') {
      current.properties.forEach((property) => {
        addValue(
          property.type === 'SpreadElement' ? property.argument : property.value
        );
      });
    } else if (current.type === 'ConditionalExpression') {
      addValue(current.consequent);
      addValue(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addValue(current.left);
      addValue(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        addValue(last);
      }
    } else if (current.type === 'AssignmentExpression') {
      addValue(current.right);
    } else if (current.type === 'AwaitExpression') {
      addValue(current.argument);
    }
    return roots;
  };
  const getObjectPropertyName = (property: Node): string | null => {
    if (property.type === 'SpreadElement') {
      return null;
    }

    const propertyNode = property as AnyNode;
    const { key } = propertyNode;
    if (!isNode(key)) {
      return null;
    }
    if (propertyNode.computed !== true && key.type === 'Identifier') {
      return key.name;
    }
    if (key.type === 'Literal') {
      return String(key.value);
    }
    return null;
  };
  const recordCallableResultValue = (
    value: Node,
    bindingPath: OxcRuntimePropertyPathKey
  ): void => {
    const current = unwrapAliasExpression(value);
    if (
      current.type === 'CallExpression' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      addCallableResultRoots(
        bindingPath,
        collectCallableExpressionRoots(current)
      );
      return;
    }

    if (current.type === 'ObjectExpression') {
      current.properties.forEach((property) => {
        const propertyName = getObjectPropertyName(property);
        if (propertyName !== null && property.type !== 'SpreadElement') {
          recordCallableResultValue(
            property.value,
            appendOxcRuntimePropertyPathKey(bindingPath, propertyName)
          );
        } else if (property.type !== 'SpreadElement') {
          recordCallableResultValue(property.value, bindingPath);
        }
      });
      return;
    }

    if (current.type === 'ArrayExpression') {
      current.elements.forEach((element, index) => {
        if (element) {
          recordCallableResultValue(
            element.type === 'SpreadElement' ? element.argument : element,
            appendOxcRuntimePropertyPathKey(bindingPath, String(index))
          );
        }
      });
      return;
    }

    if (current.type === 'ConditionalExpression') {
      recordCallableResultValue(current.consequent, bindingPath);
      recordCallableResultValue(current.alternate, bindingPath);
    } else if (current.type === 'LogicalExpression') {
      recordCallableResultValue(current.left, bindingPath);
      recordCallableResultValue(current.right, bindingPath);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) {
        recordCallableResultValue(last, bindingPath);
      }
    } else if (current.type === 'AssignmentExpression') {
      recordCallableResultValue(current.right, bindingPath);
    } else if (current.type === 'AwaitExpression') {
      recordCallableResultValue(current.argument, bindingPath);
    }
  };

  program.body.forEach((statement) => {
    forEachModuleExecutedNode(statement, (current) => {
      if (current.type === 'VariableDeclaration') {
        current.declarations.forEach((declarator) => {
          if (!declarator.init) {
            return;
          }
          if (declarator.id.type === 'Identifier') {
            recordCallableResultValue(
              declarator.init,
              createOxcRuntimePropertyPath(declarator.id.name).key
            );
            return;
          }

          const roots = collectCallableExpressionRoots(declarator.init);
          collectPatternNames(declarator.id).forEach((binding) =>
            addCallableResultRoots(
              createOxcRuntimePropertyPath(binding).key,
              roots
            )
          );
        });
        return;
      }

      if (current.type !== 'AssignmentExpression' || current.operator !== '=') {
        return;
      }

      const staticPath = getStaticMemberPath(current.left);
      if (staticPath) {
        recordCallableResultValue(current.right, staticPath.key);
        return;
      }

      const roots = collectCallableExpressionRoots(current.right);
      collectPatternNames(current.left).forEach((binding) =>
        addCallableResultRoots(createOxcRuntimePropertyPath(binding).key, roots)
      );
    });
  });

  const callableResultRootsByComponentCache = new Map<
    Set<string>,
    Map<string, Set<string>>
  >();
  const callableResultRootsByBindingCache = new Map<
    string,
    Map<string, Set<string>>
  >();
  const resolveCallableResultRoots = (
    binding: OxcRuntimePropertyPathKey,
    includeDescendants = false
  ): Set<string> => {
    const bindingRoot = getOxcRuntimePropertyPathKeyRoot(binding);
    const bindingSuffix = binding.slice(bindingRoot.length);
    const bindingComponent = aliasComponents.get(bindingRoot);
    const cacheKey = `${includeDescendants ? '1' : '0'}${bindingSuffix}`;
    const cache =
      bindingComponent === undefined
        ? callableResultRootsByBindingCache.get(bindingRoot)
        : callableResultRootsByComponentCache.get(bindingComponent);
    const cached = cache?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const roots = new Set<string>();
    const visited = new Set<string>();
    const pending: Array<{
      binding: OxcRuntimePropertyPathKey;
      includeDescendants: boolean;
    }> = [{ binding, includeDescendants }];

    while (pending.length > 0) {
      const currentItem = pending.pop()!;
      const current = currentItem.binding;
      const root = getOxcRuntimePropertyPathKeyRoot(current);
      const component = aliasComponents.get(root) ?? new Set([root]);
      component.forEach((aliasRoot) => {
        const alias = replaceOxcRuntimePropertyPathKeyRoot(current, aliasRoot);
        if (visited.has(alias)) {
          return;
        }
        visited.add(alias);

        const candidates = currentItem.includeDescendants
          ? [...callableResultRoots.keys()].filter((candidate) =>
              isOxcRuntimePropertyPathKeyEqualOrDescendant(candidate, alias)
            )
          : [alias];
        candidates.forEach((candidate) => {
          callableResultRoots.get(candidate)?.forEach((resultRoot) => {
            roots.add(resultRoot);
            pending.push({
              binding: createOxcRuntimePropertyPath(resultRoot).key,
              includeDescendants: false,
            });
          });
        });
      });
    }

    const nextCache = cache ?? new Map<string, Set<string>>();
    nextCache.set(cacheKey, roots);
    if (bindingComponent === undefined) {
      callableResultRootsByBindingCache.set(bindingRoot, nextCache);
    } else {
      callableResultRootsByComponentCache.set(bindingComponent, nextCache);
    }
    return roots;
  };

  const bindingEffectsBefore = (
    binding: string,
    statement: StatementInfo
  ): Set<StatementInfo> => {
    const effects = new Set<StatementInfo>();
    const component = aliasComponents.get(binding) ?? new Set([binding]);
    component.forEach((alias) => {
      statements.forEach((effect) => {
        if (
          effect.node.start < statement.node.start &&
          effect.mutations.has(alias)
        ) {
          effects.add(effect);
        }
      });
      effectsByBinding.get(alias)?.forEach((effect) => {
        if (effect.node.start < statement.node.start) {
          effects.add(effect);
        }
      });
    });
    return effects;
  };

  const resolveStableInitializer = (
    statement: StatementInfo,
    name: string
  ): Node | null | undefined => {
    const initializer = patternInitializers.get(name);
    if (!initializer) {
      return undefined;
    }
    if (
      initializer.declarationKind !== 'const' ||
      initializer.owner.node.start > statement.node.start
    ) {
      return null;
    }
    return bindingEffectsBefore(name, statement).size > 0
      ? null
      : initializer.value;
  };

  const resolveReceiverOperationRoots = (
    binding: string,
    statement: StatementInfo
  ): Set<string> => {
    const roots = new Set<string>();
    const visited = new Set<string>();
    const pending = [binding];

    while (pending.length > 0) {
      const current = pending.pop()!;
      const component = aliasComponents.get(current) ?? new Set([current]);
      component.forEach((alias) => {
        if (visited.has(alias)) {
          return;
        }
        visited.add(alias);
        roots.add(alias);

        const addReferences = (owner: StatementInfo): Set<string> => {
          const references = new Set([
            ...owner.references,
            ...getExternalStatementReferences(owner),
          ]);
          references.forEach((reference) => {
            roots.add(reference);
            if (bindingOwners.has(reference)) {
              pending.push(reference);
            }
          });
          return references;
        };
        const owner = bindingOwners.get(alias);
        if (owner) {
          addReferences(owner);
        }
        bindingEffectsBefore(alias, statement).forEach((effect) => {
          addReferences(effect).forEach((reference) =>
            addEffect(reference, effect)
          );
        });
        nestedAliasSources(alias).forEach((source) => pending.push(source));
      });
    }

    return roots;
  };

  statements.forEach((statement) => {
    if ([...statement.mutations].some(aliasesImportedRoot)) {
      importedEffects.add(statement);
    }

    collectNestedMutations(statement.node).forEach((binding) => {
      const sources = nestedAliasSources(binding);
      sources.forEach((source) => addEffect(source, statement));
      if ([...sources].some(aliasesImportedRoot)) {
        importedEffects.add(statement);
      }
    });

    const invocation = collectModuleInvocationEffects(
      statement.node,
      rootImportedBindings,
      aliasesImportedRoot,
      resolveCallable,
      resolveAccessor,
      resolveClass,
      resolveCallableResultRoots,
      resolveCallableCaptureRoots,
      collectInlineCallableCaptureRoots,
      collectCallableExpressionRoots,
      (operation) =>
        proveReceiverOperationInert(operation, {
          arrayPrototypeStable:
            bindingEffectsBefore('Array', statement).size === 0,
          objectPrototypeStable:
            bindingEffectsBefore('Object', statement).size === 0,
          resolveInitializer: (name) =>
            resolveStableInitializer(statement, name),
        }),
      (binding) => resolveReceiverOperationRoots(binding, statement)
    );
    if (invocation.opaqueImportedCall) {
      importedEffects.add(statement);
    }
    invocation.bindings.forEach((binding) => {
      if (bindingOwners.has(binding)) {
        addEffect(binding, statement);
      }

      const sources = nestedAliasSources(binding);
      sources.forEach((source) => addEffect(source, statement));

      if (aliasesImportedRoot(binding)) {
        addEffect(binding, statement);
        importedEffects.add(statement);
      }
      if ([...sources].some(aliasesImportedRoot)) {
        importedEffects.add(statement);
      }
    });
  });
  rootImportedBindings.forEach((binding) => {
    importedEffects.forEach((effect) => addEffect(binding, effect));
  });

  aliasComponents.forEach((component, binding) => {
    if (component.values().next().value !== binding) {
      return;
    }

    const effects = new Set<StatementInfo>();
    component.forEach((alias) => {
      effectsByBinding.get(alias)?.forEach((effect) => effects.add(effect));
    });
    component.forEach((alias) => {
      if (effects.size > 0) {
        effectsByBinding.set(alias, effects);
      }
    });
  });

  const mark = (statement: StatementInfo, exported = false): void => {
    if (!liveStatements.has(statement)) {
      liveStatements.add(statement);
      queue.push(statement);
    }

    if (exported) {
      liveExportStatements.add(statement);
    }
  };

  const markBinding = (binding: string): void => {
    const owner = bindingOwners.get(binding);
    if (!owner || liveBindings.has(binding)) {
      return;
    }

    liveBindings.add(binding);
    bindingQueue.push(binding);
    mark(owner);
  };

  statements
    .filter((statement) =>
      hasPotentiallyAbruptPatternEvaluation(statement.node, (name) => {
        const initializer = patternInitializers.get(name);
        if (!initializer) {
          return undefined;
        }
        if (
          initializer.declarationKind !== 'const' ||
          initializer.owner.node.start > statement.node.start
        ) {
          return null;
        }

        const mutatedBeforeEvaluation = [
          ...(effectsByBinding.get(name) ?? []),
        ].some(
          (effect) =>
            effect.node.start > initializer.owner.node.start &&
            effect.node.start < statement.node.start
        );
        return mutatedBeforeEvaluation ? null : initializer.value;
      })
    )
    .forEach((statement) => mark(statement));

  statements.forEach((statement) => {
    const hasWildcardReexport = statement.exportNames.has('*');
    const selectedExports = [...statement.exportNames].filter(
      (name) =>
        keepAllExports ||
        (name === '*' && requested.size > 0 && !requested.has('side-effect')) ||
        requested.has(name)
    );
    if (
      statement.exportNames.size > 0 &&
      (keepAllExports ||
        (hasWildcardReexport &&
          requested.size > 0 &&
          !requested.has('side-effect')) ||
        selectedExports.length > 0)
    ) {
      mark(statement, true);
      const directBindings = [...statement.bindings].filter((binding) =>
        selectedExports.includes(binding)
      );
      if (directBindings.length === 0 && selectedExports.includes('default')) {
        statement.bindings.forEach(markBinding);
      } else {
        directBindings.forEach(markBinding);
      }
    }

    if (
      statement.sideEffectImport &&
      (requested.has('side-effect') ||
        options.keepSideEffects ||
        statement.imports.some((item) =>
          hasImportOverride(item.source, options)
        ))
    ) {
      mark(statement);
    }
  });

  while (queue.length > 0 || bindingQueue.length > 0) {
    if (queue.length > 0) {
      const current = queue.shift()!;
      current.references.forEach(markBinding);
    } else {
      const binding = bindingQueue.shift()!;
      effectsByBinding.get(binding)?.forEach((effect) => {
        mark(effect);
      });
    }
  }

  const replacements: Replacement[] = [];
  statements.forEach((statement) => {
    if (!liveStatements.has(statement)) {
      replacements.push({
        end: statement.node.end,
        start: statement.node.start,
        value: '',
      });
      return;
    }

    if (!liveExportStatements.has(statement)) {
      const replacement = removeExportKeyword(code, statement.node);
      if (replacement) {
        replacements.push(replacement);
      }
      return;
    }

    const splitReplacement = splitExportedVariableDeclaration(
      code,
      statement.node,
      requested
    );
    if (splitReplacement) {
      replacements.push(splitReplacement);
    }
  });

  return finalizeShakenModule(code, filename, replacements, options);
};
