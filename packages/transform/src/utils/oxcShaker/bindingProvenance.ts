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

export type AssignedAliasRoots = {
  bindings: Set<string>;
  mayAliasAnyRootImport: boolean;
};

type AliasComponentMetadata = {
  aliasesImportedRoot: boolean;
  importedRootCohort: boolean;
};

export type AliasProvenanceState = {
  aliases: Map<string, Set<string>>;
  componentMembers: Map<string, Set<string>>;
  componentMetadata: Map<string, AliasComponentMetadata>;
  componentParents: Map<string, string>;
  componentRanks: Map<string, number>;
  importedRootAliasBindings: Set<string>;
  nestedAliases: Map<string, Set<string>>;
  nestedImportedRootAliasBindings: Set<string>;
  rootImportedBindings: ReadonlySet<string>;
};

const createAssignedAliasRoots = (): AssignedAliasRoots => ({
  bindings: new Set<string>(),
  mayAliasAnyRootImport: false,
});

const createAliasProvenanceState = (
  rootImportedBindings: ReadonlySet<string>
): AliasProvenanceState => ({
  aliases: new Map<string, Set<string>>(),
  componentMembers: new Map<string, Set<string>>(),
  componentMetadata: new Map<string, AliasComponentMetadata>(),
  componentParents: new Map<string, string>(),
  componentRanks: new Map<string, number>(),
  importedRootAliasBindings: new Set<string>(),
  nestedAliases: new Map<string, Set<string>>(),
  nestedImportedRootAliasBindings: new Set<string>(),
  rootImportedBindings,
});

const ensureAliasComponent = (
  state: AliasProvenanceState,
  binding: string
): void => {
  if (state.componentParents.has(binding)) {
    return;
  }
  state.componentParents.set(binding, binding);
  state.componentRanks.set(binding, 0);
  state.componentMembers.set(binding, new Set([binding]));
  state.componentMetadata.set(binding, {
    aliasesImportedRoot: state.rootImportedBindings.has(binding),
    importedRootCohort: false,
  });
};

const findAliasComponent = (
  state: AliasProvenanceState,
  binding: string
): string => {
  ensureAliasComponent(state, binding);
  let root = binding;
  while (state.componentParents.get(root) !== root) {
    root = state.componentParents.get(root)!;
  }
  let current = binding;
  while (current !== root) {
    const parent = state.componentParents.get(current)!;
    state.componentParents.set(current, root);
    current = parent;
  }
  return root;
};

const unionAliasComponents = (
  state: AliasProvenanceState,
  left: string,
  right: string
): void => {
  let leftRoot = findAliasComponent(state, left);
  let rightRoot = findAliasComponent(state, right);
  if (leftRoot === rightRoot) {
    return;
  }
  const leftRank = state.componentRanks.get(leftRoot)!;
  const rightRank = state.componentRanks.get(rightRoot)!;
  if (leftRank < rightRank) {
    [leftRoot, rightRoot] = [rightRoot, leftRoot];
  }
  const leftMetadata = state.componentMetadata.get(leftRoot)!;
  const rightMetadata = state.componentMetadata.get(rightRoot)!;
  const leftMembers = state.componentMembers.get(leftRoot)!;
  const rightMembers = state.componentMembers.get(rightRoot)!;
  state.componentParents.set(rightRoot, leftRoot);
  rightMembers.forEach((member) => leftMembers.add(member));
  state.componentMembers.delete(rightRoot);
  state.componentMetadata.set(leftRoot, {
    aliasesImportedRoot:
      leftMetadata.aliasesImportedRoot || rightMetadata.aliasesImportedRoot,
    importedRootCohort:
      leftMetadata.importedRootCohort || rightMetadata.importedRootCohort,
  });
  state.componentMetadata.delete(rightRoot);
  if (leftRank === rightRank) {
    state.componentRanks.set(leftRoot, leftRank + 1);
  }
};

export const getAliasComponentId = (
  state: AliasProvenanceState,
  binding: string
): string => findAliasComponent(state, binding);

export const getAliasComponentMembers = (
  state: AliasProvenanceState,
  binding: string
): ReadonlySet<string> =>
  state.componentMembers.get(findAliasComponent(state, binding))!;

const markImportedRootCohort = (
  state: AliasProvenanceState,
  binding: string
): void => {
  state.importedRootAliasBindings.add(binding);
  const root = findAliasComponent(state, binding);
  const metadata = state.componentMetadata.get(root)!;
  metadata.aliasesImportedRoot = true;
  metadata.importedRootCohort = true;
};

const aliasesImportedRootCohort = (
  state: AliasProvenanceState,
  binding: string
): boolean =>
  state.componentMetadata.get(findAliasComponent(state, binding))!
    .importedRootCohort;

