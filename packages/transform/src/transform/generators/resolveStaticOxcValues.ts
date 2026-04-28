/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { dirname, isAbsolute, relative, resolve as resolvePath } from 'path';

import { isFeatureEnabled, type FeatureFlag } from '@wyw-in-js/shared';
import type {
  ExportSpecifier,
  Expression,
  ImportDeclaration,
  ImportSpecifier,
  ModuleExportName,
  Node,
  Program,
  VariableDeclaration,
} from 'oxc-parser';

import { oxcShaker } from '../../shaker';
import { collectOxcProcessorImportsFromProgram } from '../../utils/collectOxcExportsAndImports';
import {
  createOxcStaticCallableValue,
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
  type OxcStaticValueCandidate,
} from '../../utils/collectOxcTemplateDependencies';
import {
  appendOxcWywPreval,
  runOxcPreevalStage,
} from '../../utils/oxcPreevalStage';
import { parseOxcProgramCached } from '../../utils/parseOxc';
import { stripQueryAndHash } from '../../utils/parseRequest';
import { getProcessorForImport } from '../../utils/processorLookup';
import { Entrypoint } from '../Entrypoint';
import type { IEntrypointDependency } from '../Entrypoint.types';
import type { ITransformAction, SyncScenarioFor } from '../types';

type AnyNode = Node & Record<string, unknown>;

type ImportBinding = {
  imported: 'default' | string;
  local: string;
  source: string;
};

type ExportTarget =
  | {
      expression: Expression;
      kind: 'expression';
      localName?: string;
    }
  | {
      imported: 'default' | string;
      kind: 'import';
      source: string;
    };

type StaticExportResult = {
  dependencies: string[];
  value: unknown;
};

type StaticImportValueFeatures = {
  staticImportValues?: FeatureFlag;
};

type StaticExpressionOptions = {
  allowMetadataCalls?: boolean;
};

type StaticResolveDebugPhase =
  | 'candidate'
  | 'entrypoint'
  | 'export'
  | 'import'
  | 'processor-metadata';

type StaticResolveDebugStatus = 'rejected' | 'resolved' | 'skipped';

type StaticResolveDebugEvent = {
  candidate?: string;
  dependency?: string;
  exported?: string;
  filename: string;
  imported?: string;
  importer?: string;
  phase: StaticResolveDebugPhase;
  reason?: string;
  source?: string;
  status: StaticResolveDebugStatus;
};

const isInsideRoot = (filename: string, root: string): boolean => {
  const relativePath = relative(root, filename);
  return (
    relativePath === '' ||
    (!!relativePath &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath))
  );
};

const nodeModulesPattern = /[\\/]node_modules[\\/]/;

const isLocalStaticMetadataFile = (filename: string, root: string): boolean => {
  const strippedFilename = stripQueryAndHash(filename);
  if (isInsideRoot(strippedFilename, root)) {
    return true;
  }

  return (
    isAbsolute(strippedFilename) && !nodeModulesPattern.test(strippedFilename)
  );
};

const isEnvDisabled = (value: string): boolean =>
  value === '0' || value === 'false' || value === 'no' || value === 'off';

const isStaticImportValuesEnabled = (
  action: ITransformAction,
  filename: string
): boolean => {
  const envValue = process.env.WYW_STATIC_IMPORT_VALUES?.trim().toLowerCase();
  if (envValue) {
    return !isEnvDisabled(envValue);
  }

  return isFeatureEnabled(
    action.services.options.pluginOptions.features as StaticImportValueFeatures,
    'staticImportValues',
    filename
  );
};

const isStaticResolveDebugEnabled = (): boolean => {
  const envValue = process.env.WYW_DEBUG_STATIC_RESOLVE?.trim().toLowerCase();
  return !!envValue && !isEnvDisabled(envValue);
};

const debugStaticResolve = (
  action: ITransformAction,
  event: StaticResolveDebugEvent
): void => {
  if (!isStaticResolveDebugEnabled()) {
    return;
  }

  const labels = Object.fromEntries(
    Object.entries({
      ...event,
      type: 'staticResolve',
    }).filter(([, value]) => value !== undefined)
  );

  action.services.eventEmitter.single(labels);
  // eslint-disable-next-line no-console
  console.warn('[wyw-static-resolve]', labels);
};

const parseProgram = (code: string, filename: string): Program =>
  parseOxcProgramCached(filename, code, 'unambiguous');

const getChildren = (node: Node): Node[] => {
  const children: Node[] = [];
  Object.entries(node as AnyNode).forEach(([key, value]) => {
    if (
      key === 'comments' ||
      key === 'errors' ||
      key === 'parent' ||
      key === 'span'
    ) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (item && typeof item === 'object' && 'type' in item) {
          children.push(item as Node);
        }
      });
      return;
    }

    if (value && typeof value === 'object' && 'type' in value) {
      children.push(value as Node);
    }
  });

  return children;
};

const moduleExportName = (node: ModuleExportName): string =>
  node.type === 'Literal' ? String(node.value) : node.name;

const unwrapExpression = (expr: Node): Node => {
  let current = expr;

  for (;;) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression'
    ) {
      current = current.expression;
      continue;
    }

    return current;
  }
};

const isSafeLiteral = (
  node: Node
): node is Node & {
  type: 'Literal';
  value: boolean | null | number | string;
} => {
  if (node.type !== 'Literal') {
    return false;
  }

  const { value } = node as AnyNode;
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
};

const isSafeStaticExpression = (
  expr: Node,
  options: StaticExpressionOptions = {}
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (isSafeLiteral(unwrapped)) {
    return true;
  }

  if (unwrapped.type === 'Identifier') {
    return true;
  }

  if (unwrapped.type === 'TemplateLiteral') {
    return unwrapped.expressions.every((item) =>
      isSafeStaticExpression(item, options)
    );
  }

  if (unwrapped.type === 'UnaryExpression') {
    return isSafeStaticExpression(unwrapped.argument, options);
  }

  if (
    unwrapped.type === 'BinaryExpression' ||
    unwrapped.type === 'LogicalExpression'
  ) {
    return (
      isSafeStaticExpression(unwrapped.left, options) &&
      isSafeStaticExpression(unwrapped.right, options)
    );
  }

  if (unwrapped.type === 'ConditionalExpression') {
    return (
      isSafeStaticExpression(unwrapped.test, options) &&
      isSafeStaticExpression(unwrapped.consequent, options) &&
      isSafeStaticExpression(unwrapped.alternate, options)
    );
  }

  if (unwrapped.type === 'MemberExpression') {
    return (
      isSafeStaticExpression(unwrapped.object, options) &&
      (unwrapped.computed
        ? isSafeStaticExpression(unwrapped.property, options)
        : unwrapped.property.type === 'Identifier')
    );
  }

  if (options.allowMetadataCalls && unwrapped.type === 'CallExpression') {
    return (
      unwrapped.callee.type === 'Identifier' && unwrapped.arguments.length === 0
    );
  }

  if (
    options.allowMetadataCalls &&
    (unwrapped.type === 'ArrowFunctionExpression' ||
      unwrapped.type === 'FunctionExpression')
  ) {
    return (
      !unwrapped.async &&
      unwrapped.params.length === 0 &&
      !!unwrapped.body &&
      isSafeFunctionBodyExpression(unwrapped.body, options)
    );
  }

  if (unwrapped.type === 'ArrayExpression') {
    return unwrapped.elements.every((item) => {
      if (!item) {
        return false;
      }

      return item.type === 'SpreadElement'
        ? isSafeStaticExpression(item.argument, options)
        : isSafeStaticExpression(item, options);
    });
  }

  if (unwrapped.type === 'ObjectExpression') {
    return unwrapped.properties.every((property) => {
      if (property.type === 'SpreadElement') {
        return isSafeStaticExpression(property.argument);
      }

      const propertyNode = property as AnyNode;
      if (propertyNode.computed || propertyNode.method) {
        return false;
      }

      return (
        propertyNode.value &&
        typeof propertyNode.value === 'object' &&
        isSafeStaticExpression(propertyNode.value as Node, options)
      );
    });
  }

  return false;
};

const isTypeOnlyImport = (statement: ImportDeclaration): boolean => {
  if (statement.importKind === 'type') {
    return true;
  }

  return statement.specifiers.every(
    (specifier) =>
      specifier.type === 'ImportSpecifier' &&
      (specifier as ImportSpecifier).importKind === 'type'
  );
};

const getImportBinding = (
  statement: ImportDeclaration,
  specifier: ImportDeclaration['specifiers'][number]
): ImportBinding | null => {
  const local = specifier.local?.name;
  if (!local) {
    return null;
  }

  if (specifier.type === 'ImportDefaultSpecifier') {
    return {
      imported: 'default',
      local,
      source: statement.source.value,
    };
  }

  if (specifier.type !== 'ImportSpecifier') {
    return null;
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
    source: statement.source.value,
  };
};

