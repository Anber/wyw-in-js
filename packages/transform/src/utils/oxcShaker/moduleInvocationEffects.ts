/* eslint-disable no-restricted-syntax */

import type { Node } from 'oxc-parser';

import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  createOxcRuntimePropertyPath,
  matchesOxcRuntimePropertyPath,
  replaceOxcRuntimePropertyPathRoot,
  type OxcRuntimePropertyPath,
} from '../oxc/projections';
import {
  collectClassAccessors,
  collectClassCallables,
  collectObjectAccessors,
  collectObjectCallables,
  getCalleeBinding,
  getStaticMemberPath,
  type ClassNode,
} from './bindingProvenance';
import {
  type AliasEnvironment,
  type CallableProvenanceIndex,
} from './callableProvenanceIndex';
import {
  collectExternalReferences,
  collectMutations,
  forEachModuleExecutedNode,
  forEachModuleExecutedNodeWithParent,
  hasModuleInvocationCandidate,
  isMemberRead,
  unwrapAliasExpression,
  type CallableNode,
} from './executableIndex';
import type { ReceiverOperation } from './patternEffects';

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

export const collectModuleInvocationEffects = (
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
