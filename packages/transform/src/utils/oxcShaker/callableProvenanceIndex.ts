/* eslint-disable no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';

import { isOxcNode as isNode } from '../oxc/ast';
import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  appendOxcRuntimePropertyPath,
  appendOxcRuntimePropertyPathKey,
  createOxcRuntimePropertyPath,
  getOxcRuntimePropertyPathKeyRoot,
  isOxcRuntimePropertyPathKeyEqualOrDescendant,
  replaceOxcRuntimePropertyPathKeyRoot,
  replaceOxcRuntimePropertyPathRoot,
  type OxcRuntimePropertyPathKey,
} from '../oxc/projections';
import {
  collectAssignedAliasRoots,
  collectTopLevelAccessors,
  collectTopLevelAliases,
  collectTopLevelCallables,
  collectTopLevelClasses,
  getCalleeBinding,
  getStaticMemberPath,
  type ClassNode,
} from './bindingProvenance';
import {
  collectExternalReferences,
  forEachModuleExecutedNode,
  getImmediatelyInvokedFunction,
  unwrapAliasExpression,
  type CallableNode,
} from './executableIndex';
import { createCallableSyntaxFactsCache } from './callableSyntaxFacts';

type AnyNode = Node & Record<string, unknown>;
type StatementOwner = { node: Node };

export type AliasEnvironment = ReadonlyMap<string, ReadonlySet<string>>;

export const createCallableProvenanceIndex = ({
  bindingOwners,
  program,
}: {
  bindingOwners: ReadonlyMap<string, StatementOwner>;
  program: Program;
}) => {
  const getCallableSyntaxFacts = createCallableSyntaxFactsCache();
  const rootImportedBindings = new Set<string>();
  program.body.forEach((node) => {
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
  const { aliases: topLevelAliases, nestedAliases: topLevelNestedAliases } =
    collectTopLevelAliases(program, rootImportedBindings);
  const aliasComponents = new Map<string, Set<string>>();
  const visitedAliases = new Set<string>();
  topLevelAliases.forEach((_directAliases, binding) => {
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
        topLevelAliases.get(current)?.forEach((alias) => pending.push(alias));
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
        topLevelNestedAliases.get(alias)?.forEach((source) => {
          sources.add(source);
          pending.push(source);
        });
      });
    }

    return sources;
  };
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
  const externalReferencesByStatement = new Map<StatementOwner, Set<string>>();
  const getExternalStatementReferences = (
    statement: StatementOwner
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
        topLevelAliases,
        topLevelNestedAliases
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

    const { assignmentPairs } = getCallableSyntaxFacts(callable.body);

    let changed = true;
    let passes = assignmentPairs.length + 1;
    while (changed && passes > 0) {
      passes -= 1;
      changed = assignmentPairs
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

  return {
    aliasComponents,
    aliasesImportedRoot,
    collectCallableAliases,
    collectCallableExpressionRoots,
    collectContextualRoots,
    collectInlineCallableCaptureRoots,
    getCallableSyntaxFacts,
    getExternalStatementReferences,
    nestedAliasSources,
    resolveAliasBinding,
    resolveCallableCaptureRoots,
    resolveCallableResultRoots,
    resolveCalleeCallables,
    resolveCalleeClasses,
    resolveMemberAccessors,
    rootImportedBindings,
  };
};

export type CallableProvenanceIndex = ReturnType<
  typeof createCallableProvenanceIndex
>;