const collectImportBindings = (
  program: Program
): Map<string, ImportBinding> => {
  const result = new Map<string, ImportBinding>();

  program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration' || isTypeOnlyImport(statement)) {
      return;
    }

    statement.specifiers.forEach((specifier) => {
      const binding = getImportBinding(statement, specifier);
      if (binding) {
        result.set(binding.local, binding);
      }
    });
  });

  return result;
};

type Range = {
  end: number;
  start: number;
};

type Replacement = Range & {
  text: string;
};

const removeRanges = (code: string, ranges: Range[]): string => {
  let result = code;
  ranges
    .sort((a, b) => b.start - a.start)
    .forEach((range) => {
      result = result.slice(0, range.start) + result.slice(range.end);
    });
  return result;
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
        replacement.text +
        result.slice(replacement.end);
    });
  return result;
};

const isIdentifierBindingPosition = (
  node: Node,
  parent: Node | null
): boolean => {
  if (node.type !== 'Identifier' || !parent) {
    return false;
  }

  if (
    (parent.type === 'VariableDeclarator' && parent.id === node) ||
    (parent.type === 'FunctionDeclaration' && parent.id === node) ||
    (parent.type === 'FunctionExpression' && parent.id === node) ||
    (parent.type === 'ClassDeclaration' && parent.id === node) ||
    (parent.type === 'ClassExpression' && parent.id === node)
  ) {
    return true;
  }

  if (
    (parent.type === 'ArrowFunctionExpression' ||
      parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression') &&
    parent.params.some((param) => param === node)
  ) {
    return true;
  }

  return (
    (parent.type === 'ImportSpecifier' && parent.local === node) ||
    (parent.type === 'ImportDefaultSpecifier' && parent.local === node) ||
    (parent.type === 'ImportNamespaceSpecifier' && parent.local === node)
  );
};

const isPropertyKeyOnlyIdentifier = (
  node: Node,
  parent: Node | null
): boolean =>
  node.type === 'Identifier' &&
  !!parent &&
  ((parent.type === 'MemberExpression' &&
    parent.property === node &&
    !parent.computed) ||
    (parent.type === 'Property' &&
      parent.key === node &&
      !parent.computed &&
      !parent.shorthand));

const collectUsedIdentifierNames = (program: Program): Set<string> => {
  const used = new Set<string>();

  const walk = (node: Node, parent: Node | null): void => {
    if (node.type === 'ImportDeclaration') {
      return;
    }

    if (
      node.type === 'Identifier' &&
      !isIdentifierBindingPosition(node, parent) &&
      !isPropertyKeyOnlyIdentifier(node, parent)
    ) {
      used.add(node.name);
    }

    getChildren(node).forEach((child) => walk(child, node));
  };

  walk(program, null);
  return used;
};

const removableStaticHelperNames = (
  program: Program,
  staticValueNames: Set<string>
): Set<string> => {
  const used = collectUsedIdentifierNames(program);
  const result = new Set<string>();

  program.body.forEach((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return;
    }

    statement.declarations.forEach((declarator) => {
      if (
        declarator.id.type === 'Identifier' &&
        staticValueNames.has(declarator.id.name) &&
        !used.has(declarator.id.name)
      ) {
        result.add(declarator.id.name);
      }
    });
  });

  return result;
};

const collectImportLocalReferences = (
  node: Node,
  importLocals: Set<string>,
  result: Set<string>
): void => {
  const walk = (item: Node, parent: Node | null): void => {
    if (
      item.type === 'Identifier' &&
      importLocals.has(item.name) &&
      !isIdentifierBindingPosition(item, parent) &&
      !isPropertyKeyOnlyIdentifier(item, parent)
    ) {
      result.add(item.name);
    }

    getChildren(item).forEach((child) => walk(child, item));
  };

  walk(node, null);
};

const removeStaticHelperDeclarations = (
  code: string,
  filename: string,
  staticValueNames: Set<string>
): { code: string; removed: Set<string>; removedImportLocals: Set<string> } => {
  if (staticValueNames.size === 0) {
    return { code, removed: new Set(), removedImportLocals: new Set() };
  }

  const program = parseProgram(code, filename);
  const removableNames = removableStaticHelperNames(program, staticValueNames);
  const importLocals = new Set<string>();
  collectImportBindings(program).forEach((_, local) => importLocals.add(local));
  const removedImportLocals = new Set<string>();
  const ranges: Range[] = [];
  const replacements: Replacement[] = [];

  program.body.forEach((statement) => {
    if (
      statement.type !== 'VariableDeclaration' ||
      statement.declarations.length === 0
    ) {
      return;
    }

    const removableIndexes = statement.declarations.flatMap(
      (declarator, index) =>
        declarator.id.type === 'Identifier' &&
        removableNames.has(declarator.id.name)
          ? [index]
          : []
    );
    if (removableIndexes.length === 0) {
      return;
    }

    removableIndexes.forEach((index) => {
      collectImportLocalReferences(
        statement.declarations[index],
        importLocals,
        removedImportLocals
      );
    });

    if (removableIndexes.length === statement.declarations.length) {
      ranges.push({
        end: statement.end,
        start: statement.start,
      });
      return;
    }

    const keptDeclarations = statement.declarations
      .filter((_, index) => !removableIndexes.includes(index))
      .map((declarator) => code.slice(declarator.start, declarator.end));
    replacements.push({
      end: statement.end,
      start: statement.start,
      text: `${statement.kind} ${keptDeclarations.join(', ')};`,
    });
  });

  return {
    code: applyReplacements(code, [
      ...ranges.map((range) => ({ ...range, text: '' })),
      ...replacements,
    ]),
    removed: removableNames,
    removedImportLocals,
  };
};

const importSpecifierLocalName = (
  specifier: ImportDeclaration['specifiers'][number]
): string | null => specifier.local?.name ?? null;

const removeUnusedStaticImports = (
  code: string,
  filename: string,
  staticImportLocals: Set<string>
): string => {
  if (staticImportLocals.size === 0) {
    return code;
  }

  const program = parseProgram(code, filename);
  const used = collectUsedIdentifierNames(program);
  const ranges: Range[] = [];

  program.body.forEach((statement) => {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.specifiers.length === 0
    ) {
      return;
    }

    const removableIndexes = statement.specifiers.flatMap(
      (specifier, index) => {
        const localName = importSpecifierLocalName(specifier);
        return localName &&
          staticImportLocals.has(localName) &&
          !used.has(localName)
          ? [index]
          : [];
      }
    );

    if (removableIndexes.length === 0) {
      return;
    }

    if (removableIndexes.length === statement.specifiers.length) {
      ranges.push({
        end: statement.end,
        start: statement.start,
      });
    }
  });

  return removeRanges(code, ranges);
};

const replaceStaticWYWMetaExtendsHelpers = (
  code: string,
  filename: string,
  helperNames: Set<string>
): string => {
  if (helperNames.size === 0) {
    return code;
  }

  const program = parseProgram(code, filename);
  const replacements: Replacement[] = [];

  const visit = (node: Node): void => {
    if (node.type === 'ObjectExpression') {
      const extendsExpression = findWYWMetaExtendsExpression(node);
      if (extendsExpression) {
        const unwrapped = unwrapExpression(extendsExpression);
        if (
          unwrapped.type === 'CallExpression' &&
          unwrapped.callee.type === 'Identifier' &&
          unwrapped.arguments.length === 0 &&
          helperNames.has(unwrapped.callee.name)
        ) {
          replacements.push({
            end: extendsExpression.end,
            start: extendsExpression.start,
            text: 'null',
          });
        }
      }
    }

    getChildren(node).forEach(visit);
  };

  visit(program);
  return applyReplacements(code, replacements);
};

const pruneStaticPreevalCode = (
  code: string,
  filename: string,
  staticValueNames: Set<string>,
  staticImportLocals: Set<string>,
  staticNullWYWMetaExtendsHelpers: Set<string>
): string => {
  const codeWithMetadataPruned = replaceStaticWYWMetaExtendsHelpers(
    code,
    filename,
    staticNullWYWMetaExtendsHelpers
  );
  const helpersRemoved = removeStaticHelperDeclarations(
    codeWithMetadataPruned,
    filename,
    staticValueNames
  );
  if (helpersRemoved.removed.size === 0) {
    return codeWithMetadataPruned;
  }

  const importLocalsToPrune = new Set([
    ...staticImportLocals,
    ...helpersRemoved.removedImportLocals,
  ]);

  return removeUnusedStaticImports(
    helpersRemoved.code,
    filename,
    importLocalsToPrune
  );
};

