/* eslint-disable no-restricted-syntax */

import { parseSync } from 'oxc-parser';
import type { Node, Program } from 'oxc-parser';
import type { ValueCache } from '@wyw-in-js/processor-utils';
import type { StrictOptions } from '@wyw-in-js/shared';
import { SourceMapGenerator, type RawSourceMap } from 'source-map';

import type { WYWTransformMetadata } from './TransformMetadata';
import { applyOxcProcessors } from './applyOxcProcessors';

type OxcCollectOptions = Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'displayName'
  | 'evaluate'
  | 'extensions'
  | 'tagResolver'
  | 'variableNameConfig'
>;

type OxcCollectResult = {
  code: string;
  map: RawSourceMap;
  metadata: WYWTransformMetadata | null;
};

type Replacement = {
  end: number;
  start: number;
  value: string;
};

type AnyNode = Node & Record<string, unknown>;
type AnyProperty = AnyNode & {
  computed?: boolean;
  key: Node;
  kind?: string;
  method?: boolean;
  value: Node;
};

const countLines = (code: string): number => code.split('\n').length;

const parseOxc = (code: string, filename: string): Program => {
  const parsed = parseSync(filename, code, {
    astType:
      filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js',
    range: true,
    sourceType: 'module',
  });
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    throw new Error(fatalError.message);
  }

  return parsed.program as Program;
};

const applyReplacements = (
  code: string,
  replacements: Replacement[]
): string => {
  let result = code;
  replacements
    .sort((a, b) => b.start - a.start)
    .forEach((replacement) => {
      result =
        result.slice(0, replacement.start) +
        replacement.value +
        result.slice(replacement.end);
    });

  return result;
};

const shouldTerminateWithSemicolon = (
  node: Node,
  parent: Node | null,
  key: string | null
): boolean => {
  if (
    node.type === 'VariableDeclaration' &&
    parent
  ) {
    if (
      (parent.type === 'ForStatement' ||
        parent.type === 'ForInStatement' ||
        parent.type === 'ForOfStatement') &&
      key &&
      ['init', 'left'].includes(key)
    ) {
      return false;
    }

    if (parent.type === 'ExportNamedDeclaration') {
      return false;
    }
  }

  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExpressionStatement' ||
    node.type === 'ReturnStatement' ||
    node.type === 'ThrowStatement' ||
    node.type === 'VariableDeclaration'
  ) {
    return true;
  }

  if (node.type === 'ExportNamedDeclaration') {
    if (node.declaration) {
      return node.declaration.type === 'VariableDeclaration';
    }

    return Array.isArray(node.specifiers) && node.specifiers.length > 0;
  }

  return false;
};

const getChildren = (node: Node): Array<{ key: string | null; node: Node }> => {
  const result: Array<{ key: string | null; node: Node }> = [];
  const record = node as Node & Record<string, unknown>;

  Object.keys(record).forEach((key) => {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      return;
    }

    const value = record[key];
    if (value && typeof value === 'object' && 'type' in (value as object)) {
      result.push({ key, node: value as Node });
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item && typeof item === 'object' && 'type' in (item as object)) {
          result.push({ key, node: item as Node });
        }
      });
    }
  });

  return result;
};

const getLineIndent = (code: string, offset: number): string => {
  const lineStart = code.lastIndexOf('\n', offset - 1) + 1;
  let idx = lineStart;
  while (idx < code.length && (code[idx] === ' ' || code[idx] === '\t')) {
    idx += 1;
  }

  return code.slice(lineStart, idx).replace(/\t/g, '  ');
};

const isPlainObjectProperty = (property: Node): property is AnyProperty =>
  property.type === 'Property' &&
  (property as AnyProperty).kind === 'init' &&
  (property as AnyProperty).method !== true;

const isFormattableObjectExpression = (node: Node): boolean =>
  node.type === 'ObjectExpression' &&
  node.properties.every(
    (property) =>
      property.type === 'SpreadElement' || isPlainObjectProperty(property)
  );

const hasNestedObjectValue = (node: Node): boolean =>
  node.type === 'ObjectExpression' &&
  node.properties.some(
    (property) =>
      isPlainObjectProperty(property) &&
      property.value.type === 'ObjectExpression'
  );

const printFormattedObjectExpression = (
  node: Node,
  code: string,
  baseIndent: string
): string => {
  if (
    node.type !== 'ObjectExpression' ||
    node.properties.length === 0 ||
    !isFormattableObjectExpression(node)
  ) {
    return code.slice(node.start, node.end);
  }

  const lines = node.properties.map((property) => {
    if (property.type === 'SpreadElement') {
      return `${baseIndent}  ...${code.slice(
        property.argument.start,
        property.argument.end
      )}`;
    }

    const keySource = property.computed
      ? `[${code.slice(property.key.start, property.key.end)}]`
      : code.slice(property.key.start, property.key.end);
    const valueSource =
      property.value.type === 'ObjectExpression'
        ? printFormattedObjectExpression(
            property.value,
            code,
            `${baseIndent}  `
          )
        : code.slice(property.value.start, property.value.end).trim();

    return `${baseIndent}  ${keySource}: ${valueSource}`;
  });

  return `{\n${lines.join(',\n')}\n${baseIndent}}`;
};

