/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
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
  lookupStaticBinding,
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
  imported: '*' | 'default' | string;
  local: string;
  source: string;
};

type CollectImportBindingsOptions = {
  includeNamespace?: boolean;
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
  callable?: 'zero-arg';
  dependencies: string[];
  // True when the candidate's value is a runtime callback (function)
  // already represented in the bundle as the locally-defined `_exp =
  // () => ...` arrow. The file does not need evalFile because of this
  // candidate, but the helper declaration must NOT be pruned — the
  // runtime call site relies on it.
  runtimeOnly?: boolean;
  sideEffectDependencies?: string[];
  sideEffectImportLocals?: string[];
  value: unknown;
};

type StaticFileAnalysis = {
  code: string;
  codeHash: string;
  program: Program;
};

type StaticFileHashCacheEntry = {
  hash: string;
  mtimeMs: number;
  size: number;
};

type StaticMetadataPreevalCacheEntry =
  | {
      result: null;
    }
  | {
      result: ReturnType<typeof runOxcPreevalStage>;
    };

// Null entries carry an attempt counter so we can retry a bounded number of
// times before accepting the failure as stable. This avoids both:
// (a) poisoning the cache forever from a transient resolver failure
// (b) thundering-herd retries where every consumer re-walks a stable miss
type StaticExportCacheEntry =
  | {
      attempts: number;
      result: null;
    }
  | {
      dependencyHashes: Map<string, string>;
      result: StaticExportResult;
    };

const STATIC_EXPORT_MAX_NULL_ATTEMPTS = 2;

type StaticImportValueFeatures = {
  staticImportValues?: FeatureFlag;
};

type StaticExpressionOptions = {
  allowMetadataCalls?: boolean;
  ignoredMutableCallArgumentNames?: Set<string>;
  // Names of same-file locals whose value the resolver already knows
  // out-of-band (e.g. processor className strings from
  // applyOxcProcessors). Skip walking into their inits during
  // dependency collection — `const x = css\`...\`` has a
  // TaggedTemplateExpression init that fails isSafeStaticExpression,
  // but we don't need to walk it because `x`'s value is already
  // resolved.
  preResolvedLocals?: ReadonlySet<string>;
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

const debugStaticResolve = (
  action: ITransformAction,
  event: StaticResolveDebugEvent
): void => {
  const labels = Object.fromEntries(
    Object.entries({
      ...event,
      type: 'staticResolve',
    }).filter(([, value]) => value !== undefined)
  );

  action.services.eventEmitter.single(labels);
};

const parseProgram = (code: string, filename: string): Program =>
  parseOxcProgramCached(filename, code, 'unambiguous');

const staticFileAnalysisCaches = new WeakMap<
  object,
  Map<string, StaticFileAnalysis>
>();

const staticFileHashCaches = new WeakMap<
  object,
  Map<string, StaticFileHashCacheEntry>
>();

const staticExportResultCaches = new WeakMap<
  object,
  Map<string, StaticExportCacheEntry>
>();

const staticMetadataPreevalCaches = new WeakMap<
  object,
  Map<string, StaticMetadataPreevalCacheEntry>
>();

const hashStaticContent = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

const getWeakCacheMap = <TValue>(
  caches: WeakMap<object, Map<string, TValue>>,
  key: object
): Map<string, TValue> => {
  let cache = caches.get(key);
  if (!cache) {
    cache = new Map();
    caches.set(key, cache);
  }

  return cache;
};

const isStaticResolveCacheEnabled = (): boolean => {
  const envValue = process.env.WYW_STATIC_RESOLVE_CACHE?.trim().toLowerCase();
  if (envValue) {
    return !isEnvDisabled(envValue);
  }

  return true;
};

const staticCachePrefix = (action: ITransformAction): string =>
  `${action.services.cache.getKeySalt() ?? ''}\0${
    action.services.options.root ?? ''
  }`;

const getStaticBindings = (
  action: ITransformAction
): Record<string, Record<string, unknown>> | undefined =>
  action.services.options.pluginOptions?.staticBindings;

const staticFileAnalysisCache = (
  action: ITransformAction
): Map<string, StaticFileAnalysis> =>
  getWeakCacheMap(staticFileAnalysisCaches, action.services.cache);

const staticFileHashCache = (
  action: ITransformAction
): Map<string, StaticFileHashCacheEntry> =>
  getWeakCacheMap(staticFileHashCaches, action.services.cache);

const staticExportResultCache = (
  action: ITransformAction
): Map<string, StaticExportCacheEntry> =>
  getWeakCacheMap(staticExportResultCaches, action.services.cache);

const staticMetadataPreevalCache = (
  action: ITransformAction
): Map<string, StaticMetadataPreevalCacheEntry> =>
  getWeakCacheMap(staticMetadataPreevalCaches, action.services.cache);

const staticFileAnalysisCacheKey = (
  action: ITransformAction,
  filename: string,
  codeHash: string
): string => `${staticCachePrefix(action)}\0${filename}\0${codeHash}`;

const staticExportCacheKey = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string
): string =>
  `${staticCachePrefix(action)}\0${filename}\0${exportedName}\0${codeHash}`;

const staticMetadataPreevalCacheKey = (
  action: ITransformAction,
  filename: string,
  codeHash: string
): string => `${staticCachePrefix(action)}\0${filename}\0${codeHash}`;

const getStaticFileContentHash = (
  action: ITransformAction,
  dependency: string
): string | null => {
  const filename = stripQueryAndHash(dependency);
  if (!isAbsolute(filename)) {
    return null;
  }

  let stat;
  try {
    stat = statSync(filename);
  } catch {
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  const cache = staticFileHashCache(action);
  const cached = cache.get(filename);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.hash;
  }

  let hash: string;
  try {
    hash = hashStaticContent(readFileSync(filename));
  } catch {
    return null;
  }

  cache.set(filename, {
    hash,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  });
  return hash;
};

const collectStaticDependencyHashes = (
  action: ITransformAction,
  dependencies: string[]
): Map<string, string> | null => {
  const hashes = new Map<string, string>();
  for (const dependency of dependencies) {
    const hash = getStaticFileContentHash(action, dependency);
    if (!hash) {
      return null;
    }

    hashes.set(stripQueryAndHash(dependency), hash);
  }

  return hashes;
};

const areStaticDependencyHashesCurrent = (
  action: ITransformAction,
  dependencyHashes: Map<string, string>
): boolean => {
  for (const [dependency, expectedHash] of dependencyHashes) {
    if (getStaticFileContentHash(action, dependency) !== expectedHash) {
      return false;
    }
  }

  return true;
};

const getStaticExportCachedResult = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string
): StaticExportResult | null | undefined => {
  if (!isStaticResolveCacheEnabled()) {
    return undefined;
  }

  const cache = staticExportResultCache(action);
  const cacheKey = staticExportCacheKey(
    action,
    filename,
    exportedName,
    codeHash
  );
  const cached = cache.get(cacheKey);
  if (!cached) {
    return undefined;
  }

  if (cached.result === null) {
    // Bounded retry: until the attempt counter has been bumped enough times
    // that we accept the null as stable, treat it as a cache miss so the
    // caller re-walks. The counter is updated in setStaticExportCachedResult.
    if (cached.attempts < STATIC_EXPORT_MAX_NULL_ATTEMPTS) {
      return undefined;
    }
    return null;
  }

  if (areStaticDependencyHashesCurrent(action, cached.dependencyHashes)) {
    return cached.result;
  }

  cache.delete(cacheKey);
  return undefined;
};

const setStaticExportCachedResult = (
  action: ITransformAction,
  filename: string,
  exportedName: string,
  codeHash: string,
  result: StaticExportResult | null
): void => {
  if (!isStaticResolveCacheEnabled()) {
    return;
  }

  const cache = staticExportResultCache(action);
  const cacheKey = staticExportCacheKey(
    action,
    filename,
    exportedName,
    codeHash
  );
  if (!result) {
    const existing = cache.get(cacheKey);
    const attempts =
      existing && existing.result === null ? existing.attempts + 1 : 1;
    cache.set(cacheKey, { attempts, result: null });
    return;
  }

  const dependencyHashes = collectStaticDependencyHashes(
    action,
    result.dependencies
  );
  if (!dependencyHashes) {
    return;
  }

  cache.set(cacheKey, {
    dependencyHashes,
    result,
  });
};

const getStaticFileAnalysis = (
  action: ITransformAction,
  filename: string
): StaticFileAnalysis | null => {
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
    return null;
  }

  const { code } = loadedAndParsed;
  const codeHash = hashStaticContent(code);
  const cache = staticFileAnalysisCache(action);
  const cacheKey = staticFileAnalysisCacheKey(action, filename, codeHash);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const analysis = {
    code,
    codeHash,
    program: parseProgram(code, filename),
  };
  cache.set(cacheKey, analysis);
  return analysis;
};