export const aliasesImportedRootInState = (
  state: AliasProvenanceState,
  binding: string
): boolean =>
  state.componentMetadata.get(findAliasComponent(state, binding))!
    .aliasesImportedRoot;

const appendAliasRoots = (
  node: Node,
  state: AliasProvenanceState,
  bindings: Set<string>
): boolean => {
  const current = unwrapAliasExpression(node);
  switch (current.type) {
    case 'Identifier':
      bindings.add(current.name);
      return aliasesImportedRootCohort(state, current.name);
    case 'MemberExpression':
      return appendAliasRoots(current.object, state, bindings);
    case 'ConditionalExpression': {
      const consequent = appendAliasRoots(current.consequent, state, bindings);
      const alternate = appendAliasRoots(current.alternate, state, bindings);
      return consequent || alternate;
    }
    case 'LogicalExpression': {
      const left = appendAliasRoots(current.left, state, bindings);
      const right = appendAliasRoots(current.right, state, bindings);
      return left || right;
    }
    case 'SequenceExpression': {
      const last = current.expressions[current.expressions.length - 1];
      return last ? appendAliasRoots(last, state, bindings) : false;
    }
    case 'AssignmentExpression':
      return appendAliasRoots(current.right, state, bindings);
    case 'ArrayExpression': {
      let mayAliasAnyRootImport = false;
      current.elements.forEach((element) => {
        if (element) {
          mayAliasAnyRootImport =
            appendAliasRoots(
              element.type === 'SpreadElement' ? element.argument : element,
              state,
              bindings
            ) || mayAliasAnyRootImport;
        }
      });
      return mayAliasAnyRootImport;
    }
    case 'ObjectExpression': {
      let mayAliasAnyRootImport = false;
      current.properties.forEach((property) => {
        mayAliasAnyRootImport =
          appendAliasRoots(
            property.type === 'SpreadElement'
              ? property.argument
              : property.value,
            state,
            bindings
          ) || mayAliasAnyRootImport;
      });
      return mayAliasAnyRootImport;
    }
    case 'AwaitExpression':
      return appendAliasRoots(current.argument, state, bindings);
    default: {
      const importedCallee = getDirectCallBinding(current);
      // The return identity of imported code is unknowable in this module.
      // Keep that uncertainty as a virtual cohort instead of materializing
      // pairwise aliases to every root import.
      return Boolean(
        importedCallee && aliasesImportedRootInState(state, importedCallee)
      );
    }
  }
};

const addAlias = (
  state: AliasProvenanceState,
  left: string,
  right: string
): void => {
  if (left === right) {
    return;
  }
  const leftAliases = state.aliases.get(left) ?? new Set<string>();
  leftAliases.add(right);
  state.aliases.set(left, leftAliases);
  const rightAliases = state.aliases.get(right) ?? new Set<string>();
  rightAliases.add(left);
  state.aliases.set(right, rightAliases);
  unionAliasComponents(state, left, right);
};

const addNestedAlias = (
  state: AliasProvenanceState,
  nestedCopy: string,
  source: string
): void => {
  const sources = state.nestedAliases.get(nestedCopy) ?? new Set<string>();
  sources.add(source);
  state.nestedAliases.set(nestedCopy, sources);
};

const expandNestedValueAliases = (
  valueAliases: AssignedAliasRoots,
  state: AliasProvenanceState
): AssignedAliasRoots => {
  const expanded: AssignedAliasRoots = {
    bindings: new Set<string>(),
    mayAliasAnyRootImport: valueAliases.mayAliasAnyRootImport,
  };
  valueAliases.bindings.forEach((valueAlias) => {
    const visited = new Set<string>();
    const pending = [valueAlias];
    let foundNestedSource = false;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (!visited.has(current)) {
        visited.add(current);
        if (state.nestedImportedRootAliasBindings.has(current)) {
          foundNestedSource = true;
          expanded.mayAliasAnyRootImport = true;
        }
        const currentNestedSources = state.nestedAliases.get(current);
        if (currentNestedSources && currentNestedSources.size > 0) {
          foundNestedSource = true;
          currentNestedSources.forEach((source) => {
            expanded.bindings.add(source);
          });
        }
        state.aliases.get(current)?.forEach((alias) => pending.push(alias));
      }
    }
    if (!foundNestedSource) {
      expanded.bindings.add(valueAlias);
    }
  });
  return expanded;
};

export const collectAssignedAliasRoots = (
  node: Node,
  state: AliasProvenanceState
): AssignedAliasRoots => {
  const roots = createAssignedAliasRoots();
  roots.mayAliasAnyRootImport = appendAliasRoots(node, state, roots.bindings);
  return unwrapAliasExpression(node).type === 'MemberExpression'
    ? expandNestedValueAliases(roots, state)
    : roots;
};