const formatRuntimeObjectLiterals = (code: string, filename: string): string => {
  const replacements: Replacement[] = [];

  const walk = (node: Node, parent: Node | null = null): void => {
    if (node.type === 'ObjectExpression') {
      const shouldFormat =
        (parent?.type === 'VariableDeclarator' && hasNestedObjectValue(node)) ||
        parent?.type === 'CallExpression';

      if (shouldFormat) {
        replacements.push({
          end: node.end,
          start: node.start,
          value: printFormattedObjectExpression(
            node,
            code,
            getLineIndent(code, node.start)
          ),
        });
        return;
      }
    }

    getChildren(node).forEach((child) => walk(child.node, node));
  };

  walk(parseOxc(code, filename));
  return replacements.length > 0 ? applyReplacements(code, replacements) : code;
};

const collapseRuntimeBlankLines = (code: string): string => {
  const lines = code.split('\n');
  const result: string[] = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (line.trim() !== '') {
      result.push(line);
      continue;
    }

    let nextIdx = idx;
    while (nextIdx < lines.length && lines[nextIdx]?.trim() === '') {
      nextIdx += 1;
    }

    const previousNonEmpty = [...result]
      .reverse()
      .find((entry) => entry.trim() !== '');
    const nextNonEmpty = lines.slice(nextIdx).find((entry) => entry.trim() !== '');

    if (!previousNonEmpty || !nextNonEmpty) {
      idx = nextIdx - 1;
      continue;
    }

    const trimmedPrevious = previousNonEmpty.trim();
    if (
      trimmedPrevious.startsWith('//') ||
      trimmedPrevious.endsWith('*/')
    ) {
      result.push('');
    }

    idx = nextIdx - 1;
  }

  return result.join('\n');
};

const ensureBlankLineAfterLeadingBlockComment = (code: string): string =>
  code.replace(/^(\/\*[\s\S]*?\*\/)\n(?!\n)/, '$1\n\n');

const insertMissingSemicolons = (code: string, filename: string): string => {
  const replacements: Replacement[] = [];
  const hasTrailingSemicolon = (node: Node): boolean =>
    code.slice(node.start, node.end).trimEnd().endsWith(';');

  const walk = (
    node: Node,
    parent: Node | null = null,
    key: string | null = null
  ): void => {
    if (
      shouldTerminateWithSemicolon(node, parent, key) &&
      !hasTrailingSemicolon(node)
    ) {
      replacements.push({
        end: node.end,
        start: node.end,
        value: ';',
      });
    }

    getChildren(node).forEach((child) => walk(child.node, node, child.key));
  };

  walk(parseOxc(code, filename));
  return replacements.length > 0 ? applyReplacements(code, replacements) : code;
};

const createLineSourceMap = (
  generatedCode: string,
  originalCode: string,
  filename: string
): RawSourceMap => {
  const generator = new SourceMapGenerator({
    file: filename,
  });
  const generatedLines = countLines(generatedCode);
  const originalLines = countLines(originalCode);

  for (let line = 1; line <= generatedLines; line += 1) {
    generator.addMapping({
      generated: {
        column: 0,
        line,
      },
      original: {
        column: 0,
        line: Math.min(line, originalLines),
      },
      source: filename,
    });
  }

  generator.setSourceContent(filename, originalCode);

  return generator.toJSON() as RawSourceMap;
};

const normalizeRuntimeCode = (code: string, filename: string): string =>
  insertMissingSemicolons(
    ensureBlankLineAfterLeadingBlockComment(
      collapseRuntimeBlankLines(
        formatRuntimeObjectLiterals(
          code
            .replace(/^\n+/, '')
            .replace(/\n+$/, '')
            .replace(/[ \t]+\n/g, '\n'),
          filename
        )
      )
    ),
    filename
  );

export const collectOxcRuntime = (
  code: string,
  filename: string,
  root: string,
  options: OxcCollectOptions,
  values: ValueCache
): OxcCollectResult => {
  const result = applyOxcProcessors(
    code,
    {
      filename,
      root,
    },
    options,
    (processor) => {
      processor.build(values);
      processor.doRuntimeReplacement();
    },
    true
  );
  const normalizedCode = normalizeRuntimeCode(result.code, filename);

  if (result.processors.length === 0) {
    return {
      code: normalizedCode,
      map: createLineSourceMap(normalizedCode, code, filename),
      metadata: null,
    };
  }

  return {
    code: normalizedCode,
    map: createLineSourceMap(normalizedCode, code, filename),
    metadata: {
      dependencies: [],
      processors: result.processors,
      replacements: [],
      rules: {},
    },
  };
};
