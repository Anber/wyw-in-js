/* eslint-disable no-restricted-syntax */

import type { Expression, MemberExpression, Node } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import {
  isBindingPosition,
  isInTypeContext,
  isObjectPropertyKey,
  isPropertyOnlyIdentifier,
  resolveBindingAt,
} from './scopeAnalysis';
import { evaluateStatic, literalCode } from './staticEvaluator';
import type {
  Binding,
  ExtractionContext,
  OxcStaticImportReference,
  Replacement,
} from './types';

export const getConstantReplacement = (
  binding: Binding | undefined,
  ctx: ExtractionContext
): string | null => {
  const init = binding?.declarator?.init;
  if (!init) {
    return null;
  }

  if (init.type === 'Literal') {
    return literalCode(init.value);
  }

  if (
    init.type === 'ObjectExpression' &&
    binding?.isRoot &&
    binding.declarator?.id.type === 'Identifier'
  ) {
    const evaluated = evaluateStatic(binding.declarator.id, ctx);
    return literalCode(evaluated);
  }

  return null;
};

export const collectIdentifierReferenceReplacements = (
  expression: Expression,
  replacements: Map<string, string>
): Replacement[] => {
  const localReplacements: Replacement[] = [];
  const ancestors: Node[] = [];

  const walk = (current: Node, parent: Node | null) => {
    if (
      current.type === 'Identifier' &&
      replacements.has(current.name) &&
      !isInTypeContext(ancestors) &&
      !isBindingPosition(current, parent) &&
      !isPropertyOnlyIdentifier(current, parent) &&
      !isObjectPropertyKey(current, parent)
    ) {
      const replacement = replacements.get(current.name)!;
      // Shorthand property `{ width }` → `{ width: 500 }` when the
      // identifier is the value side of a shorthand ObjectProperty.
      const isShorthandValue =
        !!parent &&
        parent.type === 'Property' &&
        (parent as unknown as { shorthand?: boolean }).shorthand &&
        parent.value === current;
      localReplacements.push({
        start: isShorthandValue ? parent.start : current.start,
        end: current.end,
        value: isShorthandValue
          ? `${current.name}: ${replacement}`
          : replacement,
      });
    }

    ancestors.push(current);
    getOxcNodeChildren(current).forEach((child) => walk(child, current));
    ancestors.pop();
  };

  walk(expression, null);
  return localReplacements;
};

export const applyExpressionReplacements = (
  expression: Expression,
  replacements: Replacement[],
  code: string
): string => {
  let result = code.slice(expression.start, expression.end);
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      const start = replacement.start - expression.start;
      const end = replacement.end - expression.start;
      result = result.slice(0, start) + replacement.value + result.slice(end);
    });
  return result;
};

export const replaceIdentifierReferences = (
  expression: Expression,
  replacements: Map<string, string>,
  code: string
): string => {
  return applyExpressionReplacements(
    expression,
    collectIdentifierReferenceReplacements(expression, replacements),
    code
  );
};

const staticImportAliasPart = (value: string): string =>
  value.replace(/[^A-Za-z0-9_$]/g, '_') || 'value';

const allocateStaticImportAlias = (
  binding: Binding,
  imported: string,
  ctx: ExtractionContext
): string => {
  const key = `${binding.importedFrom ?? ''}\0${binding.name}\0${imported}`;
  const existing = ctx.staticImportAliases.get(key);
  if (existing) {
    return existing;
  }

  const namespacePart = staticImportAliasPart(binding.name);
  const importedPart = staticImportAliasPart(imported);
  let alias = `_wyw_static_${namespacePart}_${importedPart}`;
  let idx = 1;
  while (ctx.usedNames.has(alias)) {
    idx += 1;
    alias = `_wyw_static_${namespacePart}_${importedPart}_${idx}`;
  }

  ctx.usedNames.add(alias);
  ctx.staticImportAliases.set(key, alias);
  return alias;
};

const staticMemberPropertyName = (
  expression: MemberExpression
): string | null => {
  if (!expression.computed && expression.property.type === 'Identifier') {
    return expression.property.name;
  }

  if (
    expression.computed &&
    expression.property.type === 'Literal' &&
    typeof expression.property.value === 'string'
  ) {
    return expression.property.value;
  }

  return null;
};

export const collectStaticNamespaceMemberReferences = (
  expression: Expression,
  ctx: ExtractionContext
): {
  coveredReferenceStarts: Set<number>;
  imports: OxcStaticImportReference[];
  replacements: Replacement[];
} => {
  const coveredReferenceStarts = new Set<number>();
  const imports = new Map<string, OxcStaticImportReference>();
  const replacements: Replacement[] = [];

  const walk = (node: Node): void => {
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
      const binding = resolveBindingAt(
        ctx,
        node.object.name,
        node.object.start
      );
      const imported = staticMemberPropertyName(node);
      if (
        binding?.importedFrom &&
        binding.imported === '*' &&
        imported !== null
      ) {
        const alias = allocateStaticImportAlias(binding, imported, ctx);
        imports.set(`${binding.importedFrom}\0${imported}\0${alias}`, {
          imported,
          importLocal: binding.name,
          local: alias,
          source: binding.importedFrom,
        });
        replacements.push({
          end: node.end,
          start: node.start,
          value: alias,
        });
        coveredReferenceStarts.add(node.object.start);
      }
    }

    getOxcNodeChildren(node).forEach(walk);
  };

  walk(expression);

  return {
    coveredReferenceStarts,
    imports: [...imports.values()],
    replacements,
  };
};