const collectPatternAliases = (
  pattern: Node,
  valueAliases: AssignedAliasRoots,
  state: AliasProvenanceState
): void => {
  if (pattern.type === 'Identifier') {
    valueAliases.bindings.forEach((source) =>
      addAlias(state, pattern.name, source)
    );
    if (valueAliases.mayAliasAnyRootImport) {
      markImportedRootCohort(state, pattern.name);
    }
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    collectPatternAliases(pattern.left, valueAliases, state);
    const defaultAliases = collectAssignedAliasRoots(pattern.right, state);
    collectPatternNames(pattern.left).forEach((binding) => {
      defaultAliases.bindings.forEach((source) =>
        addAlias(state, binding, source)
      );
      if (defaultAliases.mayAliasAnyRootImport) {
        markImportedRootCohort(state, binding);
      }
    });
    return;
  }
  if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument).forEach((binding) => {
      valueAliases.bindings.forEach((source) =>
        addNestedAlias(state, binding, source)
      );
      if (valueAliases.mayAliasAnyRootImport) {
        state.nestedImportedRootAliasBindings.add(binding);
      }
    });
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    let propertyAliases: AssignedAliasRoots | undefined;
    pattern.properties.forEach((property) => {
      if (property.type !== 'RestElement' && !propertyAliases) {
        propertyAliases = expandNestedValueAliases(valueAliases, state);
      }
      collectPatternAliases(
        property.type === 'RestElement' ? property : property.value,
        property.type === 'RestElement' ? valueAliases : propertyAliases!,
        state
      );
    });
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    const elementAliases = expandNestedValueAliases(valueAliases, state);
    pattern.elements.forEach((element) => {
      if (element) {
        collectPatternAliases(element, elementAliases, state);
      }
    });
  }
};

export const collectTopLevelAliases = (
  program: Program,
  rootImportedBindings: ReadonlySet<string>
): AliasProvenanceState => {
  const state = createAliasProvenanceState(rootImportedBindings);

  const recordMemberValueProvenance = (
    pattern: Node,
    value: Node,
    valueAliases: AssignedAliasRoots
  ): void => {
    if (unwrapAliasExpression(value).type !== 'MemberExpression') {
      return;
    }
    collectPatternNames(pattern).forEach((binding) => {
      valueAliases.bindings.forEach((source) =>
        addNestedAlias(state, binding, source)
      );
      if (valueAliases.mayAliasAnyRootImport) {
        state.nestedImportedRootAliasBindings.add(binding);
      }
    });
  };

  const collectThrownAliases = (node: Node): AssignedAliasRoots => {
    const roots = createAssignedAliasRoots();
    forEachModuleExecutedNode(node, (current) => {
      if (current.type === 'ThrowStatement' && current.argument) {
        const thrown = collectAssignedAliasRoots(current.argument, state);
        thrown.bindings.forEach((root) => roots.bindings.add(root));
        roots.mayAliasAnyRootImport ||= thrown.mayAliasAnyRootImport;
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
              state
            );
            collectPatternAliases(declarator.id, valueAliases, state);
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
        const valueAliases = collectAssignedAliasRoots(current.right, state);
        collectPatternAliases(current.left, valueAliases, state);
        recordMemberValueProvenance(current.left, current.right, valueAliases);
        return;
      }

      if (current.type === 'ForOfStatement') {
        const valueAliases = collectAssignedAliasRoots(current.right, state);
        if (current.left.type === 'VariableDeclaration') {
          current.left.declarations.forEach((declarator) =>
            collectPatternAliases(declarator.id, valueAliases, state)
          );
        } else {
          collectPatternAliases(current.left, valueAliases, state);
        }
        return;
      }

      if (current.type === 'TryStatement' && current.handler?.param) {
        collectPatternAliases(
          current.handler.param,
          collectThrownAliases(current.block),
          state
        );
        return;
      }

      if (
        (current.type === 'ClassDeclaration' ||
          current.type === 'ClassExpression') &&
        current.id
      ) {
        const className = current.id.name;
        current.body.body.forEach((element) => {
          const elementNode = element as AnyNode;
          const { value } = elementNode;
          if (
            elementNode.static === true &&
            element.type === 'PropertyDefinition' &&
            isNode(value)
          ) {
            const valueAliases = collectAssignedAliasRoots(value, state);
            valueAliases.bindings.forEach((source) =>
              addAlias(state, className, source)
            );
            if (valueAliases.mayAliasAnyRootImport) {
              markImportedRootCohort(state, className);
            }
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
              ? collectAssignedAliasRoots(argument, state)
              : createAssignedAliasRoots();
          collectPatternAliases(parameter, valueAliases, state);
          if (argument && argument.type !== 'SpreadElement') {
            recordMemberValueProvenance(parameter, argument, valueAliases);
          }
        });
      }
    });
  });

  return state;
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