const collectProcessorImportLocals = (
  action: ITransformAction,
  program: Program,
  code: string,
  filename: string
): Set<string> => {
  const result = new Set<string>();

  collectOxcProcessorImportsFromProgram(program, code).forEach((item) => {
    if (
      item.type !== 'esm' ||
      item.imported === '*' ||
      item.imported === 'side-effect'
    ) {
      return;
    }

    const localName = item.local.name ?? item.local.code;
    if (!localName) {
      return;
    }

    const [processor] = getProcessorForImport(
      {
        imported: item.imported,
        source: item.source,
      },
      filename,
      action.services.options.pluginOptions
    );

    if (!processor) {
      return;
    }

    result.add(localName);
    const rootLocalName = localName.split('.')[0];
    if (rootLocalName) {
      result.add(rootLocalName);
    }
  });

  return result;
};

const isStaticWYWMetaValue = (
  value: unknown,
  seen: Set<unknown> = new Set()
): boolean => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  const meta = (value as { __wyw_meta?: unknown }).__wyw_meta;
  if (typeof meta !== 'object' || meta === null) {
    return false;
  }

  const { className, extends: extended } = meta as {
    className?: unknown;
    extends?: unknown;
  };

  return (
    typeof className === 'string' &&
    (extended === null || isStaticWYWMetaValue(extended, seen))
  );
};

type StaticProcessorInstance = {
  artifacts: unknown[];
  build: (values: Map<string, unknown>) => void;
  className: string;
};

const artifactCssText = (artifact: unknown): string | null => {
  if (!Array.isArray(artifact) || artifact[0] !== 'css') {
    return null;
  }

  const payload = artifact[1];
  if (Array.isArray(payload)) {
    const [rules] = payload;
    if (typeof rules === 'object' && rules !== null) {
      return Object.values(rules)
        .map((rule) =>
          typeof rule === 'object' &&
          rule !== null &&
          'cssText' in rule &&
          typeof (rule as { cssText?: unknown }).cssText === 'string'
            ? (rule as { cssText: string }).cssText
            : ''
        )
        .join('');
    }
  }

  if (
    typeof payload === 'object' &&
    payload !== null &&
    'cssText' in payload &&
    typeof (payload as { cssText?: unknown }).cssText === 'string'
  ) {
    return (payload as { cssText: string }).cssText;
  }

  return null;
};

const isEmptyProcessorClassName = (
  value: string,
  processors: StaticProcessorInstance[],
  cache: Map<string, boolean>
): boolean => {
  if (cache.has(value)) {
    return cache.get(value)!;
  }

  const processor = processors.find((item) => item.className === value);
  if (!processor) {
    cache.set(value, false);
    return false;
  }

  try {
    processor.build(new Map());
  } catch {
    cache.set(value, false);
    return false;
  }

  const result = processor.artifacts.every((artifact) => {
    const cssText = artifactCssText(artifact);
    return cssText !== null && cssText.trim() === '';
  });
  cache.set(value, result);
  return result;
};

const isSelectorOnlyProcessorValue = (
  value: unknown,
  processors: StaticProcessorInstance[],
  cache: Map<string, boolean>,
  seen: Set<unknown> = new Set()
): boolean => {
  if (typeof value === 'string') {
    return isEmptyProcessorClassName(value, processors, cache);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return value.every((item) =>
      isSelectorOnlyProcessorValue(item, processors, cache, seen)
    );
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return Object.values(value).every((item) =>
      isSelectorOnlyProcessorValue(item, processors, cache, seen)
    );
  }

  return false;
};

const collectLocalConstExpressions = (
  program: Program
): Map<string, Expression> => {
  const result = new Map<string, Expression>();

  const collect = (declaration: VariableDeclaration): void => {
    if (declaration.kind !== 'const') {
      return;
    }

    declaration.declarations.forEach((declarator) => {
      if (declarator.id.type === 'Identifier' && declarator.init) {
        result.set(declarator.id.name, declarator.init);
      }
    });
  };

  program.body.forEach((statement) => {
    if (statement.type === 'VariableDeclaration') {
      collect(statement);
      return;
    }

    if (
      statement.type === 'ExportNamedDeclaration' &&
      statement.declaration?.type === 'VariableDeclaration'
    ) {
      collect(statement.declaration);
    }
  });

  return result;
};

type StaticExpressionDependencies = {
  imports: ImportBinding[];
};

type PreparedProcessorTarget = {
  dependencies: StaticExpressionDependencies;
  expression: Expression;
  expressionCode?: string;
  opaqueRuntimeBase: boolean;
};

const mutatingMethodNames = new Set([
  'add',
  'clear',
  'copyWithin',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
]);

const rootIdentifierName = (expr: Node): string | null => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  if (unwrapped.type === 'MemberExpression') {
    return rootIdentifierName(unwrapped.object);
  }

  if (unwrapped.type === 'ChainExpression') {
    return rootIdentifierName(unwrapped.expression);
  }

  return null;
};

const staticMemberName = (expr: Node): string | null => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  if (isSafeLiteral(unwrapped) && typeof unwrapped.value === 'string') {
    return unwrapped.value;
  }

  return null;
};

const expressionMayProduceMutableValue = (
  expr: Node,
  locals: Map<string, Expression>,
  visiting: Set<string>
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (
    unwrapped.type === 'ObjectExpression' ||
    unwrapped.type === 'ArrayExpression'
  ) {
    return true;
  }

  if (unwrapped.type === 'Identifier') {
    const local = locals.get(unwrapped.name);
    if (!local || visiting.has(unwrapped.name)) {
      return true;
    }

    visiting.add(unwrapped.name);
    const result = expressionMayProduceMutableValue(local, locals, visiting);
    visiting.delete(unwrapped.name);
    return result;
  }

  if (unwrapped.type === 'ConditionalExpression') {
    return (
      expressionMayProduceMutableValue(
        unwrapped.consequent,
        locals,
        visiting
      ) ||
      expressionMayProduceMutableValue(unwrapped.alternate, locals, visiting)
    );
  }

  if (
    unwrapped.type === 'LogicalExpression' ||
    unwrapped.type === 'MemberExpression'
  ) {
    return true;
  }

  return false;
};

const isSafeFunctionBodyExpression = (
  body: Node,
  options: StaticExpressionOptions
): boolean => {
  if (body.type !== 'BlockStatement') {
    return isSafeStaticExpression(body, options);
  }

  return body.body.every((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return (
        statement.kind === 'const' &&
        statement.declarations.every(
          (declarator) =>
            declarator.init &&
            declarator.id.type === 'Identifier' &&
            isSafeStaticExpression(declarator.init, options)
        )
      );
    }

    return (
      statement.type === 'ReturnStatement' &&
      !!statement.argument &&
      isSafeStaticExpression(statement.argument, options)
    );
  });
};

const collectStaticFunctionBodyReferences = (
  body: Node,
  references: Set<string>,
  options: StaticExpressionOptions
): boolean => {
  if (body.type !== 'BlockStatement') {
    return collectStaticExpressionReferences(body, references, options);
  }

  return body.body.every((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return (
        statement.kind === 'const' &&
        statement.declarations.every(
          (declarator) =>
            declarator.init &&
            declarator.id.type === 'Identifier' &&
            collectStaticExpressionReferences(
              declarator.init,
              references,
              options
            )
        )
      );
    }

    return (
      statement.type === 'ReturnStatement' &&
      !!statement.argument &&
      collectStaticExpressionReferences(statement.argument, references, options)
    );
  });
};

const collectStaticExpressionReferences = (
  expr: Node,
  references: Set<string>,
  options: StaticExpressionOptions = {}
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (isSafeLiteral(unwrapped)) {
    return true;
  }

  if (unwrapped.type === 'Identifier') {
    references.add(unwrapped.name);
    return true;
  }

  if (unwrapped.type === 'TemplateLiteral') {
    return unwrapped.expressions.every((item) =>
      collectStaticExpressionReferences(item, references, options)
    );
  }

  if (unwrapped.type === 'UnaryExpression') {
    return collectStaticExpressionReferences(
      unwrapped.argument,
      references,
      options
    );
  }

  if (
    unwrapped.type === 'BinaryExpression' ||
    unwrapped.type === 'LogicalExpression'
  ) {
    return (
      collectStaticExpressionReferences(unwrapped.left, references, options) &&
      collectStaticExpressionReferences(unwrapped.right, references, options)
    );
  }

  if (unwrapped.type === 'ConditionalExpression') {
    return (
      collectStaticExpressionReferences(unwrapped.test, references, options) &&
      collectStaticExpressionReferences(
        unwrapped.consequent,
        references,
        options
      ) &&
      collectStaticExpressionReferences(
        unwrapped.alternate,
        references,
        options
      )
    );
  }

  if (unwrapped.type === 'MemberExpression') {
    return (
      collectStaticExpressionReferences(
        unwrapped.object,
        references,
        options
      ) &&
      (!unwrapped.computed ||
        collectStaticExpressionReferences(
          unwrapped.property,
          references,
          options
        ))
    );
  }

  if (options.allowMetadataCalls && unwrapped.type === 'CallExpression') {
    if (
      unwrapped.callee.type !== 'Identifier' ||
      unwrapped.arguments.length !== 0
    ) {
      return false;
    }

    references.add(unwrapped.callee.name);
    return true;
  }

  if (
    options.allowMetadataCalls &&
    (unwrapped.type === 'ArrowFunctionExpression' ||
      unwrapped.type === 'FunctionExpression')
  ) {
    if (unwrapped.async || unwrapped.params.length !== 0) {
      return false;
    }

    return (
      !!unwrapped.body &&
      collectStaticFunctionBodyReferences(unwrapped.body, references, options)
    );
  }

  if (unwrapped.type === 'ArrayExpression') {
    return unwrapped.elements.every((item) => {
      if (!item) {
        return false;
      }

      return item.type === 'SpreadElement'
        ? collectStaticExpressionReferences(item.argument, references, options)
        : collectStaticExpressionReferences(item, references, options);
    });
  }

  if (unwrapped.type === 'ObjectExpression') {
    return unwrapped.properties.every((property) => {
      if (property.type === 'SpreadElement') {
        return collectStaticExpressionReferences(
          property.argument,
          references,
          options
        );
      }

      const propertyNode = property as AnyNode;
      if (
        propertyNode.computed ||
        !propertyNode.value ||
        typeof propertyNode.value !== 'object'
      ) {
        return false;
      }

      return collectStaticExpressionReferences(
        propertyNode.value as Node,
        references,
        options
      );
    });
  }

  return false;
};

