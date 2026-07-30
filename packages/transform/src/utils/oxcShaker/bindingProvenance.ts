/* eslint-disable no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';

import { isOxcNode as isNode } from '../oxc/ast';
import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import {
  appendOxcRuntimePropertyPathKey,
  createOxcRuntimePropertyPath,
  getOxcRuntimePropertyPath,
  type OxcRuntimePropertyPathKey,
} from '../oxc/projections';
import {
  forEachModuleExecutedNode,
  getImmediatelyInvokedFunction,
  getMutatedBinding,
  unwrapAliasExpression,
  type CallableNode,
} from './executableIndex';

type AnyNode = Node & Record<string, unknown>;

export type ClassNode = Node & {
  body: Node & { body: Node[] };
  superClass?: Node | null;
};

export const getCalleeBinding = (node: Node): string | null => {
  const callee = unwrapAliasExpression(node);
  if (callee.type === 'Identifier') {
    return callee.name;
  }

  return callee.type === 'MemberExpression'
    ? getMutatedBinding(callee.object)
    : null;
};

export const getStaticMemberPath = getOxcRuntimePropertyPath;

const getDirectCallBinding = (node: Node): string | null => {
  const current = unwrapAliasExpression(node);
  return current.type === 'CallExpression'
    ? getCalleeBinding(current.callee)
    : null;
};

const collectAliasRoots = (
  node: Node,
  rootImportedBindings: ReadonlySet<string>
): Set<string> => {
  const current = unwrapAliasExpression(node);
  if (current.type === 'Identifier') {
    return new Set([current.name]);
  }

  if (current.type === 'MemberExpression') {
    return collectAliasRoots(current.object, rootImportedBindings);
  }

  if (current.type === 'ConditionalExpression') {
    return new Set([
      ...collectAliasRoots(current.consequent, rootImportedBindings),
      ...collectAliasRoots(current.alternate, rootImportedBindings),
    ]);
  }

  if (current.type === 'LogicalExpression') {
    return new Set([
      ...collectAliasRoots(current.left, rootImportedBindings),
      ...collectAliasRoots(current.right, rootImportedBindings),
    ]);
  }

  if (current.type === 'SequenceExpression') {
    const last = current.expressions[current.expressions.length - 1];
    return last ? collectAliasRoots(last, rootImportedBindings) : new Set();
  }

  if (current.type === 'AssignmentExpression') {
    return collectAliasRoots(current.right, rootImportedBindings);
  }

  if (current.type === 'ArrayExpression') {
    const roots = new Set<string>();
    current.elements.forEach((element) => {
      if (element) {
        const value =
          element.type === 'SpreadElement' ? element.argument : element;
        collectAliasRoots(value, rootImportedBindings).forEach((root) =>
          roots.add(root)
        );
      }
    });
    return roots;
  }

  if (current.type === 'ObjectExpression') {
    const roots = new Set<string>();
    current.properties.forEach((property) => {
      const value =
        property.type === 'SpreadElement' ? property.argument : property.value;
      collectAliasRoots(value, rootImportedBindings).forEach((root) =>
        roots.add(root)
      );
    });
    return roots;
  }

  if (current.type === 'AwaitExpression') {
    return collectAliasRoots(current.argument, rootImportedBindings);
  }

  const importedCallee = getDirectCallBinding(current);
  if (importedCallee && rootImportedBindings.has(importedCallee)) {
    // The return identity of imported code is unknowable in this module.
    return new Set(rootImportedBindings);
  }

  return new Set();
};

const addAlias = (
  aliases: Map<string, Set<string>>,
  left: string,
  right: string
): void => {
  if (left === right) {
    return;
  }

  const leftAliases = aliases.get(left) ?? new Set<string>();
  leftAliases.add(right);
  aliases.set(left, leftAliases);

  const rightAliases = aliases.get(right) ?? new Set<string>();
  rightAliases.add(left);
  aliases.set(right, rightAliases);
};

const addNestedAlias = (
  nestedAliases: Map<string, Set<string>>,
  nestedCopy: string,
  source: string
): void => {
  const sources = nestedAliases.get(nestedCopy) ?? new Set<string>();
  sources.add(source);
  nestedAliases.set(nestedCopy, sources);
};

const expandNestedValueAliases = (
  valueAliases: ReadonlySet<string>,
  aliases: ReadonlyMap<string, Set<string>>,
  nestedAliases: ReadonlyMap<string, Set<string>>
): Set<string> => {
  const expanded = new Set<string>();

  valueAliases.forEach((valueAlias) => {
    const visited = new Set<string>();
    const pending = [valueAlias];
    let foundNestedSource = false;

    while (pending.length > 0) {
      const current = pending.pop()!;
      if (!visited.has(current)) {
        visited.add(current);

        const currentNestedSources = nestedAliases.get(current);
        if (currentNestedSources && currentNestedSources.size > 0) {
          foundNestedSource = true;
          currentNestedSources.forEach((source) => {
            expanded.add(source);
          });
        }
        aliases.get(current)?.forEach((alias) => pending.push(alias));
      }
    }

    if (!foundNestedSource) {
      expanded.add(valueAlias);
    }
  });

  return expanded;
};

export const collectAssignedAliasRoots = (
  node: Node,
  rootImportedBindings: ReadonlySet<string>,
  aliases: ReadonlyMap<string, Set<string>>,
  nestedAliases: ReadonlyMap<string, Set<string>>
): Set<string> => {
  const roots = collectAliasRoots(node, rootImportedBindings);
  return unwrapAliasExpression(node).type === 'MemberExpression'
    ? expandNestedValueAliases(roots, aliases, nestedAliases)
    : roots;
};

const collectPatternAliases = (
  pattern: Node,
  valueAliases: ReadonlySet<string>,
  aliases: Map<string, Set<string>>,
  nestedAliases: Map<string, Set<string>>,
  rootImportedBindings: ReadonlySet<string>
): void => {
  if (pattern.type === 'Identifier') {
    valueAliases.forEach((source) => addAlias(aliases, pattern.name, source));
    return;
  }

  if (pattern.type === 'AssignmentPattern') {
    collectPatternAliases(
      pattern.left,
      valueAliases,
      aliases,
      nestedAliases,
      rootImportedBindings
    );
    const defaultAliases = collectAssignedAliasRoots(
      pattern.right,
      rootImportedBindings,
      aliases,
      nestedAliases
    );
    collectPatternNames(pattern.left).forEach((binding) => {
      defaultAliases.forEach((source) => addAlias(aliases, binding, source));
    });
    return;
  }

  if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument).forEach((binding) => {
      valueAliases.forEach((source) =>
        addNestedAlias(nestedAliases, binding, source)
      );
    });
    return;
  }

  if (pattern.type === 'ObjectPattern') {
    const propertyAliases = expandNestedValueAliases(
      valueAliases,
      aliases,
      nestedAliases
    );
    pattern.properties.forEach((property) => {
      if (property.type !== 'RestElement') {
        collectPatternAliases(
          property.value,
          propertyAliases,
          aliases,
          nestedAliases,
          rootImportedBindings
        );
      } else {
        collectPatternAliases(
          property,
          valueAliases,
          aliases,
          nestedAliases,
          rootImportedBindings
        );
      }
    });
    return;
  }

  if (pattern.type === 'ArrayPattern') {
    const elementAliases = expandNestedValueAliases(
      valueAliases,
      aliases,
      nestedAliases
    );
    pattern.elements.forEach((element) => {
      if (element) {
        collectPatternAliases(
          element,
          elementAliases,
          aliases,
          nestedAliases,
          rootImportedBindings
        );
      }
    });
  }
};

export const collectTopLevelAliases = (
  program: Program,
  rootImportedBindings: ReadonlySet<string>
): {
  aliases: Map<string, Set<string>>;
  nestedAliases: Map<string, Set<string>>;
} => {
  const aliases = new Map<string, Set<string>>();
  const nestedAliases = new Map<string, Set<string>>();

  const recordMemberValueProvenance = (
    pattern: Node,
    value: Node,
    valueAliases: ReadonlySet<string>
  ): void => {
    if (unwrapAliasExpression(value).type !== 'MemberExpression') {
      return;
    }

    collectPatternNames(pattern).forEach((binding) => {
      valueAliases.forEach((source) =>
        addNestedAlias(nestedAliases, binding, source)
      );
    });
  };

  const collectThrownAliases = (node: Node): Set<string> => {
    const roots = new Set<string>();
    forEachModuleExecutedNode(node, (current) => {
      if (current.type === 'ThrowStatement' && current.argument) {
        collectAssignedAliasRoots(
          current.argument,
          rootImportedBindings,
          aliases,
          nestedAliases
        ).forEach((root) => roots.add(root));
      }
    });
    return roots;
  };

  program.body.forEach((statement) => {
    forEachModuleExecutedNode(statement, (current) => {
      if (current.type === 'VariableDeclaration') {
        current.declarations.forEach((declarator) => {
          if (declarator.init) {
            const valueAliases = collectAssignedAliasRoots(
              declarator.init,
              rootImportedBindings,
              aliases,
              nestedAliases
            );
            collectPatternAliases(
              declarator.id,
              valueAliases,
              aliases,
              nestedAliases,
              rootImportedBindings
            );
            recordMemberValueProvenance(
              declarator.id,
              declarator.init,
              valueAliases
            );
          }
        });
        return;
      }

      if (current.type === 'AssignmentExpression' && current.operator === '=') {
        const valueAliases = collectAssignedAliasRoots(
          current.right,
          rootImportedBindings,
          aliases,
          nestedAliases
        );
        collectPatternAliases(
          current.left,
          valueAliases,
          aliases,
          nestedAliases,
          rootImportedBindings
        );
        recordMemberValueProvenance(current.left, current.right, valueAliases);
        return;
      }

      if (current.type === 'ForOfStatement') {
        const valueAliases = collectAssignedAliasRoots(
          current.right,
          rootImportedBindings,
          aliases,
          nestedAliases
        );
        if (current.left.type === 'VariableDeclaration') {
          current.left.declarations.forEach((declarator) => {
            collectPatternAliases(
              declarator.id,
              valueAliases,
              aliases,
              nestedAliases,
              rootImportedBindings
            );
          });
        } else {
          collectPatternAliases(
            current.left,
            valueAliases,
            aliases,
            nestedAliases,
            rootImportedBindings
          );
        }
        return;
      }

      if (current.type === 'TryStatement' && current.handler?.param) {
        collectPatternAliases(
          current.handler.param,
          collectThrownAliases(current.block),
          aliases,
          nestedAliases,
          rootImportedBindings
        );
        return;
      }

      if (
        (current.type === 'ClassDeclaration' ||
          current.type === 'ClassExpression') &&
        current.id
      ) {
        current.body.body.forEach((element) => {
          const elementNode = element as AnyNode;
          const { value } = elementNode;
          if (
            elementNode.static === true &&
            element.type === 'PropertyDefinition' &&
            isNode(value)
          ) {
            collectAssignedAliasRoots(
              value,
              rootImportedBindings,
              aliases,
              nestedAliases
            ).forEach((source) => addAlias(aliases, current.id!.name, source));
          }
        });
        return;
      }

      if (current.type === 'CallExpression') {
        const invoked = getImmediatelyInvokedFunction(current.callee);
        if (!invoked) {
          return;
        }

        invoked.params.forEach((parameter, index) => {
          const argument = current.arguments[index];
          const valueAliases =
            argument && argument.type !== 'SpreadElement'
              ? collectAssignedAliasRoots(
                  argument,
                  rootImportedBindings,
                  aliases,
                  nestedAliases
                )
              : new Set<string>();
          collectPatternAliases(
            parameter,
            valueAliases,
            aliases,
            nestedAliases,
            rootImportedBindings
          );
          if (argument && argument.type !== 'SpreadElement') {
            recordMemberValueProvenance(parameter, argument, valueAliases);
          }
        });
      }
    });
  });

  return { aliases, nestedAliases };
};

export const collectObjectCallables = (
  object: Node,
  objectPath: OxcRuntimePropertyPathKey,
  callables: Map<string, CallableNode>
): void => {
  const current = unwrapAliasExpression(object);
  if (current.type !== 'ObjectExpression') {
    return;
  }

  current.properties.forEach((property) => {
    if (property.type === 'SpreadElement') {
      return;
    }

    let propertyName: string | null = null;
    if (!property.computed && property.key.type === 'Identifier') {
      propertyName = property.key.name;
    } else if (property.key.type === 'Literal') {
      propertyName = String(property.key.value);
    }
    if (propertyName === null) {
      return;
    }

    const propertyPath = appendOxcRuntimePropertyPathKey(
      objectPath,
      propertyName
    );
    const value = unwrapAliasExpression(property.value);
    if (
      value.type === 'FunctionExpression' ||
      value.type === 'ArrowFunctionExpression'
    ) {
      callables.set(propertyPath, value as CallableNode);
    } else if (value.type === 'ObjectExpression') {
      collectObjectCallables(value, propertyPath, callables);
    }
  });
};

export const collectObjectAccessors = (
  object: Node,
  objectPath: OxcRuntimePropertyPathKey,
  accessors: Map<string, CallableNode>
): void => {
  const current = unwrapAliasExpression(object);
  if (current.type !== 'ObjectExpression') {
    return;
  }

  current.properties.forEach((property) => {
    if (property.type === 'SpreadElement') {
      return;
    }

    let propertyName: string | null = null;
    if (!property.computed && property.key.type === 'Identifier') {
      propertyName = property.key.name;
    } else if (property.key.type === 'Literal') {
      propertyName = String(property.key.value);
    }
    if (propertyName === null) {
      return;
    }

    const propertyPath = appendOxcRuntimePropertyPathKey(
      objectPath,
      propertyName
    );
    const value = unwrapAliasExpression(property.value);
    if (property.kind === 'get' && value.type === 'FunctionExpression') {
      accessors.set(propertyPath, value as CallableNode);
    } else if (value.type === 'ObjectExpression') {
      collectObjectAccessors(value, propertyPath, accessors);
    }
  });
};

export const collectClassCallables = (
  classNode: Node,
  classPath: OxcRuntimePropertyPathKey,
  callables: Map<string, CallableNode>
): void => {
  const current = unwrapAliasExpression(classNode);
  if (
    current.type !== 'ClassDeclaration' &&
    current.type !== 'ClassExpression'
  ) {
    return;
  }

  current.body.body.forEach((element) => {
    if (
      element.type === 'MethodDefinition' &&
      element.kind === 'constructor' &&
      element.value
    ) {
      callables.set(classPath, element.value as CallableNode);
      return;
    }

    if (
      element.type !== 'MethodDefinition' &&
      element.type !== 'PropertyDefinition'
    ) {
      return;
    }
    let propertyName: string | null = null;
    if (!element.computed && element.key.type === 'Identifier') {
      propertyName = element.key.name;
    } else if (element.key.type === 'Literal') {
      propertyName = String(element.key.value);
    }
    if (propertyName === null || !element.value) {
      return;
    }

    const propertyPath = appendOxcRuntimePropertyPathKey(
      element.static === true
        ? classPath
        : appendOxcRuntimePropertyPathKey(classPath, 'prototype'),
      propertyName
    );
    const value = unwrapAliasExpression(element.value);
    if (
      value.type === 'FunctionExpression' ||
      value.type === 'ArrowFunctionExpression'
    ) {
      callables.set(propertyPath, value as CallableNode);
    } else if (value.type === 'ObjectExpression') {
      collectObjectCallables(value, propertyPath, callables);
    }
  });
};

export const collectClassAccessors = (
  classNode: Node,
  classPath: OxcRuntimePropertyPathKey,
  accessors: Map<string, CallableNode>
): void => {
  const current = unwrapAliasExpression(classNode);
  if (
    current.type !== 'ClassDeclaration' &&
    current.type !== 'ClassExpression'
  ) {
    return;
  }

  current.body.body.forEach((element) => {
    if (
      element.type !== 'MethodDefinition' ||
      element.static !== true ||
      element.kind !== 'get' ||
      !element.value
    ) {
      return;
    }

    let propertyName: string | null = null;
    if (!element.computed && element.key.type === 'Identifier') {
      propertyName = element.key.name;
    } else if (element.key.type === 'Literal') {
      propertyName = String(element.key.value);
    }
    if (propertyName !== null) {
      accessors.set(
        appendOxcRuntimePropertyPathKey(classPath, propertyName),
        element.value as CallableNode
      );
    }
  });
};

export const collectTopLevelCallables = (
  program: Program
): Map<string, CallableNode> => {
  const callables = new Map<string, CallableNode>();

  program.body.forEach((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;

    if (!declaration) {
      return;
    }

    if (declaration.type === 'FunctionDeclaration' && declaration.id) {
      callables.set(declaration.id.name, declaration as CallableNode);
      return;
    }

    if (declaration.type === 'ClassDeclaration' && declaration.id) {
      collectClassCallables(
        declaration,
        createOxcRuntimePropertyPath(declaration.id.name).key,
        callables
      );
      return;
    }

    if (declaration.type !== 'VariableDeclaration') {
      return;
    }

    declaration.declarations.forEach((declarator) => {
      if (declarator.id.type !== 'Identifier' || !declarator.init) {
        return;
      }

      const initializer = unwrapAliasExpression(declarator.init);
      if (
        initializer.type === 'FunctionExpression' ||
        initializer.type === 'ArrowFunctionExpression'
      ) {
        callables.set(declarator.id.name, initializer as CallableNode);
      } else if (initializer.type === 'ClassExpression') {
        collectClassCallables(
          initializer,
          createOxcRuntimePropertyPath(declarator.id.name).key,
          callables
        );
      } else if (initializer.type === 'ObjectExpression') {
        collectObjectCallables(
          initializer,
          createOxcRuntimePropertyPath(declarator.id.name).key,
          callables
        );
      }
    });
  });

  return callables;
};

export const collectTopLevelAccessors = (
  program: Program
): Map<string, CallableNode> => {
  const accessors = new Map<string, CallableNode>();

  program.body.forEach((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;

    if (!declaration) {
      return;
    }

    if (declaration.type === 'ClassDeclaration' && declaration.id) {
      collectClassAccessors(
        declaration,
        createOxcRuntimePropertyPath(declaration.id.name).key,
        accessors
      );
      return;
    }

    if (declaration.type !== 'VariableDeclaration') {
      return;
    }

    declaration.declarations.forEach((declarator) => {
      if (declarator.id.type !== 'Identifier' || !declarator.init) {
        return;
      }

      const initializer = unwrapAliasExpression(declarator.init);
      if (initializer.type === 'ClassExpression') {
        collectClassAccessors(
          initializer,
          createOxcRuntimePropertyPath(declarator.id.name).key,
          accessors
        );
      } else if (initializer.type === 'ObjectExpression') {
        collectObjectAccessors(
          initializer,
          createOxcRuntimePropertyPath(declarator.id.name).key,
          accessors
        );
      }
    });
  });

  return accessors;
};

export const collectTopLevelClasses = (
  program: Program
): Map<string, ClassNode> => {
  const classes = new Map<string, ClassNode>();

  program.body.forEach((statement) => {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;

    if (!declaration) {
      return;
    }

    if (declaration.type === 'ClassDeclaration' && declaration.id) {
      classes.set(declaration.id.name, declaration as ClassNode);
      return;
    }

    if (declaration.type !== 'VariableDeclaration') {
      return;
    }

    declaration.declarations.forEach((declarator) => {
      if (declarator.id.type !== 'Identifier' || !declarator.init) {
        return;
      }

      const initializer = unwrapAliasExpression(declarator.init);
      if (initializer.type === 'ClassExpression') {
        classes.set(declarator.id.name, initializer as ClassNode);
      }
    });
  });

  return classes;
};