const getStaticMetadataPreevalResult = (
  action: ITransformAction,
  filename: string,
  code: string,
  codeHash: string
): ReturnType<typeof runOxcPreevalStage> | null => {
  const cache = staticMetadataPreevalCache(action);
  const cacheKey = staticMetadataPreevalCacheKey(action, filename, codeHash);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached.result;
  }

  const root = action.services.options.root ?? process.cwd();
  try {
    const result = action.services.eventEmitter.perf(
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
    cache.set(cacheKey, { result });
    return result;
  } catch {
    cache.set(cacheKey, { result: null });
    return null;
  }
};

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

const isProcessEnvMember = (node: Node): boolean => {
  if (node.type !== 'MemberExpression' || node.computed) {
    return false;
  }

  if (node.property.type !== 'Identifier' || node.property.name !== 'env') {
    return false;
  }

  return node.object.type === 'Identifier' && node.object.name === 'process';
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
      if (propertyNode.method) {
        return false;
      }

      // Computed keys are admissible as long as the key expression
      // itself is safe-static — the downstream evaluator already folds
      // them against the env. Common shape: `[\`${imp} &\`]: { ... }`.
      if (
        propertyNode.computed &&
        (!propertyNode.key ||
          typeof propertyNode.key !== 'object' ||
          !isSafeStaticExpression(propertyNode.key as Node, options))
      ) {
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
  specifier: ImportDeclaration['specifiers'][number],
  options: CollectImportBindingsOptions = {}
): ImportBinding | null => {
  const local = specifier.local?.name;
  if (!local) {
    return null;
  }

  if (specifier.type === 'ImportNamespaceSpecifier') {
    return options.includeNamespace
      ? {
          imported: '*',
          local,
          source: statement.source.value,
        }
      : null;
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
  program: Program,
  options: CollectImportBindingsOptions = {}
): Map<string, ImportBinding> => {
  const result = new Map<string, ImportBinding>();

  program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration' || isTypeOnlyImport(statement)) {
      return;
    }

    statement.specifiers.forEach((specifier) => {
      const binding = getImportBinding(statement, specifier, options);
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

const parseStaticExpressionSource = (
  source: string,
  filename: string
): Expression | null => {
  try {
    const program = parseProgram(
      `const __wyw_static_value = ${source};`,
      filename
    );
    const declaration = program.body[0];
    if (declaration?.type !== 'VariableDeclaration') {
      return null;
    }

    const [declarator] = declaration.declarations;
    return declarator?.init ?? null;
  } catch {
    return null;
  }
};

const expressionUsesNameOnlyAsZeroArgCalls = (
  expression: Node,
  name: string
): boolean => {
  let seen = false;
  let valid = true;

  const walk = (node: Node, parent: Node | null): void => {
    if (!valid) {
      return;
    }

    if (
      node.type === 'Identifier' &&
      node.name === name &&
      !isIdentifierBindingPosition(node, parent) &&
      !isPropertyKeyOnlyIdentifier(node, parent)
    ) {
      if (
        parent?.type === 'CallExpression' &&
        parent.callee === node &&
        parent.arguments.length === 0
      ) {
        seen = true;
      } else {
        valid = false;
        return;
      }
    }

    getChildren(node).forEach((child) => walk(child, node));
  };

  walk(expression, null);
  return seen && valid;
};

const bindStaticResolvedValue = (
  env: Map<string, unknown>,
  expression: Node,
  local: string,
  resolved: StaticExportResult,
  options: { wrapNonCallable?: boolean } = {}
): boolean => {
  if (resolved.callable === 'zero-arg') {
    if (!expressionUsesNameOnlyAsZeroArgCalls(expression, local)) {
      return false;
    }

    env.set(local, createOxcStaticCallableValue(resolved.value));
    return true;
  }

  env.set(
    local,
    options.wrapNonCallable
      ? createOxcStaticCallableValue(resolved.value)
      : resolved.value
  );
  return true;
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
  staticImportLocals: Set<string>,
  sideEffectImportLocals: Set<string>
): string => {
  if (staticImportLocals.size === 0) {
    return code;
  }

  const program = parseProgram(code, filename);
  const used = collectUsedIdentifierNames(program);
  const ranges: Range[] = [];
  const replacements: Replacement[] = [];

  program.body.forEach((statement) => {
    if (
      statement.type !== 'ImportDeclaration' ||
      statement.specifiers.length === 0
    ) {
      return;
    }

    const removable = statement.specifiers.flatMap((specifier, index) => {
      const localName = importSpecifierLocalName(specifier);
      return localName &&
        staticImportLocals.has(localName) &&
        !used.has(localName)
        ? [{ index, localName }]
        : [];
    });

    if (removable.length === 0) {
      return;
    }

    if (removable.length === statement.specifiers.length) {
      if (
        removable.some((item) => sideEffectImportLocals.has(item.localName))
      ) {
        replacements.push({
          end: statement.end,
          start: statement.start,
          text: `import ${code.slice(
            statement.source.start,
            statement.source.end
          )};`,
        });
        return;
      }

      ranges.push({
        end: statement.end,
        start: statement.start,
      });
    }
  });

  return applyReplacements(code, [
    ...ranges.map((range) => ({ ...range, text: '' })),
    ...replacements,
  ]);
};

const replaceStaticWYWMetaExtendsHelpers = (
  code: string,
  filename: string,
  helperValues: Map<string, unknown>
): string => {
  if (helperValues.size === 0) {
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
          helperValues.has(unwrapped.callee.name)
        ) {
          const replacement = staticWYWMetaExtendsReplacementCode(
            helperValues.get(unwrapped.callee.name)
          );
          if (replacement) {
            replacements.push({
              end: extendsExpression.end,
              start: extendsExpression.start,
              text: replacement,
            });
          }
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
  staticExtendsHelperValues: Map<string, unknown>,
  sideEffectImportLocals: Set<string>
): string => {
  const codeWithMetadataPruned = replaceStaticWYWMetaExtendsHelpers(
    code,
    filename,
    staticExtendsHelperValues
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
    importLocalsToPrune,
    sideEffectImportLocals
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

type StaticWYWSelectorMetaValue = {
  __wyw_meta: {
    className: string;
    extends: StaticWYWSelectorMetaValue | null;
  };
};

const toStaticWYWSelectorMetaValue = (
  value: unknown,
  seen: Set<unknown> = new Set()
): StaticWYWSelectorMetaValue | null => {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return null;
  }

  seen.add(value);

  const meta = (value as { __wyw_meta?: unknown }).__wyw_meta;
  if (typeof meta !== 'object' || meta === null) {
    return null;
  }

  const { className, extends: extended } = meta as {
    className?: unknown;
    extends?: unknown;
  };
  if (typeof className !== 'string') {
    return null;
  }

  const staticExtends =
    extended === null ? null : toStaticWYWSelectorMetaValue(extended, seen);
  if (extended !== null && staticExtends === null) {
    return null;
  }

  return {
    __wyw_meta: {
      className,
      extends: staticExtends,
    },
  };
};

const staticWYWMetaExtendsReplacementCode = (value: unknown): string | null => {
  if (value === null) {
    return 'null';
  }

  const selectorMeta = toStaticWYWSelectorMetaValue(value);
  return selectorMeta ? `(${JSON.stringify(selectorMeta)})` : null;
};

const staticWYWMetaTreeValueStatus = (
  value: unknown,
  seen: Set<unknown> = new Set()
): { hasMetadata: boolean; safe: boolean } => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return {
      hasMetadata: false,
      safe: true,
    };
  }

  if (typeof value !== 'object') {
    return {
      hasMetadata: false,
      safe: false,
    };
  }

  if (seen.has(value)) {
    return {
      hasMetadata: false,
      safe: false,
    };
  }
  seen.add(value);

  if (Array.isArray(value)) {
    let hasMetadata = false;
    for (const item of value) {
      const status = staticWYWMetaTreeValueStatus(item, seen);
      if (!status.safe) {
        return {
          hasMetadata: false,
          safe: false,
        };
      }

      hasMetadata = hasMetadata || status.hasMetadata;
    }

    return {
      hasMetadata,
      safe: true,
    };
  }

  if ('__wyw_meta' in value) {
    return {
      hasMetadata: isStaticWYWMetaValue(value),
      safe: isStaticWYWMetaValue(value),
    };
  }

  let hasMetadata = false;
  for (const item of Object.values(value)) {
    const status = staticWYWMetaTreeValueStatus(item, seen);
    if (!status.safe) {
      return {
        hasMetadata: false,
        safe: false,
      };
    }

    hasMetadata = hasMetadata || status.hasMetadata;
  }

  return {
    hasMetadata,
    safe: true,
  };
};

const isStaticWYWMetaTreeValue = (value: unknown): boolean => {
  const status = staticWYWMetaTreeValueStatus(value);
  return status.safe && status.hasMetadata;
};

type StaticProcessorInstance = {
  artifacts: unknown[];
  build: (values: Map<string, unknown>) => void;
  className: string;
};

const isPlainObjectRecord = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const isStaticObjectAssignAliasValue = (value: unknown): boolean =>
  isStaticWYWMetaValue(value) || isStaticWYWMetaTreeValue(value);

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

  if (processor.artifacts.length === 0) {
    try {
      processor.build(new Map());
    } catch {
      cache.set(value, false);
      return false;
    }
  }

  const result = processor.artifacts.every((artifact) => {
    const cssText = artifactCssText(artifact);
    return cssText !== null && cssText.trim() === '';
  });
  cache.set(value, result);
  return result;
};

const isProcessorClassName = (
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

  if (processor.artifacts.length === 0) {
    try {
      processor.build(new Map());
    } catch {
      cache.set(value, false);
      return false;
    }
  }

  const result = processor.artifacts.every(
    (artifact) => artifactCssText(artifact) !== null
  );
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

const isProcessorClassValue = (
  value: unknown,
  processors: StaticProcessorInstance[],
  cache: Map<string, boolean>,
  seen: Set<unknown> = new Set()
): boolean => {
  if (typeof value === 'string') {
    return isProcessorClassName(value, processors, cache);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return value.every((item) =>
      isProcessorClassValue(item, processors, cache, seen)
    );
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return false;
    }

    seen.add(value);
    return Object.values(value).every((item) =>
      isProcessorClassValue(item, processors, cache, seen)
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
  evaluationCode?: string;
  evaluationSpan?: Range;
  expression: Expression;
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
    if (isProcessEnvMember(unwrapped) || isProcessEnvMember(unwrapped.object)) {
      // process.env / process.env.X is an opaque build-time global —
      // don't treat `process` as an unresolved local reference.
      return true;
    }

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
      if (!propertyNode.value || typeof propertyNode.value !== 'object') {
        return false;
      }

      if (
        propertyNode.computed &&
        (!propertyNode.key ||
          typeof propertyNode.key !== 'object' ||
          !collectStaticExpressionReferences(
            propertyNode.key as Node,
            references,
            options
          ))
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
  program: Program,
  closureNames: ReadonlySet<string> | null = null
): { callArgumentNames: Set<string>; mutatedNames: Set<string> } => {
  const callArgumentNames = new Set<string>();
  const mutatedNames = new Set<string>();

  const collectDeclaration = (declaration: VariableDeclaration): void => {
    declaration.declarations.forEach((declarator) => {
      if (closureNames) {
        const declaredName =
          declarator.id.type === 'Identifier' ? declarator.id.name : null;
        if (!declaredName || !closureNames.has(declaredName)) {
          return;
        }
      }
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

const collectWYWMetaExtendsExpressions = (expr: Expression): Expression[] => {
  const result: Expression[] = [];
  const visit = (node: Node): void => {
    if (node.type === 'ObjectExpression') {
      const extendsExpression = findWYWMetaExtendsExpression(
        node as Expression
      );
      if (extendsExpression) {
        result.push(extendsExpression);
      }
    }

    getChildren(node).forEach(visit);
  };

  visit(expr);
  return result;
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

const functionReturnExpression = (
  expr: Node,
  options: { allowParams?: boolean } = {}
): Expression | null => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'ArrowFunctionExpression' &&
    unwrapped.type !== 'FunctionExpression'
  ) {
    return null;
  }

  if (
    unwrapped.async ||
    (!options.allowParams && unwrapped.params.length > 0) ||
    !unwrapped.body
  ) {
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

const isKnownOpaqueRuntimeWrapperImport = (
  binding: ImportBinding | undefined
): boolean => {
  if (!binding) {
    return false;
  }

  return (
    binding.imported === 'observer' &&
    (binding.source === 'mobx-react' || binding.source === 'mobx-react-lite')
  );
};

const isKnownOpaqueRuntimeWrapperCallee = (
  expr: Node,
  imports: Map<string, ImportBinding>
): boolean => {
  const callee = unwrapExpression(expr);
  if (callee.type === 'Identifier') {
    return isKnownOpaqueRuntimeWrapperImport(imports.get(callee.name));
  }

  return false;
};

const isKnownOpaqueRuntimeImportSource = (source: string): boolean =>
  /\.svg(?:$|[?#])/.test(source);

const isKnownExternalRuntimeComponentImportSource = (source: string): boolean =>
  source.startsWith('@radix-ui/react-');

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

const objectAssignAliasExpressions = (
  program: Program,
  expr: Node
): Expression[] | null => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'CallExpression' ||
    !isObjectAssignCallee(program, unwrapped.callee) ||
    unwrapped.arguments.length < 2
  ) {
    return null;
  }

  const [, ...aliases] = unwrapped.arguments;
  if (
    aliases.some(
      (alias) =>
        alias.type === 'SpreadElement' ||
        !isSafeObjectAssignAliasExpression(program, alias)
    )
  ) {
    return null;
  }

  return aliases as Expression[];
};

const isFunctionBoundaryNode = (node: Node): boolean =>
  node.type === 'ArrowFunctionExpression' ||
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ClassDeclaration' ||
  node.type === 'ClassExpression';

const callHasArgumentRootName = (expr: Node, targetName: string): boolean => {
  const unwrapped = unwrapExpression(expr);
  return (
    unwrapped.type === 'CallExpression' &&
    unwrapped.arguments.some((argument) => {
      const argumentNode =
        argument.type === 'SpreadElement' ? argument.argument : argument;
      return rootIdentifierName(argumentNode) === targetName;
    })
  );
};

const isSafeObjectAssignAliasAugmentation = (
  program: Program,
  expr: Node,
  targetName: string
): boolean => {
  const unwrapped = unwrapExpression(expr);
  if (
    unwrapped.type !== 'CallExpression' ||
    !isObjectAssignCallee(program, unwrapped.callee) ||
    unwrapped.arguments.length < 2
  ) {
    return false;
  }

  const [target, ...aliases] = unwrapped.arguments;
  if (!target || target.type === 'SpreadElement') {
    return false;
  }

  const unwrappedTarget = unwrapExpression(target);
  if (
    unwrappedTarget.type !== 'Identifier' ||
    unwrappedTarget.name !== targetName
  ) {
    return false;
  }

  return aliases.every(
    (alias) =>
      alias.type !== 'SpreadElement' &&
      isSafeObjectAssignAliasExpression(program, alias)
  );
};

const hasOnlySafeObjectAssignCallArgumentUses = (
  program: Program,
  targetName: string
): boolean => {
  let hasSafeUse = false;
  let hasUnsafeUse = false;

  const visit = (node: Node): void => {
    if (hasUnsafeUse || isFunctionBoundaryNode(node)) {
      return;
    }

    const unwrapped = unwrapExpression(node);
    if (unwrapped.type === 'CallExpression') {
      if (callHasArgumentRootName(unwrapped, targetName)) {
        if (
          isSafeObjectAssignAliasAugmentation(program, unwrapped, targetName)
        ) {
          hasSafeUse = true;
        } else {
          hasUnsafeUse = true;
          return;
        }
      }
    }

    getChildren(node).forEach(visit);
  };

  topLevelStatements(program).forEach(visit);
  return hasSafeUse && !hasUnsafeUse;
};

const objectAssignAugmentationAliasExpressions = (
  program: Program,
  targetName: string
): Expression[] | null => {
  const aliases: Expression[] = [];
  let hasUnsafeUse = false;

  const visit = (node: Node): void => {
    if (hasUnsafeUse || isFunctionBoundaryNode(node)) {
      return;
    }

    const unwrapped = unwrapExpression(node);
    if (unwrapped.type === 'CallExpression') {
      if (callHasArgumentRootName(unwrapped, targetName)) {
        if (
          isSafeObjectAssignAliasAugmentation(program, unwrapped, targetName)
        ) {
          const [, ...nextAliases] = unwrapped.arguments;
          aliases.push(...(nextAliases as Expression[]));
        } else {
          hasUnsafeUse = true;
        }

        return;
      }
    }

    getChildren(node).forEach(visit);
  };

  topLevelStatements(program).forEach(visit);
  return !hasUnsafeUse && aliases.length > 0 ? aliases : null;
};

const objectAssignAliasExpressionsForTarget = (
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>
): Expression[] | null => {
  const aliases = [
    ...(objectAssignAliasExpressions(program, target.expression) ?? []),
    ...(target.localName
      ? objectAssignAugmentationAliasExpressions(program, target.localName) ??
        []
      : []),
  ];

  return aliases.length > 0 ? aliases : null;
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

type ObjectAssignAliasResolution = {
  dependencies: string[];
  sideEffectDependencies: string[];
  values: Record<string, unknown>[];
};

type ObjectAssignAliasPropertyResolution = {
  dependencies: string[];
  sideEffectDependencies: string[];
  value: unknown;
};

type ObjectAssignAliasPropertyEntry = {
  key: string;
  value: Expression;
};

const mergeStaticObjectAssignAliases = (
  targetValue: unknown,
  aliasValues: Record<string, unknown>[]
): unknown | null => {
  if (!isPlainObjectRecord(targetValue) || !isStaticWYWMetaValue(targetValue)) {
    return null;
  }

  const result: Record<string, unknown> = { ...targetValue };
  aliasValues.forEach((aliasValue) => {
    Object.assign(result, aliasValue);
  });

  return result;
};

const objectAssignAliasObjectExpression = (
  program: Program,
  alias: Expression,
  seen: Set<string> = new Set()
): Expression | null => {
  const unwrapped = unwrapExpression(alias);
  if (unwrapped.type === 'ObjectExpression') {
    return unwrapped as Expression;
  }

  if (unwrapped.type !== 'Identifier' || seen.has(unwrapped.name)) {
    return null;
  }

  const local = findTopLevelConstExpression(program, unwrapped.name);
  if (!local) {
    return null;
  }

  seen.add(unwrapped.name);
  const result = objectAssignAliasObjectExpression(program, local, seen);
  seen.delete(unwrapped.name);
  return result;
};

const objectAssignAliasPropertyEntries = (
  program: Program,
  alias: Expression
): ObjectAssignAliasPropertyEntry[] | null => {
  const aliasObject = objectAssignAliasObjectExpression(program, alias);
  if (!aliasObject || aliasObject.type !== 'ObjectExpression') {
    return null;
  }

  const entries: ObjectAssignAliasPropertyEntry[] = [];
  for (const property of aliasObject.properties) {
    if (property.type === 'SpreadElement') {
      return null;
    }

    const propertyNode = property as AnyNode;
    if (
      propertyNode.computed ||
      propertyNode.method ||
      !propertyNode.key ||
      !propertyNode.value ||
      typeof propertyNode.key !== 'object' ||
      typeof propertyNode.value !== 'object'
    ) {
      return null;
    }

    const key = objectPropertyKeyName(propertyNode.key as Node);
    if (!key) {
      return null;
    }

    entries.push({
      key,
      value: propertyNode.value as Expression,
    });
  }

  return entries;
};

function* resolveObjectAssignAliasExpressionValue(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  expression: Expression,
  ignoredMutableCallArgumentNames: Set<string>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<ObjectAssignAliasPropertyResolution | null> {
  const staticDependencies = collectStaticExpressionDependencies(
    program,
    {
      expression,
      kind: 'expression',
    },
    {
      allowMetadataCalls: true,
      ignoredMutableCallArgumentNames,
    }
  );
  if (!staticDependencies) {
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();

  for (const binding of staticDependencies.imports) {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (
      !resolved ||
      !bindStaticResolvedValue(env, expression, binding.local, resolved)
    ) {
      return null;
    }

    resolved.dependencies.forEach((item) => dependencies.add(item));
    resolved.sideEffectDependencies?.forEach((item) =>
      sideEffectDependencies.add(item)
    );
  }

  const value = evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: expression.end,
      start: expression.start,
    },
    env,
    getStaticBindings(action)
  );
  return isStaticObjectAssignAliasValue(value)
    ? {
        dependencies: [...dependencies],
        sideEffectDependencies: [...sideEffectDependencies],
        value,
      }
    : null;
}

function* resolveObjectAssignAliasPropertyValue(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  expression: Expression,
  ignoredMutableCallArgumentNames: Set<string>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<ObjectAssignAliasPropertyResolution | null> {
  const expressionValue = yield* resolveObjectAssignAliasExpressionValue(
    action,
    filename,
    code,
    program,
    expression,
    ignoredMutableCallArgumentNames,
    stack,
    memo
  );
  if (expressionValue) {
    return expressionValue;
  }

  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped.type !== 'Identifier' ||
    !findExportTarget(program, unwrapped.name)
  ) {
    return null;
  }

  const resolved = yield* resolveStaticExport(
    action,
    filename,
    unwrapped.name,
    stack,
    memo
  );
  return resolved && isStaticObjectAssignAliasValue(resolved.value)
    ? {
        dependencies: resolved.dependencies,
        sideEffectDependencies: resolved.sideEffectDependencies ?? [],
        value: resolved.value,
      }
    : null;
}

function* resolveObjectAssignAliasValue(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  alias: Expression,
  ignoredMutableCallArgumentNames: Set<string>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<{
  dependencies: string[];
  sideEffectDependencies: string[];
  value: Record<string, unknown>;
} | null> {
  const aliasValue = yield* resolveObjectAssignAliasExpressionValue(
    action,
    filename,
    code,
    program,
    alias,
    ignoredMutableCallArgumentNames,
    stack,
    memo
  );
  if (aliasValue && isPlainObjectRecord(aliasValue.value)) {
    return Object.values(aliasValue.value).every(isStaticObjectAssignAliasValue)
      ? {
          dependencies: aliasValue.dependencies,
          sideEffectDependencies: aliasValue.sideEffectDependencies,
          value: aliasValue.value,
        }
      : null;
  }

  const entries = objectAssignAliasPropertyEntries(program, alias);
  if (!entries) {
    return null;
  }

  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();
  const value: Record<string, unknown> = {};

  for (const entry of entries) {
    const resolved = yield* resolveObjectAssignAliasPropertyValue(
      action,
      filename,
      code,
      program,
      entry.value,
      ignoredMutableCallArgumentNames,
      stack,
      memo
    );
    if (!resolved || !isStaticObjectAssignAliasValue(resolved.value)) {
      return null;
    }

    value[entry.key] = resolved.value;
    resolved.dependencies.forEach((item) => dependencies.add(item));
    resolved.sideEffectDependencies.forEach((item) =>
      sideEffectDependencies.add(item)
    );
  }

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    value,
  };
}

function* resolveObjectAssignAliasValues(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  aliases: Expression[],
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<ObjectAssignAliasResolution | null> {
  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();
  const values: Record<string, unknown>[] = [];
  const ignoredMutableCallArgumentNames = new Set<string>();
  aliases.forEach((alias) => {
    const name = rootIdentifierName(alias);
    if (name) {
      ignoredMutableCallArgumentNames.add(name);
    }
  });

  for (const alias of aliases) {
    const aliasValue = yield* resolveObjectAssignAliasValue(
      action,
      filename,
      code,
      program,
      alias,
      ignoredMutableCallArgumentNames,
      stack,
      memo
    );
    if (!aliasValue) {
      return null;
    }

    aliasValue.dependencies.forEach((item) => dependencies.add(item));
    aliasValue.sideEffectDependencies.forEach((item) =>
      sideEffectDependencies.add(item)
    );
    values.push(aliasValue.value);
  }

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    values,
  };
}

const isOpaqueRuntimeComponentExpression = (
  program: Program,
  expr: Node,
  opaqueImportNames: Set<string> = new Set(),
  seen: Set<string> = new Set()
): boolean => {
  const imports = collectImportBindings(program, { includeNamespace: true });
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
    unwrapped.arguments.length === 1 &&
    isKnownOpaqueRuntimeWrapperCallee(unwrapped.callee, imports)
  ) {
    const [argument] = unwrapped.arguments;
    return argument.type !== 'SpreadElement'
      ? isOpaqueRuntimeComponentExpression(
          program,
          argument,
          opaqueImportNames,
          seen
        )
      : false;
  }

  if (
    unwrapped.type === 'CallExpression' &&
    unwrapped.callee.type === 'Identifier'
  ) {
    const allowParams = unwrapped.arguments.every(
      (argument) =>
        argument.type !== 'SpreadElement' && isSafeStaticExpression(argument)
    );
    const local = findTopLevelConstExpression(program, unwrapped.callee.name);
    const returned = local
      ? functionReturnExpression(local, { allowParams })
      : null;
    return returned
      ? isOpaqueRuntimeComponentExpression(
          program,
          returned,
          opaqueImportNames,
          seen
        )
      : false;
  }

  if (unwrapped.type === 'MemberExpression' && !unwrapped.computed) {
    const name = rootIdentifierName(unwrapped);
    const imported = name ? imports.get(name) : undefined;
    return (
      !!name &&
      !!imported &&
      (opaqueImportNames.has(name) ||
        isKnownExternalRuntimeComponentImportSource(imported.source))
    );
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
      isKnownOpaqueRuntimeImportSource(imported.source) ||
      isKnownExternalRuntimeComponentImportSource(imported.source)
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
    unwrapped.callee.type === 'Identifier'
  ) {
    const allowParams = unwrapped.arguments.every(
      (argument) =>
        argument.type !== 'SpreadElement' && isSafeStaticExpression(argument)
    );
    if (seenHelpers.has(unwrapped.callee.name)) {
      return;
    }

    const local = findTopLevelConstExpression(program, unwrapped.callee.name);
    const returned = local
      ? functionReturnExpression(local, { allowParams })
      : null;
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

const replaceExpressionChildren = (
  code: string,
  expression: Expression,
  replacements: Array<{ child: Expression; replacement: string }>
): string => {
  const expressionCode = code.slice(expression.start, expression.end);
  return applyReplacements(
    expressionCode,
    replacements.map(({ child, replacement }) => ({
      end: child.end - expression.start,
      start: child.start - expression.start,
      text: replacement,
    }))
  );
};

const parseSyntheticExpression = (
  expressionCode: string,
  filename: string
): Expression | null => {
  const program = parseProgram(
    `const __wyw_static_target = ${expressionCode};`,
    filename
  );
  const declaration = program.body[0];
  if (declaration?.type !== 'VariableDeclaration') {
    return null;
  }

  const [declarator] = declaration.declarations;
  return declarator?.init ?? null;
};

const prepareProcessorTarget = (
  code: string,
  filename: string,
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  opaqueImportNames: Set<string> = new Set()
): PreparedProcessorTarget | null => {
  const ignoredMutableCallArgumentNames =
    target.localName &&
    hasOnlySafeObjectAssignCallArgumentUses(program, target.localName)
      ? new Set([target.localName])
      : undefined;
  const dependencyOptions: StaticExpressionOptions = {
    allowMetadataCalls: true,
    ignoredMutableCallArgumentNames,
  };
  const expression = resolveObjectAssignProcessorExpression(
    program,
    target.expression
  );
  const extendsExpressions = collectWYWMetaExtendsExpressions(expression);
  const opaqueExtendsExpressions = extendsExpressions.filter(
    (extendsExpression) =>
      isOpaqueRuntimeComponentExpression(
        program,
        extendsExpression,
        opaqueImportNames
      )
  );

  if (opaqueExtendsExpressions.length > 0) {
    const replacements = opaqueExtendsExpressions.map((extendsExpression) => ({
      child: extendsExpression,
      replacement: 'null',
    }));
    const expressionCode = replaceExpressionChildren(
      code,
      expression,
      replacements
    );
    const syntheticExpression = parseSyntheticExpression(
      expressionCode,
      filename
    );
    if (!syntheticExpression) {
      return null;
    }

    const dependencies = collectStaticExpressionDependencies(
      program,
      {
        ...target,
        expression: syntheticExpression,
      },
      dependencyOptions
    );

    return dependencies
      ? {
          dependencies,
          evaluationCode: applyReplacements(
            code,
            replacements.map(({ child, replacement }) => ({
              end: child.end,
              start: child.start,
              text: replacement,
            }))
          ),
          evaluationSpan: {
            end:
              expression.end +
              replacements.reduce(
                (delta, { child, replacement }) =>
                  delta + replacement.length - (child.end - child.start),
                0
              ),
            start: expression.start,
          },
          expression,
          opaqueRuntimeBase: true,
        }
      : null;
  }

  const dependencies = collectStaticExpressionDependencies(
    program,
    {
      ...target,
      expression,
    },
    dependencyOptions
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
    // Pre-resolved locals (e.g. `const x = css\`\``) have a known value
    // (the className string). Skip walking their init — its
    // TaggedTemplateExpression isn't safe-static by itself, but the
    // value is already determined.
    if (options.preResolvedLocals?.has(name)) {
      referencedNames.add(name);
      visitedLocals.add(name);
      return true;
    }

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

  const closureNames = new Set(referencedNames);
  if (target.localName) {
    closureNames.add(target.localName);
  }
  const mutationHints = collectTopLevelMutationHints(program, closureNames);
  for (const name of referencedNames) {
    if (mutationHints.mutatedNames.has(name)) {
      return null;
    }
  }

  for (const name of mutableReferencedNames) {
    if (
      mutationHints.callArgumentNames.has(name) &&
      !options.ignoredMutableCallArgumentNames?.has(name)
    ) {
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

const exportedLocalName = (
  program: Program,
  exportedName: string
): string | null => {
  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source || statement.declaration) {
        continue;
      }

      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ExportSpecifier') {
          continue;
        }

        const names = getExportSpecifierNames(specifier);
        if (names.exported === exportedName) {
          return names.local;
        }
      }
    }

    if (
      exportedName === 'default' &&
      statement.type === 'ExportDefaultDeclaration' &&
      statement.declaration.type === 'Identifier'
    ) {
      return statement.declaration.name;
    }
  }

  return null;
};

const isIdentifierNamed = (node: Node, name: string): boolean =>
  node.type === 'Identifier' && node.name === name;

const enumLiteralValue = (node: Node): number | string | null => {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type === 'Literal') {
    const { value } = unwrapped;
    return typeof value === 'string' || typeof value === 'number'
      ? value
      : null;
  }

  if (unwrapped.type === 'UnaryExpression') {
    const argument = unwrapExpression(unwrapped.argument);
    if (
      (unwrapped.operator === '-' || unwrapped.operator === '+') &&
      argument.type === 'Literal' &&
      typeof argument.value === 'number'
    ) {
      return unwrapped.operator === '-' ? -argument.value : argument.value;
    }
  }

  return null;
};

const enumMemberKey = (node: Node, computed: boolean): string | null => {
  const unwrapped = unwrapExpression(node);
  if (!computed && unwrapped.type === 'Identifier') {
    return unwrapped.name;
  }

  const value = enumLiteralValue(unwrapped);
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : null;
};

const enumSimpleAssignment = (
  node: Node,
  enumParamName: string
): { key: string; value: number | string } | null => {
  const unwrapped = unwrapExpression(node);
  if (unwrapped.type !== 'AssignmentExpression' || unwrapped.operator !== '=') {
    return null;
  }

  const left = unwrapExpression(unwrapped.left);
  if (
    left.type !== 'MemberExpression' ||
    !isIdentifierNamed(unwrapExpression(left.object), enumParamName)
  ) {
    return null;
  }

  const key = enumMemberKey(left.property, left.computed);
  const value = enumLiteralValue(unwrapped.right);
  return key !== null && value !== null ? { key, value } : null;
};

const collectEnumIifeAssignments = (
  call: Node,
  localName: string
): Record<string, number | string> | null => {
  const unwrapped = unwrapExpression(
    call.type === 'ExpressionStatement' ? call.expression : call
  );
  if (unwrapped.type !== 'CallExpression' || unwrapped.arguments.length !== 1) {
    return null;
  }

  const callee = unwrapExpression(unwrapped.callee);
  if (
    callee.type !== 'FunctionExpression' ||
    callee.async ||
    !callee.body ||
    callee.params.length !== 1 ||
    callee.params[0]?.type !== 'Identifier'
  ) {
    return null;
  }

  const enumParamName = callee.params[0].name;
  const argument = unwrapExpression(unwrapped.arguments[0]);
  if (argument.type !== 'LogicalExpression' || argument.operator !== '||') {
    return null;
  }

  const fallback = unwrapExpression(argument.right);
  if (
    !isIdentifierNamed(unwrapExpression(argument.left), localName) ||
    fallback.type !== 'AssignmentExpression' ||
    fallback.operator !== '=' ||
    !isIdentifierNamed(unwrapExpression(fallback.left), localName) ||
    unwrapExpression(fallback.right).type !== 'ObjectExpression'
  ) {
    return null;
  }

  const result: Record<string, number | string> = {};
  for (const statement of callee.body.body) {
    if (statement.type !== 'ExpressionStatement') {
      return null;
    }

    const expression = unwrapExpression(statement.expression);
    if (
      expression.type !== 'AssignmentExpression' ||
      expression.operator !== '='
    ) {
      return null;
    }

    const left = unwrapExpression(expression.left);
    if (
      left.type === 'MemberExpression' &&
      isIdentifierNamed(unwrapExpression(left.object), enumParamName)
    ) {
      const numericEnumAssignment = enumSimpleAssignment(
        left.property,
        enumParamName
      );
      const reverseValue = enumLiteralValue(expression.right);
      if (
        numericEnumAssignment &&
        typeof numericEnumAssignment.value === 'number' &&
        typeof reverseValue === 'string'
      ) {
        result[numericEnumAssignment.key] = numericEnumAssignment.value;
        result[String(numericEnumAssignment.value)] = reverseValue;
        continue;
      }
    }

    const assignment = enumSimpleAssignment(expression, enumParamName);
    if (!assignment) {
      return null;
    }

    result[assignment.key] = assignment.value;
  }

  return Object.keys(result).length > 0 ? result : null;
};

const enumIifeLocalName = (statement: Node): string | null => {
  if (statement.type !== 'ExpressionStatement') {
    return null;
  }

  const expression = unwrapExpression(statement.expression);
  if (
    expression.type !== 'CallExpression' ||
    expression.arguments.length !== 1
  ) {
    return null;
  }

  const argument = unwrapExpression(expression.arguments[0]);
  if (argument.type !== 'LogicalExpression' || argument.operator !== '||') {
    return null;
  }

  const fallback = unwrapExpression(argument.right);
  if (
    argument.left.type !== 'Identifier' ||
    fallback.type !== 'AssignmentExpression' ||
    fallback.left.type !== 'Identifier'
  ) {
    return null;
  }

  return argument.left.name === fallback.left.name ? argument.left.name : null;
};

const isEnumVarDeclaration = (
  statement: Node
): statement is VariableDeclaration =>
  statement.type === 'VariableDeclaration' &&
  statement.kind === 'var' &&
  statement.declarations.length > 0 &&
  statement.declarations.every(
    (declarator) =>
      declarator.id.type === 'Identifier' && declarator.init === null
  );

const isTypeScriptEnumOnlyModule = (program: Program): boolean =>
  program.body.every((statement) => {
    if (isEnumVarDeclaration(statement)) {
      return true;
    }

    const localName = enumIifeLocalName(statement);
    if (localName) {
      return collectEnumIifeAssignments(statement, localName) !== null;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      return statement.declaration.type === 'Identifier';
    }

    return (
      statement.type === 'ExportNamedDeclaration' &&
      !statement.source &&
      !statement.declaration &&
      statement.specifiers.every(
        (specifier) => specifier.type === 'ExportSpecifier'
      )
    );
  });

const typeScriptEnumStaticExportValue = (
  program: Program,
  exportedName: string
): Record<string, number | string> | null => {
  if (!isTypeScriptEnumOnlyModule(program)) {
    return null;
  }

  const localName = exportedLocalName(program, exportedName);
  if (!localName) {
    return null;
  }

  const hasDeclaration = program.body.some(
    (statement) =>
      isEnumVarDeclaration(statement) &&
      statement.declarations.some(
        (declarator) =>
          declarator.id.type === 'Identifier' &&
          declarator.id.name === localName
      )
  );
  if (!hasDeclaration) {
    return null;
  }

  for (const statement of program.body) {
    const enumValue = collectEnumIifeAssignments(statement, localName);
    if (enumValue) {
      return enumValue;
    }
  }

  return null;
};

const isRelativeSource = (source: string): boolean =>
  source.startsWith('./') || source.startsWith('../') || source === '.' || source === '..';

const dependencyResolutionCaches = new WeakMap<
  object,
  Map<string, IEntrypointDependency>
>();

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

  // Non-relative sources (package names, aliases) resolve deterministically
  // within a project — the same `source` always points to the same file
  // regardless of importer. Cache successful resolutions and fall back to
  // them when an individual importer's resolver call returns null. This
  // recovers from resolver-side flakiness where one importer hits a
  // negative cache while every other importer for the same source resolves
  // fine.
  if (!isRelativeSource(source)) {
    const cache = getWeakCacheMap(
      dependencyResolutionCaches,
      action.services.cache
    );
    const cacheKey = `${source}\0${imported}`;
    if (resolved?.resolved) {
      cache.set(cacheKey, resolved);
      return resolved;
    }

    const cached = cache.get(cacheKey);
    if (cached?.resolved) {
      return cached;
    }
  }

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
    callable: resolved.callable,
    dependencies: [
      dependency.resolved,
      ...resolved.dependencies.filter((item) => item !== dependency.resolved),
    ],
    sideEffectDependencies: resolved.sideEffectDependencies,
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
  if (!target) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    return null;
  }

  if (target.kind === 'import') {
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

  if (isOpaqueRuntimeComponentExpression(program, target.expression)) {
    const resolved = {
      dependencies: [filename],
      names: new Set<string>(),
    };
    memo.set(memoKey, resolved);
    stack.delete(memoKey);
    return resolved;
  }

  const imports = collectImportBindings(program, { includeNamespace: true });
  const referencedNames = new Set<string>();
  collectOpaqueRuntimeReferenceNames(
    program,
    target.expression,
    referencedNames
  );
  const opaqueImportNames = new Set<string>();
  const dependencies = new Set<string>([filename]);

  for (const name of referencedNames) {
    const binding = imports.get(name);
    if (
      !binding ||
      binding.source === 'react' ||
      isKnownOpaqueRuntimeWrapperImport(binding)
    ) {
      continue;
    }

    const proof = yield* resolveImportAsOpaqueRuntime(
      action,
      filename,
      binding,
      stack,
      memo
    );
    if (!proof) {
      continue;
    }

    opaqueImportNames.add(name);
    proof.dependencies.forEach((dependency) => dependencies.add(dependency));
  }

  const resolved = isOpaqueRuntimeComponentExpression(
    program,
    target.expression,
    opaqueImportNames
  )
    ? {
        dependencies: [...dependencies],
        names: opaqueImportNames,
      }
    : null;
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

  if (isKnownExternalRuntimeComponentImportSource(binding.source)) {
    return {
      dependencies: [],
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
  const extendsExpressions = collectWYWMetaExtendsExpressions(expression);
  if (extendsExpressions.length === 0) {
    return {
      dependencies: [],
      names: new Set(),
    };
  }

  const imports = collectImportBindings(program, { includeNamespace: true });
  const referencedNames = new Set<string>();
  extendsExpressions.forEach((extendsExpression) =>
    collectOpaqueRuntimeReferenceNames(
      program,
      extendsExpression,
      referencedNames
    )
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
  codeHash: string,
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

  const preevalResult = getStaticMetadataPreevalResult(
    action,
    filename,
    code,
    codeHash
  );
  if (!preevalResult) {
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

  const processorObjectAssignAliases = objectAssignAliasExpressionsForTarget(
    preevalProgram,
    target
  );
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
    filename,
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
  const sideEffectDependencies = new Set<string>();
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

    if (
      !bindStaticResolvedValue(
        env,
        preparedTarget.expression,
        binding.local,
        resolved,
        {
          wrapNonCallable: true,
        }
      )
    ) {
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        imported: binding.imported,
        phase: 'processor-metadata',
        reason: 'callable-usage-unsupported',
        source: binding.source,
        status: 'rejected',
      });
      return null;
    }

    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
    resolved.sideEffectDependencies?.forEach((dependency) =>
      sideEffectDependencies.add(dependency)
    );
  }

  const value =
    preparedTarget.evaluationCode && preparedTarget.evaluationSpan
      ? evaluateOxcStaticExpressionAt(
          preparedTarget.evaluationCode,
          filename,
          preparedTarget.evaluationSpan,
          env,
          getStaticBindings(action)
        )
      : evaluateOxcStaticExpressionAt(
          preevalCode,
          filename,
          {
            end: preparedTarget.expression.end,
            start: preparedTarget.expression.start,
          },
          env,
          getStaticBindings(action)
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

  let resolvedValue = value;
  if (processorObjectAssignAliases && isStaticWYWMetaValue(value)) {
    const aliasValues = yield* resolveObjectAssignAliasValues(
      action,
      filename,
      preevalCode,
      preevalProgram,
      processorObjectAssignAliases,
      stack,
      memo
    );
    const mergedValue = aliasValues
      ? mergeStaticObjectAssignAliases(value, aliasValues.values)
      : null;

    if (mergedValue) {
      resolvedValue = mergedValue;
      aliasValues?.dependencies.forEach((dependency) =>
        dependencies.add(dependency)
      );
      aliasValues?.sideEffectDependencies.forEach((dependency) =>
        sideEffectDependencies.add(dependency)
      );
    }
  }

  const isStaticMeta = isStaticWYWMetaValue(resolvedValue);
  const isStaticMetaTree =
    !isStaticMeta && isStaticWYWMetaTreeValue(resolvedValue);
  const processors = preevalResult.metadata
    .processors as unknown as StaticProcessorInstance[];
  const isSelectorOnly =
    !isStaticMeta &&
    !isStaticMetaTree &&
    isSelectorOnlyProcessorValue(resolvedValue, processors, new Map());
  const isSideEffectClassValue =
    !isStaticMeta &&
    !isStaticMetaTree &&
    !isSelectorOnly &&
    isProcessorClassValue(resolvedValue, processors, new Map());
  if (
    !isStaticMeta &&
    !isStaticMetaTree &&
    !isSelectorOnly &&
    !isSideEffectClassValue
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

  let resolvedReason: string | undefined;
  if (preparedTarget.opaqueRuntimeBase) {
    resolvedReason = 'opaque-runtime-component';
  } else if (isSideEffectClassValue) {
    resolvedReason = 'non-empty-css-artifact-side-effect';
  }

  debugStaticResolve(action, {
    exported: exportedName,
    filename,
    phase: 'processor-metadata',
    reason: resolvedReason,
    status: 'resolved',
  });

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: isSideEffectClassValue
      ? [filename, ...sideEffectDependencies]
      : [...sideEffectDependencies],
    value: resolvedValue,
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
  const objectAssignAliases = objectAssignAliasExpressionsForTarget(
    program,
    target
  );
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

      const dependencies = new Set([
        filename,
        ...resolved.dependencies.filter((item) => item !== filename),
      ]);
      const sideEffectDependencies = new Set(
        resolved.sideEffectDependencies ?? []
      );
      const aliasValues = objectAssignAliases
        ? yield* resolveObjectAssignAliasValues(
            action,
            filename,
            code,
            program,
            objectAssignAliases,
            stack,
            memo
          )
        : null;
      const mergedValue = aliasValues
        ? mergeStaticObjectAssignAliases(resolved.value, aliasValues.values)
        : null;
      aliasValues?.dependencies.forEach((item) => dependencies.add(item));
      aliasValues?.sideEffectDependencies.forEach((item) =>
        sideEffectDependencies.add(item)
      );

      return {
        dependencies: [...dependencies],
        sideEffectDependencies: [...sideEffectDependencies],
        value: mergedValue ?? resolved.value,
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
  const sideEffectDependencies = new Set<string>();

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

    if (!bindStaticResolvedValue(env, expression, binding.local, resolved)) {
      return null;
    }

    resolved.dependencies.forEach((item) => dependencies.add(item));
    resolved.sideEffectDependencies?.forEach((item) =>
      sideEffectDependencies.add(item)
    );
  }

  const value = evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: expression.end,
      start: expression.start,
    },
    env,
    getStaticBindings(action)
  );
  if (!isStaticWYWMetaValue(value)) {
    return null;
  }

  const aliasValues = objectAssignAliases
    ? yield* resolveObjectAssignAliasValues(
        action,
        filename,
        code,
        program,
        objectAssignAliases,
        stack,
        memo
      )
    : null;
  const mergedValue = aliasValues
    ? mergeStaticObjectAssignAliases(value, aliasValues.values)
    : null;
  aliasValues?.dependencies.forEach((item) => dependencies.add(item));
  aliasValues?.sideEffectDependencies.forEach((item) =>
    sideEffectDependencies.add(item)
  );

  return {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    value: mergedValue ?? value,
  };
}

const zeroArgFunctionReturnExpression = (
  expression: Expression
): Expression | null => {
  const unwrapped = unwrapExpression(expression);
  if (
    unwrapped.type !== 'ArrowFunctionExpression' &&
    unwrapped.type !== 'FunctionExpression'
  ) {
    return null;
  }

  if (unwrapped.async || unwrapped.params.length !== 0 || !unwrapped.body) {
    return null;
  }

  if (unwrapped.body.type !== 'BlockStatement') {
    return unwrapped.body as Expression;
  }

  if (unwrapped.body.body.length !== 1) {
    return null;
  }

  const [statement] = unwrapped.body.body;
  return statement?.type === 'ReturnStatement' && statement.argument
    ? statement.argument
    : null;
};

function* resolveZeroArgFunctionStaticExport(
  action: ITransformAction,
  filename: string,
  code: string,
  program: Program,
  target: Extract<ExportTarget, { kind: 'expression' }>,
  stack: Set<string>,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<StaticExportResult | null> {
  const returnExpression = zeroArgFunctionReturnExpression(target.expression);
  if (!returnExpression) {
    return null;
  }

  const staticDependencies = collectStaticExpressionDependencies(
    program,
    {
      ...target,
      expression: returnExpression,
    },
    { allowMetadataCalls: true }
  );
  if (!staticDependencies) {
    return null;
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);
  const sideEffectDependencies = new Set<string>();

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

    if (
      !bindStaticResolvedValue(env, returnExpression, binding.local, resolved)
    ) {
      return null;
    }

    resolved.dependencies.forEach((item) => dependencies.add(item));
    resolved.sideEffectDependencies?.forEach((item) =>
      sideEffectDependencies.add(item)
    );
  }

  const value = evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: returnExpression.end,
      start: returnExpression.start,
    },
    env,
    getStaticBindings(action)
  );
  return isOxcStaticSerializableValue(value)
    ? {
        callable: 'zero-arg',
        dependencies: [...dependencies],
        sideEffectDependencies: [...sideEffectDependencies],
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

  const analysis = getStaticFileAnalysis(action, filename);
  if (!analysis) {
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

  const { code, codeHash, program } = analysis;
  const finish = (
    result: StaticExportResult | null
  ): StaticExportResult | null => {
    memo.set(memoKey, result);
    stack.delete(memoKey);
    setStaticExportCachedResult(
      action,
      filename,
      exportedName,
      codeHash,
      result
    );
    return result;
  };

  const cachedResult = getStaticExportCachedResult(
    action,
    filename,
    exportedName,
    codeHash
  );
  if (cachedResult !== undefined) {
    memo.set(memoKey, cachedResult);
    stack.delete(memoKey);
    return cachedResult;
  }

  const enumValue = typeScriptEnumStaticExportValue(program, exportedName);
  if (enumValue) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'typescript-enum',
      status: 'resolved',
    });
    return finish({
      dependencies: [filename],
      value: enumValue,
    });
  }

  const target = findExportTarget(program, exportedName);
  if (!target) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'no-export-target',
      status: 'rejected',
    });
    return finish(null);
  }

  if (target.kind === 'import') {
    const resolved = yield* resolveImportValue(
      action,
      filename,
      target,
      stack,
      memo
    );
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      imported: target.imported,
      phase: 'export',
      reason: resolved ? undefined : 'resolve-failed',
      source: target.source,
      status: resolved ? 'resolved' : 'rejected',
    });
    return finish(resolved);
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
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'object-assign',
      status: 'resolved',
    });
    return finish(objectAssignResult);
  }

  const zeroArgFunctionResult = yield* resolveZeroArgFunctionStaticExport(
    action,
    filename,
    code,
    program,
    target,
    stack,
    memo
  );
  if (zeroArgFunctionResult) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'zero-arg-function',
      status: 'resolved',
    });
    return finish(zeroArgFunctionResult);
  }

  // Pre-fetch the source file's preeval result so processor className
  // bindings (`const x = css\`\``) can short-circuit dependency walks
  // and seed the evaluator's env. The TaggedTemplateExpression init
  // isn't safe-static by itself; the className IS.
  const sourcePreevalForExpression = getStaticMetadataPreevalResult(
    action,
    filename,
    code,
    codeHash
  );
  const preResolvedLocals = sourcePreevalForExpression?.processorClassNames
    ? new Set(Object.keys(sourcePreevalForExpression.processorClassNames))
    : undefined;

  const staticDependencies = collectStaticExpressionDependencies(
    program,
    target,
    preResolvedLocals ? { preResolvedLocals } : {}
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
      codeHash,
      program,
      exportedName,
      stack,
      memo
    );
    if (metadataResult) {
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        phase: 'export',
        status: 'resolved',
      });
      return finish(metadataResult);
    }

    // Fallback: the metadata path rejected (e.g. non-empty-css-artifact
    // when the css\`\` template has interpolations the source-preeval
    // can't fold). The processor still computed a className for this
    // binding during applyOxcProcessors; surface it as the export's
    // value. Keep the source file in sideEffectDependencies so its CSS
    // registers at runtime.
    //
    // Two shapes resolve here:
    //   export const x = css\`...\`         (TaggedTemplateExpression init)
    //   export const x = sameFileCssConst   (Identifier alias)
    const lookupName =
      target.expression.type === 'TaggedTemplateExpression'
        ? target.localName ?? null
        : target.expression.type === 'Identifier'
        ? target.expression.name
        : null;
    if (lookupName) {
      const sourcePreeval = getStaticMetadataPreevalResult(
        action,
        filename,
        code,
        codeHash
      );
      const className = sourcePreeval?.processorClassNames[lookupName];
      if (className) {
        debugStaticResolve(action, {
          exported: exportedName,
          filename,
          phase: 'export',
          reason: 'processor-class-name',
          status: 'resolved',
        });
        return finish({
          dependencies: [filename],
          sideEffectDependencies: [filename],
          value: className,
        });
      }
    }

    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'resolve-failed',
      status: 'rejected',
    });
    return finish(null);
  }

  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);
  const sideEffectDependencies = new Set<string>();

  for (const binding of staticDependencies.imports) {
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
        phase: 'export',
        reason: 'resolve-failed',
        source: binding.source,
        status: 'rejected',
      });
      return finish(null);
    }

    if (
      !bindStaticResolvedValue(env, target.expression, binding.local, resolved)
    ) {
      debugStaticResolve(action, {
        exported: exportedName,
        filename,
        imported: binding.imported,
        phase: 'export',
        reason: 'callable-usage-unsupported',
        source: binding.source,
        status: 'rejected',
      });
      return finish(null);
    }

    resolved.dependencies.forEach((item) => dependencies.add(item));
    resolved.sideEffectDependencies?.forEach((item) =>
      sideEffectDependencies.add(item)
    );
  }

  // Seed env with the source file's selector-only processor class names
  // so expressions like `baseClassName + ' ' + hoverClassName` can fold
  // — `baseClassName`'s init is a TaggedTemplateExpression the evaluator
  // can't unfold by walking the AST, but its className is already known
  // from applyOxcProcessors.
  if (sourcePreevalForExpression?.processorClassNames) {
    for (const [name, className] of Object.entries(
      sourcePreevalForExpression.processorClassNames
    )) {
      if (!env.has(name)) {
        env.set(name, className);
      }
    }
  }

  const value = evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: target.expression.end,
      start: target.expression.start,
    },
    env,
    getStaticBindings(action)
  );
  if (!isOxcStaticSerializableValue(value)) {
    debugStaticResolve(action, {
      exported: exportedName,
      filename,
      phase: 'export',
      reason: 'non-serializable',
      status: 'rejected',
    });
    return finish(null);
  }

  const result = {
    dependencies: [...dependencies],
    sideEffectDependencies: [...sideEffectDependencies],
    value,
  };
  debugStaticResolve(action, {
    exported: exportedName,
    filename,
    phase: 'export',
    status: 'resolved',
  });
  return finish(result);
}