const collectExpressionMutationHints = (
  expr: Node,
  mutatedNames: Set<string>,
  callArgumentNames: Set<string>
): void => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'AssignmentExpression') {
    const rootName = rootIdentifierName(unwrapped.left);
    if (rootName) {
      mutatedNames.add(rootName);
    }

    collectExpressionMutationHints(
      unwrapped.right,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (unwrapped.type === 'UpdateExpression') {
    const rootName = rootIdentifierName(unwrapped.argument);
    if (rootName) {
      mutatedNames.add(rootName);
    }

    return;
  }

  if (unwrapped.type === 'UnaryExpression') {
    if (unwrapped.operator === 'delete') {
      const rootName = rootIdentifierName(unwrapped.argument);
      if (rootName) {
        mutatedNames.add(rootName);
      }
    }

    collectExpressionMutationHints(
      unwrapped.argument,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (unwrapped.type === 'CallExpression') {
    const callee = unwrapExpression(unwrapped.callee);
    if (callee.type === 'MemberExpression') {
      const methodName = staticMemberName(callee.property);
      const rootName = rootIdentifierName(callee.object);
      if (rootName && methodName && mutatingMethodNames.has(methodName)) {
        mutatedNames.add(rootName);
      }

      collectExpressionMutationHints(
        callee.object,
        mutatedNames,
        callArgumentNames
      );
      if (callee.computed) {
        collectExpressionMutationHints(
          callee.property,
          mutatedNames,
          callArgumentNames
        );
      }
    } else {
      collectExpressionMutationHints(
        unwrapped.callee,
        mutatedNames,
        callArgumentNames
      );
    }

    unwrapped.arguments.forEach((argument) => {
      const argumentNode =
        argument.type === 'SpreadElement' ? argument.argument : argument;
      const rootName = rootIdentifierName(argumentNode);
      if (rootName) {
        callArgumentNames.add(rootName);
      }

      collectExpressionMutationHints(
        argumentNode,
        mutatedNames,
        callArgumentNames
      );
    });
    return;
  }

  if (unwrapped.type === 'TaggedTemplateExpression') {
    collectExpressionMutationHints(
      unwrapped.tag,
      mutatedNames,
      callArgumentNames
    );
    unwrapped.quasi.expressions.forEach((item) =>
      collectExpressionMutationHints(item, mutatedNames, callArgumentNames)
    );
    return;
  }

  if (unwrapped.type === 'ConditionalExpression') {
    collectExpressionMutationHints(
      unwrapped.test,
      mutatedNames,
      callArgumentNames
    );
    collectExpressionMutationHints(
      unwrapped.consequent,
      mutatedNames,
      callArgumentNames
    );
    collectExpressionMutationHints(
      unwrapped.alternate,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (
    unwrapped.type === 'BinaryExpression' ||
    unwrapped.type === 'LogicalExpression'
  ) {
    collectExpressionMutationHints(
      unwrapped.left,
      mutatedNames,
      callArgumentNames
    );
    collectExpressionMutationHints(
      unwrapped.right,
      mutatedNames,
      callArgumentNames
    );
    return;
  }

  if (unwrapped.type === 'MemberExpression') {
    collectExpressionMutationHints(
      unwrapped.object,
      mutatedNames,
      callArgumentNames
    );
    if (unwrapped.computed) {
      collectExpressionMutationHints(
        unwrapped.property,
        mutatedNames,
        callArgumentNames
      );
    }
    return;
  }

  if (unwrapped.type === 'ArrayExpression') {
    unwrapped.elements.forEach((item) => {
      if (!item) {
        return;
      }

      collectExpressionMutationHints(
        item.type === 'SpreadElement' ? item.argument : item,
        mutatedNames,
        callArgumentNames
      );
    });
    return;
  }

  if (unwrapped.type === 'ObjectExpression') {
    unwrapped.properties.forEach((property) => {
      if (property.type === 'SpreadElement') {
        collectExpressionMutationHints(
          property.argument,
          mutatedNames,
          callArgumentNames
        );
        return;
      }

      const propertyNode = property as AnyNode;
      if (propertyNode.computed && propertyNode.key) {
        collectExpressionMutationHints(
          propertyNode.key as Node,
          mutatedNames,
          callArgumentNames
        );
      }

      if (propertyNode.value && typeof propertyNode.value === 'object') {
        collectExpressionMutationHints(
          propertyNode.value as Node,
          mutatedNames,
          callArgumentNames
        );
      }
    });
  }
};

const collectTopLevelMutationHints = (
  program: Program
): { callArgumentNames: Set<string>; mutatedNames: Set<string> } => {
  const callArgumentNames = new Set<string>();
  const mutatedNames = new Set<string>();

  const collectDeclaration = (declaration: VariableDeclaration): void => {
    declaration.declarations.forEach((declarator) => {
      if (declarator.init) {
        collectExpressionMutationHints(
          declarator.init,
          mutatedNames,
          callArgumentNames
        );
      }
    });
  };

  program.body.forEach((statement) => {
    if (statement.type === 'VariableDeclaration') {
      collectDeclaration(statement);
      return;
    }

    if (statement.type === 'ExpressionStatement') {
      collectExpressionMutationHints(
        statement.expression,
        mutatedNames,
        callArgumentNames
      );
      return;
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration?.type === 'VariableDeclaration') {
        collectDeclaration(statement.declaration);
      }

      return;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      if (
        statement.declaration.type !== 'FunctionDeclaration' &&
        statement.declaration.type !== 'ClassDeclaration'
      ) {
        collectExpressionMutationHints(
          statement.declaration,
          mutatedNames,
          callArgumentNames
        );
      }
    }
  });

  return { callArgumentNames, mutatedNames };
};

const objectPropertyKeyName = (node: Node): string | null => {
  const unwrapped = unwrapExpression(node);

  if (unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  if (isSafeLiteral(unwrapped) && typeof unwrapped.value === 'string') {
    return unwrapped.value;
  }

  return null;
};

const findObjectPropertyValue = (
  expr: Node,
  name: string
): Expression | null => {
  const unwrapped = unwrapExpression(expr);
  if (unwrapped.type !== 'ObjectExpression') {
    return null;
  }

  for (const property of unwrapped.properties) {
    if (property.type === 'SpreadElement') {
      continue;
    }

    const propertyNode = property as AnyNode;
    if (propertyNode.computed) {
      continue;
    }

    const key = propertyNode.key as Node | undefined;
    const value = propertyNode.value as Expression | undefined;
    if (key && value && objectPropertyKeyName(key) === name) {
      return value;
    }
  }

  return null;
};

const findWYWMetaExtendsExpression = (expr: Expression): Expression | null => {
  const meta = findObjectPropertyValue(expr, '__wyw_meta');
  if (!meta) {
    return null;
  }

  return findObjectPropertyValue(meta, 'extends');
};

const topLevelStatements = (program: Program): Node[] => {
  const result: Node[] = [];

  program.body.forEach((statement) => {
    if (
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
    ) {
      result.push(statement.declaration ?? statement);
      return;
    }

    result.push(statement);
  });

  return result;
};

const findTopLevelConstExpression = (
  program: Program,
  name: string
): Expression | null => {
  for (const statement of topLevelStatements(program)) {
    if (
      statement.type !== 'VariableDeclaration' ||
      statement.kind !== 'const'
    ) {
      continue;
    }

    for (const declarator of statement.declarations) {
      if (
        declarator.id.type === 'Identifier' &&
        declarator.id.name === name &&
        declarator.init
      ) {
        return declarator.init;
      }
    }
  }

  return null;
};

const hasTopLevelBinding = (program: Program, name: string): boolean => {
  if (collectImportBindings(program).has(name)) {
    return true;
  }

  return topLevelStatements(program).some((statement) => {
    if (statement.type === 'VariableDeclaration') {
      return statement.declarations.some(
        (declarator) =>
          declarator.id.type === 'Identifier' && declarator.id.name === name
      );
    }

    if (statement.type === 'FunctionDeclaration') {
      return statement.id?.name === name;
    }

    if (statement.type === 'ClassDeclaration') {
      return statement.id?.name === name;
    }

    return false;
  });
};

const isTopLevelFunctionOrClass = (program: Program, name: string): boolean =>
  topLevelStatements(program).some((statement) => {
    if (statement.type === 'FunctionDeclaration') {
      return statement.id?.name === name;
    }

    if (statement.type === 'ClassDeclaration') {
      return statement.id?.name === name;
    }

    return false;
  });

const functionReturnExpression = (expr: Node): Expression | null => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'ArrowFunctionExpression' &&
    unwrapped.type !== 'FunctionExpression'
  ) {
    return null;
  }

  if (unwrapped.async || unwrapped.params.length > 0 || !unwrapped.body) {
    return null;
  }

  if (unwrapped.body.type !== 'BlockStatement') {
    return unwrapped.body as Expression;
  }

  if (unwrapped.body.body.length !== 1) {
    return null;
  }

  const [statement] = unwrapped.body.body;
  return statement.type === 'ReturnStatement' && statement.argument
    ? statement.argument
    : null;
};

const isReactImport = (
  imports: Map<string, ImportBinding>,
  localName: string
): boolean => imports.get(localName)?.source === 'react';

const isReactFactoryName = (name: string): boolean =>
  name === 'forwardRef' || name === 'memo';

const isKnownReactFactoryCall = (
  expr: Node,
  imports: Map<string, ImportBinding>
): boolean => {
  const unwrapped = unwrapExpression(expr);
  if (unwrapped.type !== 'CallExpression') {
    return false;
  }

  const callee = unwrapExpression(unwrapped.callee);
  if (callee.type === 'Identifier') {
    return (
      isReactFactoryName(callee.name) && isReactImport(imports, callee.name)
    );
  }

  if (callee.type !== 'MemberExpression' || callee.computed) {
    return false;
  }

  const methodName = staticMemberName(callee.property);
  return (
    !!methodName &&
    isReactFactoryName(methodName) &&
    callee.object.type === 'Identifier' &&
    isReactImport(imports, callee.object.name)
  );
};

const isKnownOpaqueRuntimeImportSource = (source: string): boolean =>
  /\.svg(?:$|[?#])/.test(source);

type OpaqueRuntimeImportProof = {
  dependencies: string[];
  names: Set<string>;
};

const isStaticMetaObjectExpression = (expr: Node): boolean => {
  const meta = findObjectPropertyValue(expr, '__wyw_meta');
  return !!meta && findObjectPropertyValue(meta, 'className') !== null;
};

const isObjectAssignCallee = (program: Program, expr: Node): boolean => {
  const unwrapped = unwrapExpression(expr);
  if (unwrapped.type !== 'MemberExpression' || unwrapped.computed) {
    return false;
  }

  const methodName = staticMemberName(unwrapped.property);
  return (
    methodName === 'assign' &&
    unwrapped.object.type === 'Identifier' &&
    unwrapped.object.name === 'Object' &&
    !hasTopLevelBinding(program, 'Object')
  );
};

const isSafeObjectAssignAliasExpression = (
  program: Program,
  expr: Node,
  seen: Set<string> = new Set()
): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (unwrapped.type === 'Identifier') {
    if (seen.has(unwrapped.name)) {
      return false;
    }

    const local = findTopLevelConstExpression(program, unwrapped.name);
    if (!local) {
      return false;
    }

    seen.add(unwrapped.name);
    const result = isSafeObjectAssignAliasExpression(program, local, seen);
    seen.delete(unwrapped.name);
    return result;
  }

  if (unwrapped.type !== 'ObjectExpression') {
    return false;
  }

  return unwrapped.properties.every((property) => {
    if (property.type === 'SpreadElement') {
      return false;
    }

    const propertyNode = property as AnyNode;
    if (
      propertyNode.computed ||
      propertyNode.method ||
      !propertyNode.value ||
      typeof propertyNode.value !== 'object'
    ) {
      return false;
    }

    return isSafeStaticExpression(propertyNode.value as Node);
  });
};

const objectAssignTargetExpression = (
  program: Program,
  expr: Node
): Expression | null => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'CallExpression' ||
    !isObjectAssignCallee(program, unwrapped.callee) ||
    unwrapped.arguments.length < 2
  ) {
    return null;
  }

  const [target, ...aliases] = unwrapped.arguments;
  if (!target || target.type === 'SpreadElement') {
    return null;
  }

  if (
    aliases.some(
      (alias) =>
        alias.type === 'SpreadElement' ||
        !isSafeObjectAssignAliasExpression(program, alias)
    )
  ) {
    return null;
  }

  return target;
};

const resolveObjectAssignProcessorExpression = (
  program: Program,
  expr: Expression
): Expression => {
  const objectAssignTarget = objectAssignTargetExpression(program, expr);
  const target = objectAssignTarget ?? expr;

  if (target.type !== 'Identifier') {
    return target;
  }

  return findTopLevelConstExpression(program, target.name) ?? target;
};

const isOpaqueRuntimeComponentExpression = (
  program: Program,
  expr: Node,
  opaqueImportNames: Set<string> = new Set(),
  seen: Set<string> = new Set()
): boolean => {
  const imports = collectImportBindings(program);
  const unwrapped = unwrapExpression(expr);

  if (isStaticMetaObjectExpression(unwrapped)) {
    return false;
  }

  if (
    unwrapped.type === 'ArrowFunctionExpression' ||
    unwrapped.type === 'FunctionExpression' ||
    unwrapped.type === 'ClassExpression'
  ) {
    return true;
  }

  if (isKnownReactFactoryCall(unwrapped, imports)) {
    return true;
  }

  if (
    unwrapped.type === 'CallExpression' &&
    unwrapped.callee.type === 'Identifier' &&
    unwrapped.arguments.length === 0
  ) {
    const local = findTopLevelConstExpression(program, unwrapped.callee.name);
    const returned = local ? functionReturnExpression(local) : null;
    return returned
      ? isOpaqueRuntimeComponentExpression(
          program,
          returned,
          opaqueImportNames,
          seen
        )
      : false;
  }

  if (unwrapped.type !== 'Identifier') {
    return false;
  }

  const { name } = unwrapped;
  if (seen.has(name)) {
    return false;
  }
  seen.add(name);

  const imported = imports.get(name);
  if (imported) {
    return (
      opaqueImportNames.has(name) ||
      isKnownOpaqueRuntimeImportSource(imported.source)
    );
  }

  if (isTopLevelFunctionOrClass(program, name)) {
    return true;
  }

  const local = findTopLevelConstExpression(program, name);
  return local
    ? isOpaqueRuntimeComponentExpression(
        program,
        local,
        opaqueImportNames,
        seen
      )
    : false;
};

const collectOpaqueRuntimeReferenceNames = (
  program: Program,
  expr: Node,
  names: Set<string>,
  seenHelpers: Set<string> = new Set()
): void => {
  const unwrapped = unwrapExpression(expr);

  if (
    unwrapped.type === 'CallExpression' &&
    unwrapped.callee.type === 'Identifier' &&
    unwrapped.arguments.length === 0
  ) {
    if (seenHelpers.has(unwrapped.callee.name)) {
      return;
    }

    const local = findTopLevelConstExpression(program, unwrapped.callee.name);
    const returned = local ? functionReturnExpression(local) : null;
    if (returned) {
      seenHelpers.add(unwrapped.callee.name);
      collectOpaqueRuntimeReferenceNames(program, returned, names, seenHelpers);
      seenHelpers.delete(unwrapped.callee.name);
      return;
    }
  }

  if (unwrapped.type === 'Identifier') {
    names.add(unwrapped.name);
    return;
  }

  getChildren(unwrapped).forEach((child) =>
    collectOpaqueRuntimeReferenceNames(program, child, names, seenHelpers)
  );
};

const collectWYWMetaExtendsHelperNames = (program: Program): Set<string> => {
  const result = new Set<string>();

  const visit = (node: Node): void => {
    if (node.type === 'ObjectExpression') {
      const extendsExpression = findWYWMetaExtendsExpression(node);
      const unwrapped = extendsExpression
        ? unwrapExpression(extendsExpression)
        : null;
      if (
        unwrapped?.type === 'CallExpression' &&
        unwrapped.callee.type === 'Identifier' &&
        unwrapped.arguments.length === 0
      ) {
        result.add(unwrapped.callee.name);
      }
    }

    getChildren(node).forEach(visit);
  };

  visit(program);
  return result;
};

const replaceExpressionChild = (
  code: string,
  expression: Expression,
  child: Expression,
  replacement: string
): string => {
  const expressionCode = code.slice(expression.start, expression.end);
  return (
    expressionCode.slice(0, child.start - expression.start) +
    replacement +
    expressionCode.slice(child.end - expression.start)
  );
};

const prepareProcessorTarget = (
  code: string,
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  opaqueImportNames: Set<string> = new Set()
): PreparedProcessorTarget | null => {
  const expression = resolveObjectAssignProcessorExpression(
    program,
    target.expression
  );
  const extendsExpression = findWYWMetaExtendsExpression(expression);
  if (
    extendsExpression &&
    isOpaqueRuntimeComponentExpression(
      program,
      extendsExpression,
      opaqueImportNames
    )
  ) {
    return {
      dependencies: { imports: [] },
      expression,
      expressionCode: replaceExpressionChild(
        code,
        expression,
        extendsExpression,
        'null'
      ),
      opaqueRuntimeBase: true,
    };
  }

  const dependencies = collectStaticExpressionDependencies(
    program,
    {
      ...target,
      expression,
    },
    {
      allowMetadataCalls: true,
    }
  );
  return dependencies
    ? {
        dependencies,
        expression,
        opaqueRuntimeBase: false,
      }
    : null;
};

const collectStaticExpressionDependencies = (
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  options: StaticExpressionOptions = {}
): StaticExpressionDependencies | null => {
  const imports = collectImportBindings(program);
  const locals = collectLocalConstExpressions(program);
  const collectedImports = new Map<string, ImportBinding>();
  const referencedNames = new Set<string>();
  const mutableReferencedNames = new Set<string>();
  const visitedLocals = new Set<string>();
  const visitingLocals = new Set<string>();

  const markMutable = (name: string, expression: Node): void => {
    if (expressionMayProduceMutableValue(expression, locals, new Set())) {
      mutableReferencedNames.add(name);
    }
  };

  const collectLocal = (name: string): boolean => {
    const expression = locals.get(name);
    if (!expression || visitingLocals.has(name)) {
      return false;
    }

    referencedNames.add(name);
    markMutable(name, expression);

    if (visitedLocals.has(name)) {
      return true;
    }

    visitingLocals.add(name);
    const result = collectExpression(expression);
    visitingLocals.delete(name);

    if (result) {
      visitedLocals.add(name);
    }

    return result;
  };

  const collectExpression = (expr: Node): boolean => {
    if (!isSafeStaticExpression(expr, options)) {
      return false;
    }

    const references = new Set<string>();
    if (!collectStaticExpressionReferences(expr, references, options)) {
      return false;
    }

    for (const reference of references) {
      referencedNames.add(reference);

      const importBinding = imports.get(reference);
      if (importBinding) {
        collectedImports.set(
          `${importBinding.source}\0${importBinding.imported}\0${importBinding.local}`,
          importBinding
        );
        mutableReferencedNames.add(reference);
        continue;
      }

      if (!collectLocal(reference)) {
        return false;
      }
    }

    return true;
  };

  if (target.localName) {
    referencedNames.add(target.localName);
    markMutable(target.localName, target.expression);
  }

  if (!collectExpression(target.expression)) {
    return null;
  }

  const mutationHints = collectTopLevelMutationHints(program);
  for (const name of referencedNames) {
    if (mutationHints.mutatedNames.has(name)) {
      return null;
    }
  }

  for (const name of mutableReferencedNames) {
    if (mutationHints.callArgumentNames.has(name)) {
      return null;
    }
  }

  return {
    imports: [...collectedImports.values()],
  };
};

const getExportSpecifierNames = (
  specifier: ExportSpecifier
): { exported: string; local: string } => ({
  exported: moduleExportName(specifier.exported),
  local: moduleExportName(specifier.local),
});

const findExportTarget = (
  program: Program,
  exportedName: string
): ExportTarget | null => {
  const imports = collectImportBindings(program);
  const locals = collectLocalConstExpressions(program);

  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source) {
        for (const specifier of statement.specifiers) {
          if (specifier.type !== 'ExportSpecifier') {
            continue;
          }

          const names = getExportSpecifierNames(specifier);
          if (names.exported === exportedName) {
            return {
              imported: names.local,
              kind: 'import',
              source: statement.source.value,
            };
          }
        }

        continue;
      }

      if (statement.declaration?.type === 'VariableDeclaration') {
        for (const declarator of statement.declaration.declarations) {
          if (
            declarator.id.type === 'Identifier' &&
            declarator.id.name === exportedName &&
            declarator.init
          ) {
            return {
              expression: declarator.init,
              kind: 'expression',
              localName: declarator.id.name,
            };
          }
        }

        continue;
      }

      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ExportSpecifier') {
          continue;
        }

        const names = getExportSpecifierNames(specifier);
        if (names.exported !== exportedName) {
          continue;
        }

        const importBinding = imports.get(names.local);
        if (importBinding) {
          return {
            imported: importBinding.imported,
            kind: 'import',
            source: importBinding.source,
          };
        }

        const local = locals.get(names.local);
        if (local) {
          return {
            expression: local,
            kind: 'expression',
            localName: names.local,
          };
        }
      }
    }

    if (
      exportedName === 'default' &&
      statement.type === 'ExportDefaultDeclaration'
    ) {
      const { declaration } = statement;
      if (declaration.type === 'Identifier') {
        const importBinding = imports.get(declaration.name);
        if (importBinding) {
          return {
            imported: importBinding.imported,
            kind: 'import',
            source: importBinding.source,
          };
        }

        const local = locals.get(declaration.name);
        if (local) {
          return {
            expression: local,
            kind: 'expression',
            localName: declaration.name,
          };
        }

        return null;
      }

      return {
        expression: declaration as Expression,
        kind: 'expression',
      };
    }
  }

  return null;
};

