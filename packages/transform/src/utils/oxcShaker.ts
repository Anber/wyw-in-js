/* eslint-disable no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';

import type { ImportOverrides } from '@wyw-in-js/shared';

import { collectOxcExportsAndImportsFromProgram } from './collectOxcExportsAndImports';
import type {
  collectOxcExportsAndImports,
  OxcCollectedImport,
} from './collectOxcExportsAndImports';
import { collectOxcPatternIdentifierNames as collectPatternNames } from './oxc/patterns';
import {
  createOxcRuntimePropertyPath,
  matchesOxcRuntimePropertyPath,
  replaceOxcRuntimePropertyPathRoot,
  type OxcRuntimePropertyPath,
} from './oxc/projections';
import {
  collectClassAccessors,
  collectClassCallables,
  collectObjectAccessors,
  collectObjectCallables,
  getCalleeBinding,
  getStaticMemberPath,
  type ClassNode,
} from './oxcShaker/bindingProvenance';
import {
  createCallableProvenanceIndex,
  type AliasEnvironment,
  type CallableProvenanceIndex,
} from './oxcShaker/callableProvenanceIndex';
import {
  collectExternalReferences,
  collectMutations,
  collectNestedMutations,
  collectReferences,
  forEachModuleExecutedNode,
  forEachModuleExecutedNodeWithParent,
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
  provenance: CallableProvenanceIndex,
  isReceiverOperationProvenInert: (operation: ReceiverOperation) => boolean,
  resolveReceiverOperationRoots: (binding: string) => ReadonlySet<string>
): ModuleInvocationEffects => {
  if (!hasModuleInvocationCandidate(node)) {
    return { bindings: new Set(), opaqueImportedCall: false };
  }

  const {
    aliasesImportedRoot,
    collectCallableAliases,
    collectCallableExpressionRoots,
    collectContextualRoots,
    resolveAliasBinding,
    resolveCallableResultRoots,
    resolveCalleeCallables,
    resolveCalleeClasses,
    resolveMemberAccessors,
  } = provenance;
  const bindings = new Set<string>();
  let opaqueImportedCall = false;
  const emptyAliases: AliasEnvironment = new Map();

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

  const callableProvenance = createCallableProvenanceIndex({
    bindingOwners,
    program,
  });

  // Import binding identity is not knowable at the root module boundary.
  // Therefore a module-executed mutation through any imported alias, or an
  // opaque imported call, can affect every otherwise-live root import.
  const importedEffects = new Set<StatementInfo>();

  const bindingEffectsBefore = (
    binding: string,
    statement: StatementInfo
  ): Set<StatementInfo> => {
    const effects = new Set<StatementInfo>();
    const component =
      callableProvenance.aliasComponents.get(binding) ?? new Set([binding]);
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
      const component =
        callableProvenance.aliasComponents.get(current) ?? new Set([current]);
      component.forEach((alias) => {
        if (visited.has(alias)) {
          return;
        }
        visited.add(alias);
        roots.add(alias);

        const addReferences = (owner: StatementInfo): Set<string> => {
          const references = new Set([
            ...owner.references,
            ...callableProvenance.getExternalStatementReferences(owner),
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
        callableProvenance
          .nestedAliasSources(alias)
          .forEach((source) => pending.push(source));
      });
    }

    return roots;
  };

  statements.forEach((statement) => {
    if ([...statement.mutations].some(callableProvenance.aliasesImportedRoot)) {
      importedEffects.add(statement);
    }

    collectNestedMutations(statement.node).forEach((binding) => {
      const sources = callableProvenance.nestedAliasSources(binding);
      sources.forEach((source) => addEffect(source, statement));
      if ([...sources].some(callableProvenance.aliasesImportedRoot)) {
        importedEffects.add(statement);
      }
    });

    const invocation = collectModuleInvocationEffects(
      statement.node,
      callableProvenance,
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

      const sources = callableProvenance.nestedAliasSources(binding);
      sources.forEach((source) => addEffect(source, statement));

      if (callableProvenance.aliasesImportedRoot(binding)) {
        addEffect(binding, statement);
        importedEffects.add(statement);
      }
      if ([...sources].some(callableProvenance.aliasesImportedRoot)) {
        importedEffects.add(statement);
      }
    });
  });
  callableProvenance.rootImportedBindings.forEach((binding) => {
    importedEffects.forEach((effect) => addEffect(binding, effect));
  });

  callableProvenance.aliasComponents.forEach((component, binding) => {
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
