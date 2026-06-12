import type { NodePath } from '@babel/core';
import type { CallExpression, Program } from '@babel/types';

import type { IImport, ISideEffectImport } from './collectExportsAndImports';
import { collectExportsAndImports } from './collectExportsAndImports';
import { getScope } from './getScope';
import { getTraversalCache } from './traversalCache';

function getCallee(p: NodePath<CallExpression>) {
  const callee = p.get('callee');
  if (callee.isSequenceExpression()) {
    const expressions = callee.get('expressions');
    if (
      expressions.length === 2 &&
      expressions[0].isNumericLiteral({ value: 0 })
    ) {
      return expressions[1];
    }

    return callee;
  }

  return callee;
}

function isHookOrCreateElement(name: string): boolean {
  return name === 'createElement' || /use[A-Z]/.test(name);
}

const JSXRuntimeSource = 'react/jsx-runtime';

export interface ReactImportSummary {
  hasImports: boolean;
  jsxRuntimeIdentifiers: Map<string, NodePath>;
  jsxRuntimeMembers: WeakSet<NodePath>;
  reactDefaultIdentifiers: Map<string, NodePath>;
  reactIdentifiers: Map<string, NodePath>;
  reactMembers: WeakSet<NodePath>;
}

const createReactImportSummary = (
  imports: (IImport | ISideEffectImport)[]
): ReactImportSummary => {
  const summary: ReactImportSummary = {
    hasImports: false,
    jsxRuntimeIdentifiers: new Map(),
    jsxRuntimeMembers: new WeakSet(),
    reactDefaultIdentifiers: new Map(),
    reactIdentifiers: new Map(),
    reactMembers: new WeakSet(),
  };

  imports.forEach((item) => {
    if (item.imported === 'side-effect') {
      return;
    }

    if (item.source === JSXRuntimeSource) {
      summary.hasImports = true;

      if (item.local.isIdentifier()) {
        summary.jsxRuntimeIdentifiers.set(item.local.node.name, item.local);
      } else {
        summary.jsxRuntimeMembers.add(item.local);
      }

      return;
    }

    if (
      item.source === 'react' &&
      (item.imported === 'default' ||
        (item.imported && isHookOrCreateElement(item.imported)))
    ) {
      summary.hasImports = true;

      if (item.local.isIdentifier()) {
        if (item.imported === 'default') {
          summary.reactDefaultIdentifiers.set(item.local.node.name, item.local);
        } else {
          summary.reactIdentifiers.set(item.local.node.name, item.local);
        }
      } else {
        summary.reactMembers.add(item.local);
      }
    }
  });

  return summary;
};

export function getReactImportSummary(
  programPath: NodePath<Program>
): ReactImportSummary {
  const cache = getTraversalCache<ReactImportSummary>(
    programPath,
    'isUnnecessaryReactCall:summary'
  );

  if (cache.has(programPath)) {
    return cache.get(programPath)!;
  }

  const summary = createReactImportSummary(
    collectExportsAndImports(programPath).imports
  );
  cache.set(programPath, summary);

  return summary;
}

function isJSXRuntime(
  p: NodePath<CallExpression>,
  summary: ReactImportSummary
) {
  const callee = getCallee(p);
  if (callee.isIdentifier()) {
    const importPath = summary.jsxRuntimeIdentifiers.get(callee.node.name);
    if (!importPath) {
      return false;
    }

    const bindingPath = getScope(callee).getBinding(callee.node.name)?.path;
    return bindingPath?.isAncestor(importPath) ?? false;
  }

  return callee.isMemberExpression() && summary.jsxRuntimeMembers.has(callee);
}

function isClassicReactRuntime(
  p: NodePath<CallExpression>,
  summary: ReactImportSummary
) {
  const callee = getCallee(p);
  if (callee.isIdentifier() && isHookOrCreateElement(callee.node.name)) {
    const importPath = summary.reactIdentifiers.get(callee.node.name);
    if (!importPath) {
      return false;
    }

    const bindingPath = getScope(callee).getBinding(callee.node.name)?.path;
    return bindingPath?.isAncestor(importPath) ?? false;
  }

  if (callee.isMemberExpression()) {
    if (summary.reactMembers.has(callee)) {
      // It's React.createElement in CJS
      return true;
    }

    const object = callee.get('object');
    const property = callee.get('property');
    if (
      !property.isIdentifier() ||
      !isHookOrCreateElement(property.node.name) ||
      !object.isIdentifier()
    ) {
      return false;
    }

    const defaultImportPath = summary.reactDefaultIdentifiers.get(
      object.node.name
    );
    if (!defaultImportPath) {
      return false;
    }

    const bindingPath = getScope(object).getBinding(object.node.name)?.path;
    return bindingPath?.isAncestor(defaultImportPath) ?? false;
  }

  return false;
}

export function isUnnecessaryReactCall(
  path: NodePath<CallExpression>,
  summary?: ReactImportSummary
) {
  const programPath = path.findParent((p) => p.isProgram()) as
    | NodePath<Program>
    | undefined;
  if (!programPath) {
    return false;
  }

  const importSummary = summary ?? getReactImportSummary(programPath);
  if (!importSummary.hasImports) {
    return false;
  }

  return (
    isJSXRuntime(path, importSummary) ||
    isClassicReactRuntime(path, importSummary)
  );
}
