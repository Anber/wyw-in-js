/* eslint-disable no-restricted-syntax */

import type { Node } from 'oxc-parser';

import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  createOxcRuntimePropertyPath,
  matchesOxcRuntimePropertyPath,
  replaceOxcRuntimePropertyPathRoot,
  type OxcRuntimePropertyPath,
  type OxcRuntimePropertyPathKey,
} from '../oxc/projections';
import {
  getCalleeBinding,
  getStaticMemberPath,
  type ClassNode,
} from './bindingProvenance';
import { extendCallableSyntaxCatalogs } from './callableSyntaxFacts';
import {
  type AliasEnvironment,
  type CallableProvenanceIndex,
} from './callableProvenanceIndex';
import {
  collectExternalReferences,
  forEachModuleExecutedNodeWithParent,
  hasModuleInvocationCandidate,
  isMemberRead,
  unwrapAliasExpression,
  type CallableNode,
} from './executableIndex';
import type { ReceiverOperation } from './patternEffects';

type ModuleInvocationEffects = {
  bindings: Set<string>;
  callableResultPaths: Set<OxcRuntimePropertyPathKey>;
  effectOrigins: Set<string>;
  opaqueImportedCall: boolean;
};

export const collectModuleInvocationEffects = (
  node: Node,
  provenance: CallableProvenanceIndex,
  isReceiverOperationProvenInert: (operation: ReceiverOperation) => boolean,
  resolveReceiverOperationRoots: (binding: string) => ReadonlySet<string>
): ModuleInvocationEffects => {
  if (!hasModuleInvocationCandidate(node)) {
    return {
      bindings: new Set(),
      callableResultPaths: new Set(),
      effectOrigins: new Set(),
      opaqueImportedCall: false,
    };
  }

  const {
    aliasesImportedRoot,
    collectCallableAliases,
    collectCallableExpressionRoots,
    collectContextualRoots,
    collectInlineCallableCaptureRoots,
    getCallableSyntaxFacts,
    resolveAliasBinding,
    resolveCallableCaptureRoots,
    resolveCallableResultPaths,
    resolveCalleeCallables,
    resolveCalleeClasses,
    resolveMemberAccessors,
    callableResultPathsMayAliasImport,
  } = provenance;
  const bindings = new Set<string>();
  const callableResultPaths = new Set<OxcRuntimePropertyPathKey>();
  const effectOrigins = new Set<string>();
  const addEffectOrigin = (binding: string): void => {
    bindings.add(binding);
    effectOrigins.add(binding);
  };
  let opaqueImportedCall = false;
  const emptyAliases: AliasEnvironment = new Map();
  const hasImportedCallee = (
    candidates: ReadonlySet<string>,
    aliases: AliasEnvironment
  ): boolean =>
    [...candidates].some((binding) =>
      [...resolveAliasBinding(binding, aliases)].some(aliasesImportedRoot)
    );

  const addResultPaths = (
    binding: OxcRuntimePropertyPathKey,
    includeDescendants = false
  ): void => {
    const paths = resolveCallableResultPaths(binding, includeDescendants);
    paths.forEach((path) => callableResultPaths.add(path));
    if (callableResultPathsMayAliasImport(paths)) {
      opaqueImportedCall = true;
    }
  };
  const addRoots = (
    value: Node,
    aliases: AliasEnvironment = emptyAliases
  ): void => {
    const current = unwrapAliasExpression(value);
    const addValue = (item: Node): void => addRoots(item, aliases);
    if (current.type === 'Identifier') {
      resolveAliasBinding(current.name, aliases).forEach((root) => {
        addEffectOrigin(root);
        resolveCallableCaptureRoots(root).forEach((capture) =>
          addEffectOrigin(capture)
        );
        addResultPaths(createOxcRuntimePropertyPath(root).key);
      });
      return;
    }
    if (current.type === 'MemberExpression') {
      const staticPath = getStaticMemberPath(current);
      if (staticPath) {
        resolveAliasBinding(staticPath.root, aliases).forEach((root) => {
          addEffectOrigin(root);
          const path = replaceOxcRuntimePropertyPathRoot(staticPath, root).key;
          resolveCallableCaptureRoots(path).forEach((capture) =>
            addEffectOrigin(capture)
          );
          addResultPaths(path);
        });
      } else {
        collectContextualRoots(current.object, aliases, false).forEach(
          (root) => {
            addEffectOrigin(root);
            addResultPaths(createOxcRuntimePropertyPath(root).key, true);
          }
        );
      }
      return;
    }
    if (
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      collectInlineCallableCaptureRoots(current as CallableNode).forEach(
        addEffectOrigin
      );
      return;
    }
    if (current.type === 'ConditionalExpression') {
      addValue(current.consequent);
      addValue(current.alternate);
    } else if (current.type === 'LogicalExpression') {
      addValue(current.left);
      addValue(current.right);
    } else if (current.type === 'SequenceExpression') {
      const last = current.expressions[current.expressions.length - 1];
      if (last) addValue(last);
    } else if (current.type === 'AssignmentExpression') {
      addValue(current.right);
    } else if (current.type === 'ArrayExpression') {
      current.elements.forEach((element) => {
        if (element) {
          addValue(
            element.type === 'SpreadElement' ? element.argument : element
          );
        }
      });
    } else if (current.type === 'ObjectExpression') {
      current.properties.forEach((property) =>
        addValue(
          property.type === 'SpreadElement' ? property.argument : property.value
        )
      );
    } else if (current.type === 'AwaitExpression') {
      addValue(current.argument);
    } else if (current.type === 'CallExpression') {
      collectContextualRoots(current, aliases).forEach((root) =>
        addEffectOrigin(root)
      );
    }
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
      addEffectOrigin(root);
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
      addEffectOrigin(root);
      const resultBinding =
        staticPath?.root === binding
          ? replaceOxcRuntimePropertyPathRoot(staticPath, root).key
          : createOxcRuntimePropertyPath(root).key;
      const resultPaths = resolveCallableResultPaths(
        resultBinding,
        staticPath === null
      );
      resultPaths.forEach((path) => callableResultPaths.add(path));
      if (callableResultPathsMayAliasImport(resultPaths)) {
        opaqueImportedCall = true;
      }
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
          addEffectOrigin(root)
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
        addEffectOrigin(root)
      );
    }
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
    const facts = getCallableSyntaxFacts(callable.body);
    const {
      accessors: scopedAccessors,
      callables: scopedCallables,
      classes: scopedClasses,
    } = extendCallableSyntaxCatalogs(facts, {
      accessors: inheritedAccessors,
      callables: inheritedCallables,
      classes: inheritedClasses,
    });
    callable.params.forEach((parameter) => {
      collectPatternNames(parameter).forEach((binding) => {
        resolveAliasBinding(binding, aliases).forEach((root) =>
          addEffectOrigin(root)
        );
      });
    });

    facts.mutationBindings.forEach((binding) => {
      resolveAliasBinding(binding, aliases).forEach((root) =>
        addEffectOrigin(root)
      );
    });
    if (hasImportedCallee(facts.calleeCandidates, aliases)) {
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
        const nestedCallables = resolveCalleeCallables(
          current.callee,
          aliases,
          scopedCallables
        );
        current.arguments.forEach((argument) => {
          addRoots(
            argument.type === 'SpreadElement' ? argument.argument : argument,
            aliases
          );
        });
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

      const facts = getCallableSyntaxFacts(element.value);
      facts.mutationBindings.forEach((binding) => {
        resolveAliasBinding(binding, callerAliases).forEach((root) =>
          addEffectOrigin(root)
        );
      });
      if (hasImportedCallee(facts.calleeCandidates, callerAliases)) {
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
          const nestedCallables = resolveCalleeCallables(
            current.callee,
            callerAliases,
            inheritedCallables
          );
          current.arguments.forEach((argument) =>
            addRoots(
              argument.type === 'SpreadElement' ? argument.argument : argument,
              callerAliases
            )
          );
          nestedCallables.forEach((callable) =>
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
      const callablesForCallee = resolveCalleeCallables(
        current.callee,
        emptyAliases,
        new Map()
      );
      current.arguments.forEach((argument) => {
        addRoots(
          argument.type === 'SpreadElement' ? argument.argument : argument,
          emptyAliases
        );
      });
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

  return { bindings, callableResultPaths, effectOrigins, opaqueImportedCall };
};
