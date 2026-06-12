/* eslint-disable no-restricted-syntax */

import type { Node, Program } from 'oxc-parser';

import { isNotNull } from '../isNotNull';
import { getOxcNodeChildren, isOxcNode, walkOxc } from '../oxc/ast';
import type { AnyNode, TopLevelStatementInfo } from './types';

export const collectUsedNames = (program: Program): Set<string> => {
  const names = new Set<string>();
  walkOxc(program, (node) => {
    if (node.type === 'Identifier') {
      names.add(node.name);
    }
  });

  return names;
};

export const isNodeReference = (node: Node, parent: Node | null): boolean => {
  if (node.type === 'Identifier') {
    const parentRecord = parent as AnyNode | null;

    if (!parentRecord) {
      return true;
    }

    if (
      parent?.type === 'ImportDeclaration' ||
      parent?.type === 'ImportSpecifier' ||
      parent?.type === 'ImportDefaultSpecifier' ||
      parent?.type === 'ImportNamespaceSpecifier'
    ) {
      return false;
    }

    if (
      parent?.type === 'MemberExpression' &&
      parentRecord.property === node &&
      !parentRecord.computed
    ) {
      return false;
    }

    if (
      (parent?.type === 'VariableDeclarator' ||
        parent?.type === 'FunctionDeclaration' ||
        parent?.type === 'ClassDeclaration' ||
        parent?.type === 'ClassExpression') &&
      parentRecord.id === node
    ) {
      return false;
    }

    if (
      (parent?.type === 'PropertyDefinition' ||
        parent?.type === 'MethodDefinition') &&
      parentRecord.key === node &&
      !parentRecord.computed
    ) {
      return false;
    }

    if (
      parent?.type === 'Property' &&
      parentRecord.key === node &&
      parentRecord.value !== node &&
      !parentRecord.computed
    ) {
      return false;
    }

    return true;
  }

  if (node.type === 'JSXIdentifier') {
    const parentRecord = parent as AnyNode | null;
    if (parent?.type === 'JSXAttribute' && parentRecord?.name === node) {
      return false;
    }

    return true;
  }

  return false;
};

export const collectReferencedNames = (root: Node): Set<string> => {
  const names = new Set<string>();

  const walk = (node: Node, parent: Node | null = null): void => {
    if (node.type === 'ImportDeclaration') {
      return;
    }

    if (
      isNodeReference(node, parent) &&
      'name' in node &&
      typeof node.name === 'string'
    ) {
      names.add(node.name);
    }

    getOxcNodeChildren(node).forEach((child) => walk(child, node));
  };

  walk(root);
  return names;
};

export const collectImportLocalNames = (node: Node): string[] => {
  if (node.type !== 'ImportDeclaration') {
    return [];
  }

  const { specifiers } = node as AnyNode;
  if (!Array.isArray(specifiers)) {
    return [];
  }

  return specifiers
    .map((specifier) => {
      const { local } = specifier as AnyNode;
      return isOxcNode(local) &&
        'name' in local &&
        typeof local.name === 'string'
        ? local.name
        : null;
    })
    .filter(isNotNull);
};

export const getImportSpecifierLocalName = (node: Node): string | null => {
  const { local } = node as AnyNode;
  return isOxcNode(local) && 'name' in local && typeof local.name === 'string'
    ? local.name
    : null;
};

export const collectDeclaredNames = (node: Node): string[] => {
  if (node.type === 'Identifier') {
    return [node.name];
  }

  if (node.type === 'RestElement') {
    return collectDeclaredNames(node.argument);
  }

  if (node.type === 'AssignmentPattern') {
    return collectDeclaredNames(node.left);
  }

  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectDeclaredNames(property.argument)
        : collectDeclaredNames(property.value)
    );
  }

  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) =>
      element ? collectDeclaredNames(element) : []
    );
  }

  if (node.type === 'TSParameterProperty') {
    return collectDeclaredNames(node.parameter);
  }

  return [];
};

export const collectTopLevelBindings = (statement: Node): Set<string> => {
  const bindings = new Set<string>();

  if (statement.type === 'ImportDeclaration') {
    collectImportLocalNames(statement).forEach((name) => bindings.add(name));
    return bindings;
  }

  if (statement.type === 'VariableDeclaration') {
    const { declarations } = statement as AnyNode;
    if (!Array.isArray(declarations)) {
      return bindings;
    }

    declarations.forEach((declarator) => {
      const { id } = declarator as AnyNode;
      if (isOxcNode(id)) {
        collectDeclaredNames(id).forEach((name) => bindings.add(name));
      }
    });
    return bindings;
  }

  if (
    (statement.type === 'FunctionDeclaration' ||
      statement.type === 'ClassDeclaration' ||
      statement.type === 'TSEnumDeclaration') &&
    'id' in statement
  ) {
    const { id } = statement as AnyNode;
    if (isOxcNode(id) && id.type === 'Identifier') {
      bindings.add(id.name);
    }
    return bindings;
  }

  if (statement.type === 'ExportNamedDeclaration') {
    const { declaration } = statement as AnyNode;
    return isOxcNode(declaration)
      ? collectTopLevelBindings(declaration)
      : bindings;
  }

  return bindings;
};

export const collectTopLevelStatementInfos = (
  program: Program
): TopLevelStatementInfo[] =>
  program.body.map((statement) => ({
    bindings: collectTopLevelBindings(statement),
    node: statement,
    references: collectReferencedNames(statement),
  }));

export const collectTopLevelBindingsFromStatements = (
  statements: TopLevelStatementInfo[]
): Set<string> =>
  new Set(statements.flatMap((statement) => [...statement.bindings]));

export const collectRemovableNamesFromStatements = (
  statements: TopLevelStatementInfo[],
  initialNames: Set<string>
): Set<string> => {
  const removable = new Set(initialNames);
  const bindingToStatement = new Map<string, TopLevelStatementInfo>();

  statements.forEach((statement) => {
    statement.bindings.forEach((name) => {
      bindingToStatement.set(name, statement);
    });
  });

  const queue = [...removable];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const statement = bindingToStatement.get(name);
    if (statement) {
      statement.references.forEach((reference) => {
        if (bindingToStatement.has(reference) && !removable.has(reference)) {
          removable.add(reference);
          queue.push(reference);
        }
      });
    }
  }

  return removable;
};