function* resolveDependency(
  action: ITransformAction,
  importer: string,
  source: string,
  imported: string
): SyncScenarioFor<IEntrypointDependency | null> {
  const entrypoint =
    importer === action.entrypoint.name
      ? action.entrypoint
      : Entrypoint.createRoot(action.services, importer, [imported], undefined);
  const imports = new Map([[source, [imported]]]);
  const [resolved] = yield* action.getNext('resolveImports', entrypoint, {
    imports,
    phase: 'initial',
  });

  return resolved ?? null;
}

function* resolveImportValue(
  action: ITransformAction,
  importer: string,
  binding: Pick<ImportBinding, 'imported' | 'source'>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<StaticExportResult | null> {
  const dependency = yield* resolveDependency(
    action,
    importer,
    binding.source,
    binding.imported
  );
  if (!dependency?.resolved) {
    debugStaticResolve(action, {
      filename: importer,
      imported: binding.imported,
      phase: 'import',
      reason: 'dependency-unresolved',
      source: binding.source,
      status: 'rejected',
    });
    return null;
  }

  const resolved = yield* resolveStaticExport(
    action,
    dependency.resolved,
    binding.imported,
    stack,
    memo
  );
  if (!resolved) {
    debugStaticResolve(action, {
      dependency: dependency.resolved,
      filename: importer,
      imported: binding.imported,
      phase: 'import',
      reason: 'resolve-failed',
      source: binding.source,
      status: 'rejected',
    });
    return null;
  }

  debugStaticResolve(action, {
    dependency: dependency.resolved,
    filename: importer,
    imported: binding.imported,
    phase: 'import',
    source: binding.source,
    status: 'resolved',
  });

  return {
    dependencies: [
      dependency.resolved,
      ...resolved.dependencies.filter((item) => item !== dependency.resolved),
    ],
    value: resolved.value,
  };
}

function* resolveExportAsOpaqueRuntimeImport(
  action: ITransformAction,
  filename: string,
  exportedName: string,
  stack: Set<string>,
  memo: Map<string, OpaqueRuntimeImportProof | null>
): SyncScenarioFor<OpaqueRuntimeImportProof | null> {
  const memoKey = `${filename}\0${exportedName}`;
  if (memo.has(memoKey)) {
    return memo.get(memoKey) ?? null;
  }

  if (stack.has(memoKey)) {
    memo.set(memoKey, null);
    return null;
  }

  stack.add(memoKey);

  const loadedAndParsed = action.services.loadAndParseFn(
    action.services,
    filename,
    undefined,
    action.services.log
  );
  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.evaluator !== oxcShaker
  ) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    return null;
  }

  const program = parseProgram(loadedAndParsed.code, filename);
  const target = findExportTarget(program, exportedName);
  if (!target || target.kind !== 'import') {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    return null;
  }

  const resolved = yield* resolveImportAsOpaqueRuntime(
    action,
    filename,
    target,
    stack,
    memo
  );
  memo.set(memoKey, resolved);
  stack.delete(memoKey);
  return resolved;
}