function* resolveCandidateValue(
  action: ITransformAction,
  candidate: OxcStaticValueCandidate,
  filename: string,
  memo: Map<string, StaticExportResult | null>
): SyncScenarioFor<StaticExportResult | null> {
  const env = new Map<string, unknown>();
  const dependencies = new Set<string>();
  const sideEffectDependencies = new Set<string>();
  const sideEffectImportLocals = new Set<string>();
  let candidateExpression: Expression | null | undefined;

  if (candidate.inlineConstants) {
    for (const [name, value] of Object.entries(candidate.inlineConstants)) {
      env.set(name, value);
    }
  }

  const staticBindingsForCandidate = getStaticBindings(action);

  for (const item of candidate.imports) {
    // staticBindings overrides take precedence over actual import
    // resolution: a registered value (or function) replaces whatever
    // the source module would otherwise provide. Useful for prototyping
    // / SSR theming and for opaque utilities like `cx`.
    const override = lookupStaticBinding(
      staticBindingsForCandidate,
      item.source,
      item.imported
    );
    if (override.found) {
      env.set(item.local, override.value);
      continue;
    }

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

    if (resolved.callable === 'zero-arg' && candidateExpression === undefined) {
      candidateExpression = parseStaticExpressionSource(
        candidate.source,
        filename
      );
    }

    const expressionForBinding =
      resolved.callable === 'zero-arg' ? candidateExpression : null;
    if (
      (resolved.callable === 'zero-arg' && !expressionForBinding) ||
      (expressionForBinding &&
        !bindStaticResolvedValue(
          env,
          expressionForBinding,
          item.local,
          resolved
        ))
    ) {
      debugStaticResolve(action, {
        candidate: candidate.name,
        filename,
        imported: item.imported,
        phase: 'candidate',
        reason: 'candidate-callable-usage-unsupported',
        source: item.source,
        status: 'rejected',
      });
      return null;
    }

    if (!expressionForBinding) {
      env.set(item.local, resolved.value);
    }

    resolved.dependencies.forEach((dependency) => dependencies.add(dependency));
    resolved.sideEffectDependencies?.forEach((dependency) => {
      sideEffectDependencies.add(dependency);
      sideEffectImportLocals.add(item.importLocal ?? item.local);
    });
  }

  const value = evaluateOxcStaticExpression(
    candidate.source,
    filename,
    env,
    getStaticBindings(action)
  );
  // Function-valued candidates are runtime callbacks (e.g. styled-
  // component dynamic prop interpolations like `${props => ...}`). The
  // value isn't serializable, but the candidate IS resolved — the
  // local `_exp = () => target` arrow already lives in the bundle, so
  // the file does not need evalFile to compute it. Mark the result as
  // runtimeOnly so the helper declaration survives pruning.
  if (typeof value === 'function') {
    debugStaticResolve(action, {
      candidate: candidate.name,
      filename,
      phase: 'candidate',
      reason: 'runtime-callback',
      status: 'resolved',
    });
    return {
      dependencies: [...dependencies],
      runtimeOnly: true,
      sideEffectDependencies: [...sideEffectDependencies],
      sideEffectImportLocals: [...sideEffectImportLocals],
      value,
    };
  }

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
    sideEffectDependencies: [...sideEffectDependencies],
    sideEffectImportLocals: [...sideEffectImportLocals],
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
  const sideEffectImportLocals = new Set<string>();
  const staticNullWYWMetaExtendsHelpers = new Set(
    preevalResult.staticNullWYWMetaExtendsHelpers ?? []
  );
  const memo = new Map<string, StaticExportResult | null>();
  const opaqueRuntimeBaseHelpers = collectWYWMetaExtendsHelperNames(
    parseProgram(preevalResult.baseCode ?? preevalResult.code, filename)
  );
  const evalDependencyNames = new Set(preevalResult.dependencyNames ?? []);
  // Names of candidates resolved to runtime callbacks (function values).
  // They keep the file out of evalFile but their helper declarations must
  // not be pruned — the runtime call site relies on them.
  const runtimeOnlyCandidateNames = new Set<string>();
  let changed = false;
  let hasKnownStaticCandidate = false;

  for (const candidate of candidates) {
    const isOpaqueRuntimeBaseHelper = opaqueRuntimeBaseHelpers.has(
      candidate.name
    );
    if (
      !evalDependencyNames.has(candidate.name) &&
      !isOpaqueRuntimeBaseHelper &&
      !staticValueCache.has(candidate.name)
    ) {
      debugStaticResolve(this, {
        candidate: candidate.name,
        filename,
        phase: 'candidate',
        reason: 'not-eval-dependency',
        status: 'skipped',
      });
      continue;
    }

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

    if (resolved.runtimeOnly) {
      // Runtime callback — don't seed staticValueCache (which gates
      // pruning of the `_exp = () => target` helper). Track separately
      // so dependencyNames still gets filtered and evalFile is skipped.
      runtimeOnlyCandidateNames.add(candidate.name);
    } else {
      staticValueCache.set(candidate.name, resolved.value);
    }
    hasKnownStaticCandidate = true;
    candidate.imports.forEach((item) =>
      staticImportLocals.add(item.importLocal ?? item.local)
    );
    resolved.dependencies.forEach((dependency) =>
      staticDependencies.add(dependency)
    );
    resolved.sideEffectImportLocals?.forEach((local) =>
      sideEffectImportLocals.add(local)
    );
    changed = true;
  }

  if (
    !changed &&
    (!hasKnownStaticCandidate || preevalResult.staticValuesApplied)
  ) {
    return false;
  }

  const dependencyNames = (preevalResult.dependencyNames ?? []).filter(
    (name) =>
      !staticValueCache.has(name) && !runtimeOnlyCandidateNames.has(name)
  );
  preevalResult.dependencyNames = dependencyNames;
  preevalResult.staticValueCache = staticValueCache;
  preevalResult.staticDependencies = [...staticDependencies];
  preevalResult.staticNullWYWMetaExtendsHelpers = [
    ...staticNullWYWMetaExtendsHelpers,
  ];
  preevalResult.staticValuesApplied = true;
  const originalBaseCode = preevalResult.baseCode ?? preevalResult.code;
  const staticExtendsHelperValues = new Map(staticValueCache);
  staticNullWYWMetaExtendsHelpers.forEach((name) => {
    if (!staticExtendsHelperValues.has(name)) {
      staticExtendsHelperValues.set(name, null);
    }
  });
  const baseCode = pruneStaticPreevalCode(
    originalBaseCode,
    filename,
    new Set(staticValueCache.keys()),
    staticImportLocals,
    staticExtendsHelperValues,
    sideEffectImportLocals
  );
  const evalBaseCode =
    sideEffectImportLocals.size > 0
      ? pruneStaticPreevalCode(
          originalBaseCode,
          filename,
          new Set(staticValueCache.keys()),
          staticImportLocals,
          staticExtendsHelperValues,
          new Set()
        )
      : baseCode;
  preevalResult.baseCode = baseCode;
  preevalResult.code = appendOxcWywPreval(baseCode, filename, dependencyNames);
  preevalResult.evalCode = appendOxcWywPreval(
    evalBaseCode,
    filename,
    dependencyNames
  );
  preevalResult.staticSideEffectImportLocals = [...sideEffectImportLocals];

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
