/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { isAbsolute, relative } from 'path';

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

const isInsideRoot = (filename: string, root: string): boolean => {
  const relativePath = relative(root, filename);
  return (
    relativePath === '' ||
    (!!relativePath &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath))
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

const removeRanges = (code: string, ranges: Range[]): string => {
  let result = code;
  ranges
    .sort((a, b) => b.start - a.start)
    .forEach((range) => {
      result = result.slice(0, range.start) + result.slice(range.end);
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

const removeStaticHelperDeclarations = (
  code: string,
  filename: string,
  staticValueNames: Set<string>
): { code: string; removed: Set<string> } => {
  if (staticValueNames.size === 0) {
    return { code, removed: new Set() };
  }

  const program = parseProgram(code, filename);
  const removableNames = removableStaticHelperNames(program, staticValueNames);
  const ranges: Range[] = [];

  program.body.forEach((statement) => {
    if (
      statement.type !== 'VariableDeclaration' ||
      statement.declarations.length === 0
    ) {
      return;
    }

    if (
      statement.declarations.every(
        (declarator) =>
          declarator.id.type === 'Identifier' &&
          removableNames.has(declarator.id.name)
      )
    ) {
      ranges.push({
        end: statement.end,
        start: statement.start,
      });
    }
  });

  return {
    code: removeRanges(code, ranges),
    removed: removableNames,
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

const pruneStaticPreevalCode = (
  code: string,
  filename: string,
  staticValueNames: Set<string>,
  staticImportLocals: Set<string>
): string => {
  const helpersRemoved = removeStaticHelperDeclarations(
    code,
    filename,
    staticValueNames
  );
  if (helpersRemoved.removed.size === 0) {
    return code;
  }

  return removeUnusedStaticImports(
    helpersRemoved.code,
    filename,
    staticImportLocals
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
    return null;
  }

  return {
    dependencies: [
      dependency.resolved,
      ...resolved.dependencies.filter((item) => item !== dependency.resolved),
    ],
    value: resolved.value,
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
  if (!isInsideRoot(filename, root)) {
    return null;
  }

  if (
    collectProcessorImportLocals(action, program, code, filename).size === 0
  ) {
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
    return null;
  }

  if (!preevalResult.metadata) {
    return null;
  }

  const preevalCode = preevalResult.baseCode;
  const preevalProgram = parseProgram(preevalCode, filename);
  const target = findExportTarget(preevalProgram, exportedName);
  if (!target || target.kind === 'import') {
    return null;
  }

  const staticDependencies = collectStaticExpressionDependencies(
    preevalProgram,
    target,
    {
      allowMetadataCalls: true,
    }
  );
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

    env.set(binding.local, createOxcStaticCallableValue(resolved.value));
    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  const value = evaluateOxcStaticExpressionAt(
    preevalCode,
    filename,
    {
      end: target.expression.end,
      start: target.expression.start,
    },
    env
  );
  if (!isOxcStaticSerializableValue(value)) {
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
    return null;
  }

  return {
    dependencies: [...dependencies],
    value,
  };
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

  const { code } = loadedAndParsed;
  const program = parseProgram(code, filename);
  const target = findExportTarget(program, exportedName);
  if (!target) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
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
    return resolved;
  }

  const staticDependencies = collectStaticExpressionDependencies(
    program,
    target
  );
  if (!staticDependencies) {
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
    return null;
  }

  const result = {
    dependencies: [...dependencies],
    value,
  };
  memo.set(memoKey, result);
  stack.delete(memoKey);
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
      return null;
    }

    env.set(item.local, resolved.value);
    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  const value = evaluateOxcStaticExpression(candidate.source, filename, env);
  if (!isOxcStaticSerializableValue(value)) {
    return null;
  }

  return {
    dependencies: [...dependencies],
    value,
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
    return false;
  }

  const staticValueCache =
    preevalResult.staticValueCache ?? new Map<string, unknown>();
  const staticDependencies = new Set(preevalResult.staticDependencies ?? []);
  const staticImportLocals = new Set<string>();
  const memo = new Map<string, StaticExportResult | null>();
  let changed = false;

  for (const candidate of candidates) {
    if (staticValueCache.has(candidate.name)) {
      continue;
    }

    const resolved = yield* resolveCandidateValue(
      this,
      candidate,
      filename,
      memo
    );
    if (!resolved) {
      continue;
    }

    staticValueCache.set(candidate.name, resolved.value);
    candidate.imports.forEach((item) =>
      staticImportLocals.add(item.importLocal ?? item.local)
    );
    resolved.dependencies.forEach((dependency) =>
      staticDependencies.add(dependency)
    );
    changed = true;
  }

  if (!changed) {
    return false;
  }

  const dependencyNames = (preevalResult.dependencyNames ?? []).filter(
    (name) => !staticValueCache.has(name)
  );
  preevalResult.dependencyNames = dependencyNames;
  preevalResult.staticValueCache = staticValueCache;
  preevalResult.staticDependencies = [...staticDependencies];
  const baseCode = pruneStaticPreevalCode(
    preevalResult.baseCode ?? preevalResult.code,
    filename,
    new Set(staticValueCache.keys()),
    staticImportLocals
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