const knownOpaqueRuntimeSourceDependency = (
  importer: string,
  source: string
): string | null => {
  if (!isKnownOpaqueRuntimeImportSource(source)) {
    return null;
  }

  const request = stripQueryAndHash(source);
  if (isAbsolute(request)) {
    return request;
  }

  return request.startsWith('.')
    ? resolvePath(dirname(importer), request)
    : null;
};

function* resolveImportAsOpaqueRuntime(
  action: ITransformAction,
  importer: string,
  binding: Pick<ImportBinding, 'imported' | 'source'>,
  stack: Set<string>,
  memo: Map<string, OpaqueRuntimeImportProof | null>
): SyncScenarioFor<OpaqueRuntimeImportProof | null> {
  const knownSourceDependency = knownOpaqueRuntimeSourceDependency(
    importer,
    binding.source
  );
  if (knownSourceDependency) {
    return {
      dependencies: [knownSourceDependency],
      names: new Set(),
    };
  }

  const dependency = yield* resolveDependency(
    action,
    importer,
    binding.source,
    binding.imported
  );
  if (!dependency?.resolved) {
    return null;
  }

  if (
    isKnownOpaqueRuntimeImportSource(binding.source) ||
    isKnownOpaqueRuntimeImportSource(dependency.resolved)
  ) {
    return {
      dependencies: [dependency.resolved],
      names: new Set(),
    };
  }

  const resolved = yield* resolveExportAsOpaqueRuntimeImport(
    action,
    dependency.resolved,
    binding.imported,
    stack,
    memo
  );
  return resolved
    ? {
        dependencies: [
          dependency.resolved,
          ...resolved.dependencies.filter(
            (item) => item !== dependency.resolved
          ),
        ],
        names: resolved.names,
      }
    : null;
}

