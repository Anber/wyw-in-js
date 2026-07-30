/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type { SourceLocation } from '@wyw-in-js/shared';
import type {
  Expression,
  ImportDeclaration,
  ImportSpecifier,
  ModuleExportName,
  Node,
  Program,
  TemplateLiteral,
  VariableDeclaration,
} from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { parseOxcProgram } from '../oxc/parse';
import { collectOxcPatternBindingNames } from '../oxc/patterns';
import { createOxcSourceLocation } from '../oxc/sourceLocations';
import { createBindingIndex } from './bindingResolution';
import {
  collectProgramMutationAnalysis,
  isEffectiveMutationHazardSeed,
  registerMutationHazardNode,
} from './mutationAnalysis';
import { isInTypeContext, visitOxcScopes } from './scopeTraversal';
import type {
  Binding,
  ExpressionSpan,
  ExtractionContext,
  ProgramAnalysis,
  Scope,
  ScopedDeclarationKind,
  SpanLookup,
} from './types';

export { resolveBindingAt } from './bindingResolution';
export {
  getRootMutationHazards,
  toMutationBindingKey,
  unknownAliasMutationBinding,
} from './mutationAnalysis';
export {
  findReferences,
  isBindingDeclaredWithin,
  isBindingPosition,
  isInTypeContext,
  isObjectPropertyKey,
  isPropertyOnlyIdentifier,
} from './scopeTraversal';

export const containsTaggedTemplateExpression = (node: Node): boolean => {
  if (node.type === 'TaggedTemplateExpression') {
    return true;
  }

  return getOxcNodeChildren(node).some(containsTaggedTemplateExpression);
};

export const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgram(code, filename, 'unambiguous');
};

const toSpanKey = (start: number, end: number): string => `${start}:${end}`;

export const createSpanLookup = (spans?: ExpressionSpan[]): SpanLookup => {
  if (!spans || spans.length === 0) {
    return null;
  }

  return new Set(spans.map((span) => toSpanKey(span.start, span.end)));
};

const matchesSpanLookup = (
  node: Pick<Node, 'start' | 'end'>,
  spanLookup: SpanLookup
): boolean => !spanLookup || spanLookup.has(toSpanKey(node.start, node.end));

export const getSourceLocation = (
  start: number,
  end: number,
  ctx: Pick<ExtractionContext, 'filename' | 'loc'>
): SourceLocation => createOxcSourceLocation(start, end, ctx.loc, ctx.filename);

const normalizeDeclarationKind = (
  declarationKind: VariableDeclaration['kind']
): ScopedDeclarationKind => {
  if (declarationKind === 'var') {
    return 'var';
  }

  if (declarationKind === 'let') {
    return 'let';
  }

  return 'const';
};

const moduleExportName = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const getImportSpecifierInfo = (
  statement: ImportDeclaration,
  specifier: ImportDeclaration['specifiers'][number]
): { imported: 'default' | '*' | string; local: string } | null => {
  const local = specifier.local?.name;
  if (!local) {
    return null;
  }

  if (specifier.type === 'ImportDefaultSpecifier') {
    return {
      imported: 'default',
      local,
    };
  }

  if (specifier.type === 'ImportNamespaceSpecifier') {
    return {
      imported: '*',
      local,
    };
  }

  if (
    statement.importKind === 'type' ||
    (specifier as ImportSpecifier).importKind === 'type'
  ) {
    return null;
  }

  return {
    imported: moduleExportName((specifier as ImportSpecifier).imported),
    local,
  };
};

const getDeclarationScope = (
  scope: Scope,
  declarationKind: ScopedDeclarationKind
): Scope => {
  if (declarationKind !== 'var') {
    return scope;
  }

  let current: Scope | null = scope;
  while (current && !current.functionBoundary) {
    current = current.parent;
  }

  return current ?? scope;
};

const hasStraightLineVarInitializer = (ancestors: readonly Node[]): boolean => {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index]!;
    if (
      ancestor.type === 'FunctionDeclaration' ||
      ancestor.type === 'FunctionExpression' ||
      ancestor.type === 'ArrowFunctionExpression' ||
      ancestor.type === 'StaticBlock'
    ) {
      return true;
    }

    if (
      ancestor.type !== 'Program' &&
      ancestor.type !== 'BlockStatement' &&
      ancestor.type !== 'ExportNamedDeclaration'
    ) {
      return false;
    }
  }

  return true;
};

