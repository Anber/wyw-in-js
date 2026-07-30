import type { Node } from 'oxc-parser';

import { unwrapOxcRuntimeExpression } from './runtimeSemantics';

export type OxcAssignmentTargetLeaf = Extract<
  Node,
  { type: 'Identifier' | 'MemberExpression' }
>;

export type OxcAssignmentTargetRootIdentifier = Extract<
  Node,
  { type: 'Identifier' }
>;

/**
 * Appends the concrete write targets contained in an assignment target.
 *
 * The leaves are deliberately raw AST nodes: callers own their own policy for
 * resolving member objects, direct bindings, and duplicate handling. Runtime
 * wrappers are transparent, while unsupported target forms produce no leaf.
 */
export const appendOxcAssignmentTargetLeaves = (
  target: Node,
  leaves: OxcAssignmentTargetLeaf[]
): void => {
  const current = unwrapOxcRuntimeExpression(target, true);

  if (current.type === 'Identifier' || current.type === 'MemberExpression') {
    leaves.push(current);
    return;
  }

  if (current.type === 'AssignmentPattern') {
    appendOxcAssignmentTargetLeaves(current.left, leaves);
    return;
  }

  if (current.type === 'RestElement') {
    appendOxcAssignmentTargetLeaves(current.argument, leaves);
    return;
  }

  if (current.type === 'ObjectPattern') {
    for (let i = 0; i < current.properties.length; i += 1) {
      const property = current.properties[i];
      if (property) {
        appendOxcAssignmentTargetLeaves(
          property.type === 'RestElement' ? property.argument : property.value,
          leaves
        );
      }
    }
    return;
  }

  if (current.type === 'ArrayPattern') {
    for (let i = 0; i < current.elements.length; i += 1) {
      const element = current.elements[i];
      if (element) {
        appendOxcAssignmentTargetLeaves(element, leaves);
      }
    }
  }
};

export const getOxcAssignmentTargetRootIdentifier = (
  leaf: OxcAssignmentTargetLeaf
): OxcAssignmentTargetRootIdentifier | null => {
  let current = unwrapOxcRuntimeExpression(leaf, true);
  while (current.type === 'MemberExpression') {
    current = current.object;
    current = unwrapOxcRuntimeExpression(current, true);
  }
  return current.type === 'Identifier' ? current : null;
};