function* collectOpaqueRuntimeImportProof(
  action: ITransformAction,
  filename: string,
  program: Program,
  expression: Expression
): SyncScenarioFor<OpaqueRuntimeImportProof> {
  const extendsExpression = findWYWMetaExtendsExpression(expression);
  if (!extendsExpression) {
    return {
      dependencies: [],
      names: new Set(),
    };
  }

  const imports = collectImportBindings(program);
  const referencedNames = new Set<string>();
  collectOpaqueRuntimeReferenceNames(
    program,
    extendsExpression,
    referencedNames
  );

  const dependencies = new Set<string>();
  const names = new Set<string>();
  const memo = new Map<string, OpaqueRuntimeImportProof | null>();

  for (const name of referencedNames) {
    const binding = imports.get(name);
    if (!binding || binding.source === 'react') {
      continue;
    }

    const proof = yield* resolveImportAsOpaqueRuntime(
      action,
      filename,
      binding,
      new Set(),
      memo
    );
    if (!proof) {
      continue;
    }

    names.add(name);
    proof.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  return {
    dependencies: [...dependencies],
    names,
  };
}

function* resolveProcessorStaticExport(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  exportedName: string,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<StaticExportResult | null> {
  const root = action.services.options.root ?? process.cwd();
  if (!isLocalStaticMetadataFile(filename, root)) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'outside-root',
      status: 'rejected',
    });
    return null;
  }

  if (
    collectProcessorImportLocals(action, program, code, filename).size === 0
  ) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'no-processor-imports',
      status: 'rejected',
    });
    return null;
  }

  let preevalResult: ReturnType<typeof runOxcPreevalStage>;
  try {
    preevalResult = action.services.eventEmitter.perf(
      'transform:preeval:staticMetadata',
      () =>
        runOxcPreevalStage(
          code,
          {
            filename,
            root,
          },
          {
            ...action.services.options.pluginOptions,
            eventEmitter: action.services.eventEmitter,
          }
        )
    );
  } catch {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'metadata-preeval-failed',
      status: 'rejected',
    });
    return null;
  }

  if (!preevalResult.metadata) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'metadata-missing',
      status: 'rejected',
    });
    return null;
  }

  const preevalCode = preevalResult.baseCode;
  const preevalProgram = parseProgram(preevalCode, filename);
  const target = findExportTarget(preevalProgram, exportedName);
  if (!target || target.kind === 'import') {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'processor-target-missing',
      status: 'rejected',
    });
    return null;
  }

  const processorExpression = resolveObjectAssignProcessorExpression(
    preevalProgram,
    target.expression
  );
  const opaqueRuntimeImportProof = yield* collectOpaqueRuntimeImportProof(
    action,
    filename,
    preevalProgram,
    processorExpression
  );
  const preparedTarget = prepareProcessorTarget(
    preevalCode,
    preevalProgram,
    target,
    opaqueRuntimeImportProof.names
  );
  if (!preparedTarget) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'unsupported-processor-expression',
      status: 'rejected',
    });
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);
  opaqueRuntimeImportProof.dependencies.forEach((dependency) =>
    dependencies.add(dependency)
  );

  for (const binding of preparedTarget.dependencies.imports) {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!resolved) {
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        imported: binding.imported,
        phase: 'processor-metadata',
        reason: 'resolve-failed',
        source: binding.source,
        status: 'rejected',
      });
      return null;
    }

    env.set(binding.local, createOxcStaticCallableValue(resolved.value));
    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  const value = preparedTarget.expressionCode
    ? evaluateOxcStaticExpression(preparedTarget.expressionCode, filename, env)
    : evaluateOxcStaticExpressionAt(
        preevalCode,
        filename,
        {
          end: preparedTarget.expression.end,
          start: preparedTarget.expression.start,
        },
        env
      );
  if (!isOxcStaticSerializableValue(value)) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'non-serializable',
      status: 'rejected',
    });
    return null;
  }

  if (
    !isStaticWYWMetaValue(value) &&
    !isSelectorOnlyProcessorValue(
      value,
      preevalResult.metadata.processors as unknown as StaticProcessorInstance[],
      new Map()
    )
  ) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'processor-metadata',
      reason: 'non-empty-css-artifact',
      status: 'rejected',
    });
    return null;
  }

  debugStaticResolve(action, {
    exported: exportedName,
    filename,
    phase: 'processor-metadata',
    reason: preparedTarget.opaqueRuntimeBase
      ? 'opaque-runtime-component'
      : undefined,
    status: 'resolved',
  });

  return {
    dependencies: [...dependencies],
    value,
  };
}

function* resolveObjectAssignStaticExport(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<StaticExportResult | null> {
  const objectAssignTarget = objectAssignTargetExpression(
    program,
    target.expression
  );
  if (!objectAssignTarget) {
    return null;
  }

  const imports = collectImportBindings(program);
  if (objectAssignTarget.type === 'Identifier') {
    const importBinding = imports.get(objectAssignTarget.name);
    if (importBinding) {
      const resolved = yield* resolveImportValue(
        action,
        filename,
        importBinding,
        stack,
        memo
      );
      if (!resolved || !isStaticWYWMetaValue(resolved.value)) {
        return null;
      }

      return {
        dependencies: [
          filename,
          ...resolved.dependencies.filter((item) => item !== filename),
        ],
        value: resolved.value,
      };
    }
  }

  const expression =
    objectAssignTarget.type === 'Identifier'
      ? findTopLevelConstExpression(program, objectAssignTarget.name) ??
        objectAssignTarget
      : objectAssignTarget;
  const staticDependencies = collectStaticExpressionDependencies(program, {
    ...target,
    expression,
  });
  if (!staticDependencies) {
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);

  for (const binding of staticDependencies.imports) {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!resolved) {
      return null;
    }

    env.set(binding.local, resolved.value);
    resolved.dependencies.forEach((item) => dependencies.add(item));
  }

  const value = evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: expression.end,
      start: expression.start,
    },
    env
  );
  return isStaticWYWMetaValue(value)
    ? {
        dependencies: [...dependencies],
        value,
      }
    : null;
}