export const analyzeProgram = (
  program: Program,
  {
    collectTargetExpressions = false,
    collectTemplateLiterals = false,
    expressionSpanLookup = null,
    mutationHazardIgnoreLookup = null,
    templateSpanLookup = null,
  }: {
    collectTargetExpressions?: boolean;
    collectTemplateLiterals?: boolean;
    expressionSpanLookup?: SpanLookup;
    mutationHazardIgnoreLookup?: SpanLookup;
    templateSpanLookup?: SpanLookup;
  } = {}
): ProgramAnalysis => {
  const bindings = new Map<string, Binding[]>();
  const usedNames = new Set<string>();
  const templateLiterals: TemplateLiteral[] = [];
  const targetExpressions: Expression[] = [];
  const ignoredMutationHazardNodes = new Set<Node>();
  let hasEffectiveMutationHazardSeed = false;

  const addBinding = (scope: Scope, binding: Binding): void => {
    scope.bindings.set(binding.name, binding);
    const existing = bindings.get(binding.name) ?? [];
    existing.push(binding);
    bindings.set(binding.name, existing);
  };

  const collectTargets = (node: Node, ancestors: Node[]): void => {
    if (
      collectTemplateLiterals &&
      node.type === 'TemplateLiteral' &&
      node.expressions.length > 0 &&
      !ancestors.some((ancestor) => ancestor.type === 'TemplateLiteral') &&
      matchesSpanLookup(node, templateSpanLookup)
    ) {
      templateLiterals.push(node);
    }

    if (
      collectTargetExpressions &&
      expressionSpanLookup &&
      matchesSpanLookup(node, expressionSpanLookup)
    ) {
      targetExpressions.push(node as Expression);
    }
  };

  visitOxcScopes(program, null, (node, scope, parent, ancestors) => {
    if (mutationHazardIgnoreLookup) {
      registerMutationHazardNode(
        node,
        mutationHazardIgnoreLookup,
        ignoredMutationHazardNodes
      );
    }
    hasEffectiveMutationHazardSeed ||= isEffectiveMutationHazardSeed(
      node,
      ignoredMutationHazardNodes
    );

    collectTargets(node, ancestors);

    if (node.type === 'Identifier') {
      usedNames.add(node.name);
    }

    if (isInTypeContext(ancestors)) {
      return;
    }

    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      if (node.type === 'FunctionExpression' && node.id) {
        const binding = scope.bindings.get(node.id.name);
        if (binding) {
          addBinding(scope, binding);
        }
      }

      node.params.forEach((param) => {
        collectOxcPatternBindingNames(param).forEach((name) => {
          const binding = scope.bindings.get(name);
          if (binding) {
            addBinding(scope, binding);
          }
        });
      });

      if (node.type !== 'FunctionDeclaration') {
        return;
      }
    }

    if (node.type === 'ClassExpression' && node.id) {
      const binding = scope.bindings.get(node.id.name);
      if (binding) {
        addBinding(scope, binding);
      }
      return;
    }

    if (node.type === 'ImportDeclaration') {
      const source = node.source.value;
      node.specifiers.forEach((specifier) => {
        const importInfo = getImportSpecifierInfo(node, specifier);
        if (!importInfo) {
          return;
        }

        addBinding(scope, {
          declaredAt: specifier.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          imported: importInfo.imported,
          importedFrom: source,
          isRoot: scope.root,
          kind: 'import',
          name: importInfo.local,
          scope,
        });
      });
      return;
    }

    if (node.type === 'CatchClause' && node.param) {
      collectOxcPatternBindingNames(node.param).forEach((name) => {
        const binding = scope.bindings.get(name);
        if (binding) {
          addBinding(scope, binding);
        }
      });
      return;
    }

    if (node.type !== 'VariableDeclaration') {
      if (node.type === 'FunctionDeclaration' && node.id) {
        const declarationScope = scope.parent ?? scope;
        const binding: Binding = {
          declaredAt: node.start,
          declaration: null,
          declarator: null,
          functionNode: node,
          isRoot: declarationScope.root,
          kind: 'function',
          name: node.id.name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      }

      if (node.type === 'ClassDeclaration' && node.id) {
        addBinding(scope, {
          declarationKind: 'let',
          declaredAt: node.start,
          declaration: null,
          declarator: null,
          functionNode: null,
          isRoot: scope.root,
          kind: 'variable',
          name: node.id.name,
          scope,
        });
      }

      return;
    }

    node.declarations.forEach((declarator) => {
      collectOxcPatternBindingNames(declarator.id).forEach((name) => {
        const declarationKind = normalizeDeclarationKind(node.kind);
        const declarationScope = getDeclarationScope(scope, declarationKind);
        const preservesInitializer =
          declarationKind !== 'var' || hasStraightLineVarInitializer(ancestors);
        const binding: Binding = {
          declarationKind,
          declaredAt: declarator.start,
          declaration: node,
          declarator: preservesInitializer ? declarator : null,
          functionNode: null,
          isIteration:
            (parent?.type === 'ForInStatement' ||
              parent?.type === 'ForOfStatement') &&
            parent.left === node,
          isRoot: declarationScope.root,
          kind: 'variable',
          name,
          scope: declarationScope,
        };
        addBinding(declarationScope, binding);
      });
    });
  });

  const bindingIndex = createBindingIndex(bindings);
  const { rootMutationHazardsByBinding, rootMutationsByBinding } =
    collectProgramMutationAnalysis(
      program,
      bindingIndex,
      ignoredMutationHazardNodes,
      hasEffectiveMutationHazardSeed
    );

  return {
    bindingIndex,
    rootMutationHazardsByBinding,
    rootMutationsByBinding,
    targetExpressions: targetExpressions.sort((a, b) => a.start - b.start),
    templateLiterals,
    usedNames,
  };
};