function* resolveStaticExport(
  action: ITransformAction,
  filename: string,
  exportedName: string,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<StaticExportResult | null> {
  const memoKey = `${filename}\0${exportedName}`;
  if (memo.has(memoKey)) {
    return memo.get(memoKey) ?? null;
  }

  if (stack.has(memoKey)) {
    memo.set(memoKey, null);
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'cyclic-export',
      status: 'rejected',
    });
    return null;
  }

  stack.add(memoKey);

  const loadedAndParsed = action.services.loadAndParseFn(
    action.services,
    filename,
    undefined,
    action.services.log
  );
  if (
    loadedAndParsed.evaluator === 'ignored' ||
    loadedAndParsed.evaluator !== oxcShaker
  ) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'ignored-or-non-oxc',
      status: 'rejected',
    });
    return null;
  }

  const { code } = loadedAndParsed;
  const program = parseProgram(code, filename);
  const target = findExportTarget(program, exportedName);
  if (!target) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'no-export-target',
      status: 'rejected',
    });
    return null;
  }

  if (target.kind === 'import') {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      target,
      stack,
      memo
    );
    memo.set(memoKey, resolved);
    stack.delete(memoKey);
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      imported: target.imported,
      phase: 'export',
      reason: resolved ? undefined : 'resolve-failed',
      source: target.source,
      status: resolved ? 'resolved' : 'rejected',
    });
    return resolved;
  }

  const objectAssignResult = yield* resolveObjectAssignStaticExport(
    action,
    filename,
    code,
    program,
    target,
    stack,
    memo
  );
  if (objectAssignResult) {
    memo.set(memoKey, objectAssignResult);
    stack.delete(memoKey);
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'object-assign',
      status: 'resolved',
    });
    return objectAssignResult;
  }

  const staticDependencies = collectStaticExpressionDependencies(
    program,
    target
  );
  if (!staticDependencies) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'unsupported-expression',
      status: 'rejected',
    });
    const metadataResult = yield* resolveProcessorStaticExport(
      action,
      filename,
      code,
      program,
      exportedName,
      stack,
      memo
    );
    memo.set(memoKey, metadataResult);
    stack.delete(memoKey);
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: metadataResult ? undefined : 'resolve-failed',
      status: metadataResult ? 'resolved' : 'rejected',
    });
    return metadataResult;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);

  for (const binding of staticDependencies.imports) {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!resolved) {
      memo.set(memoKey, null);
      stack.delete(memoKey);
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        imported: binding.imported,
        phase: 'export',
        reason: 'resolve-failed',
        source: binding.source,
        status: 'rejected',
      });
      return null;
    }

    env.set(binding.local, resolved.value);
    resolved.dependencies.forEach((item) => dependencies.add(item));
  }

  const value = evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: target.expression.end,
      start: target.expression.start,
    },
    env
  );
  if (!isOxcStaticSerializableValue(value)) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'non-serializable',
      status: 'rejected',
    });
    return null;
  }

  const result = {
    dependencies: [...dependencies],
    value,
  };
  memo.set(memoKey, result);
  stack.delete(memoKey);
  debugStaticResolve(action, {
    exported: exportedName,
    filename,
    phase: 'export',
    status: 'resolved',
  });
  return result;
}

function* resolveCandidateValue(
  action: ITransformAction,
  candidate: OxcStaticValueCandidate,
  filename: string,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<StaticExportResult | null> {
  const env = new Map<string, unknown>();
  const dependencies = new Set<string>();

  for (const item of candidate.imports) {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      item,
      new Set(),
      memo
    );
    if (!resolved) {
      debugStaticResolve(action, {
        candidate: candidate.name,
        filename,
        imported: item.imported,
        phase: 'candidate',
        reason: 'candidate-import-unresolved',
        source: item.source,
        status: 'rejected',
      });
      return null;
    }

    env.set(item.local, resolved.value);
    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  const value = evaluateOxcStaticExpression(candidate.source, filename, env);
  if (!isOxcStaticSerializableValue(value)) {
    debugStaticResolve(action, {
      candidate: candidate.name,
      filename,
      phase: 'candidate',
      reason: 'candidate-expression-non-serializable',
      status: 'rejected',
    });
    return null;
  }

  debugStaticResolve(action, {
    candidate: candidate.name,
    filename,
    phase: 'candidate',
    status: 'resolved',
  });

  return {
    dependencies: [...dependencies],
    value,
  };
}

function* resolveOpaqueRuntimeCandidateValue(
  action: ITransformAction,
  candidate: OxcStaticValueCandidate,
  filename: string
): SyncScenarioFor<StaticExportResult | null> {
  if (candidate.imports.length === 0) {
    return null;
  }

  const dependencies = new Set<string>();
  const memo = new Map<string, OpaqueRuntimeImportProof | null>();

  for (const item of candidate.imports) {
    const proof = yield* resolveImportAsOpaqueRuntime(
      action,
      filename,
      item,
      new Set(),
      memo
    );
    if (!proof) {
      return null;
    }

    proof.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  return {
    dependencies: [...dependencies],
    value: null,
  };
}

export function* resolveStaticOxcPreevalValues(
  this: ITransformAction
): SyncScenarioFor<boolean> {
  const preevalResult = this.entrypoint.getPreevalResult();
  const candidates = preevalResult?.staticValueCandidates ?? [];
  if (!preevalResult || candidates.length === 0) {
    return false;
  }

  const filename =
    this.entrypoint.loadedAndParsed.evaluator === 'ignored'
      ? this.entrypoint.name
      : this.entrypoint.loadedAndParsed.evalConfig.filename ??
        this.entrypoint.name;
  if (!isStaticImportValuesEnabled(this, filename)) {
    debugStaticResolve(this, {
      filename,
      phase: 'entrypoint',
      reason: 'feature-disabled',
      status: 'skipped',
    });
    return false;
  }

  const staticValueCache =
    preevalResult.staticValueCache ?? new Map<string, unknown>();
  const staticDependencies = new Set(preevalResult.staticDependencies ?? []);
  const staticImportLocals = new Set<string>();
  const staticNullWYWMetaExtendsHelpers = new Set(
    preevalResult.staticNullWYWMetaExtendsHelpers ?? []
  );
  const memo = new Map<string, StaticExportResult | null>();
  const opaqueRuntimeBaseHelpers = collectWYWMetaExtendsHelperNames(
    parseProgram(preevalResult.baseCode ?? preevalResult.code, filename)
  );
  let changed = false;
  let hasKnownStaticCandidate = false;

  for (const candidate of candidates) {
    const isOpaqueRuntimeBaseHelper = opaqueRuntimeBaseHelpers.has(
      candidate.name
    );
    if (staticValueCache.has(candidate.name)) {
      hasKnownStaticCandidate = true;
      candidate.imports.forEach((item) =>
        staticImportLocals.add(item.importLocal ?? item.local)
      );
      if (
        isOpaqueRuntimeBaseHelper &&
        staticValueCache.get(candidate.name) === null
      ) {
        staticNullWYWMetaExtendsHelpers.add(candidate.name);
      }
      debugStaticResolve(this, {
        candidate: candidate.name,
        filename,
        phase: 'candidate',
        reason: 'already-static',
        status: 'skipped',
      });
      continue;
    }

    let resolved: StaticExportResult | null;
    let resolvedOpaqueRuntimeBase = false;
    if (isOpaqueRuntimeBaseHelper) {
      resolved = yield* resolveOpaqueRuntimeCandidateValue(
        this,
        candidate,
        filename
      );
      resolvedOpaqueRuntimeBase = !!resolved;
      if (!resolved) {
        resolved = yield* resolveCandidateValue(
          this,
          candidate,
          filename,
          memo
        );
      }
    } else {
      resolved = yield* resolveCandidateValue(this, candidate, filename, memo);
    }
    if (!resolved) {
      continue;
    }

    if (resolvedOpaqueRuntimeBase) {
      debugStaticResolve(this, {
        candidate: candidate.name,
        filename,
        phase: 'candidate',
        reason: 'opaque-runtime-component',
        status: 'resolved',
      });
      staticNullWYWMetaExtendsHelpers.add(candidate.name);
    }

    staticValueCache.set(candidate.name, resolved.value);
    hasKnownStaticCandidate = true;
    candidate.imports.forEach((item) =>
      staticImportLocals.add(item.importLocal ?? item.local)
    );
    resolved.dependencies.forEach((dependency) =>
      staticDependencies.add(dependency)
    );
    changed = true;
  }

  if (!changed && !hasKnownStaticCandidate) {
    return false;
  }

  const dependencyNames = (preevalResult.dependencyNames ?? []).filter(
    (name) => !staticValueCache.has(name)
  );
  preevalResult.dependencyNames = dependencyNames;
  preevalResult.staticValueCache = staticValueCache;
  preevalResult.staticDependencies = [...staticDependencies];
  preevalResult.staticNullWYWMetaExtendsHelpers = [
    ...staticNullWYWMetaExtendsHelpers,
  ];
  const baseCode = pruneStaticPreevalCode(
    preevalResult.baseCode ?? preevalResult.code,
    filename,
    new Set(staticValueCache.keys()),
    staticImportLocals,
    staticNullWYWMetaExtendsHelpers
  );
  preevalResult.baseCode = baseCode;
  preevalResult.code = appendOxcWywPreval(baseCode, filename, dependencyNames);

  for (const dependency of staticDependencies) {
    this.entrypoint.addInvalidationDependency({
      only: ['*'],
      resolved: dependency,
      source: dependency,
    });
    this.entrypoint.markInvalidateOnDependencyChange(dependency);
  }

  return true;
}
