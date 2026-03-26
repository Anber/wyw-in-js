/* eslint-disable no-continue, @typescript-eslint/no-use-before-define, @typescript-eslint/no-explicit-any, no-param-reassign, prefer-destructuring */
import generate from '@babel/generator';
import * as t from '@babel/types';

import { EventEmitter } from '../../utils/EventEmitter';
import { shaker } from '../../shaker';
import { TransformCacheCollection } from '../../cache';
import { Entrypoint } from '../Entrypoint';
import {
  analyzeBarrelFile,
  type BarrelBlockedReason,
  type BarrelManifest,
  type BarrelManifestCacheEntry,
  type BarrelManifestExport,
  type BarrelResolvedBinding,
  type RawBarrelManifest,
} from '../barrelManifest';
import type { IEntrypointDependency } from '../Entrypoint.types';
import type { Services, ITransformAction } from '../types';

type RewriteResult = {
  ast: t.File;
  code: string;
  imports: Map<string, string[]> | null;
  optimizedCount: number;
  optimizedSources: string[];
  skippedCount: number;
};

type ResolvedDependencyMap = Map<string, IEntrypointDependency>;

type StarCandidate = {
  binding: BarrelResolvedBinding;
  exported: string;
};

type RewrittenImportSpecifier =
  | {
      kind: 'default';
      local: t.Identifier;
      source: string;
    }
  | {
      imported: string;
      kind: 'named';
      local: t.Identifier;
      source: string;
    };

type RewrittenExportSpecifier =
  | {
      exported: string;
      imported: string;
      kind: 'named';
      source: string;
    }
  | {
      exported: string;
      kind: 'namespace';
      source: string;
    };

type IneligibleBarrelEntry = Exclude<BarrelManifestCacheEntry, BarrelManifest>;

const createAnalysisServices = (services: Services): Services => ({
  ...services,
  cache: new TransformCacheCollection({
    barrelManifests: services.cache.barrelManifests,
    exports: services.cache.exports,
  }),
  eventEmitter: EventEmitter.dummy,
});

const addBinding = (
  manifest: Record<string, BarrelManifestExport>,
  exported: string,
  binding: BarrelResolvedBinding,
  explicitExports: Set<string>
) => {
  const existing = manifest[exported];
  if (explicitExports.has(exported)) {
    return;
  }

  if (!existing) {
    manifest[exported] = binding;
    return;
  }

  if (existing.kind === 'blocked') {
    return;
  }

  if (!isSameBinding(existing, binding)) {
    manifest[exported] = {
      kind: 'blocked',
      reason: 'ambiguous',
    };
  }
};

const addBlockedExport = (
  manifest: Record<string, BarrelManifestExport>,
  exported: string,
  reason: BarrelBlockedReason
) => {
  manifest[exported] = {
    kind: 'blocked',
    reason,
  };
};

const buildResolvedDependencyMap = (
  resolvedImports: IEntrypointDependency[]
): ResolvedDependencyMap =>
  new Map(resolvedImports.map((dependency) => [dependency.source, dependency]));

const cloneExportedName = (name: string): t.Identifier | t.StringLiteral =>
  t.isValidIdentifier(name) ? t.identifier(name) : t.stringLiteral(name);

const cloneImportedName = (name: string): t.Identifier | t.StringLiteral =>
  name === 'default' || t.isValidIdentifier(name)
    ? t.identifier(name)
    : t.stringLiteral(name);

const isSameBinding = (
  left: BarrelResolvedBinding,
  right: BarrelResolvedBinding
): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.source !== right.source) {
    return false;
  }

  if (left.kind === 'named' && right.kind === 'named') {
    return left.imported === right.imported;
  }

  return true;
};

function createAnalysisEntrypoint(
  services: Services,
  filename: string,
  loadedCode?: string
): Entrypoint {
  return Entrypoint.createRoot(services, filename, ['*'], loadedCode);
}

function getUniqueSources(raw: RawBarrelManifest): string[] {
  return Array.from(
    new Set([
      ...raw.reexports.map((reexport) => reexport.source),
      ...raw.exportAll,
    ])
  );
}

function buildImportsForResolve(raw: RawBarrelManifest): Map<string, string[]> {
  return new Map(getUniqueSources(raw).map((source) => [source, []]));
}

function getReexportResolutionMap(
  resolvedImports: IEntrypointDependency[]
): Map<string, string | null> {
  return new Map(
    resolvedImports.map((dependency) => [
      dependency.source,
      dependency.resolved,
    ])
  );
}

function isBarrelEntry(
  entry: BarrelManifestCacheEntry
): entry is BarrelManifest {
  return entry.kind === 'barrel';
}

function isRawBarrelManifest(
  entry: BarrelManifestCacheEntry | RawBarrelManifest
): entry is RawBarrelManifest {
  return 'reexports' in entry;
}

function shouldUseDirectExports(
  reason: IneligibleBarrelEntry['reason']
): boolean {
  return reason === 'impure';
}

const getModuleName = (node: t.Identifier | t.StringLiteral): string =>
  t.isIdentifier(node) ? node.name : node.value;

const canEmitNamedReexport = (imported: string): boolean =>
  imported === 'default' || t.isValidIdentifier(imported);

function collectOptimizedImports(ast: t.File): Map<string, string[]> {
  const imports = new Map<string, string[]>();

  const addImport = (source: string, imported: string) => {
    if (!imports.has(source)) {
      imports.set(source, []);
    }

    if (!imports.get(source)!.includes(imported)) {
      imports.get(source)!.push(imported);
    }
  };

  const program = ast.program;
  for (const statement of program.body) {
    if (
      t.isImportDeclaration(statement) &&
      t.isStringLiteral(statement.source)
    ) {
      if (statement.specifiers.length === 0) {
        addImport(statement.source.value, 'side-effect');
        continue;
      }

      for (const specifier of statement.specifiers) {
        if (t.isImportDefaultSpecifier(specifier)) {
          addImport(statement.source.value, 'default');
          continue;
        }

        if (t.isImportNamespaceSpecifier(specifier)) {
          addImport(statement.source.value, '*');
          continue;
        }

        if (t.isImportSpecifier(specifier)) {
          addImport(
            statement.source.value,
            t.isIdentifier(specifier.imported)
              ? specifier.imported.name
              : specifier.imported.value
          );
        }
      }
      continue;
    }

    if (
      t.isExportNamedDeclaration(statement) &&
      statement.source &&
      t.isStringLiteral(statement.source)
    ) {
      for (const specifier of statement.specifiers) {
        if (t.isExportNamespaceSpecifier(specifier)) {
          addImport(statement.source.value, '*');
          continue;
        }

        if (t.isExportDefaultSpecifier(specifier)) {
          addImport(statement.source.value, 'default');
          continue;
        }

        if (t.isExportSpecifier(specifier)) {
          addImport(statement.source.value, getModuleName(specifier.local));
        }
      }
      continue;
    }

    if (
      t.isExportAllDeclaration(statement) &&
      statement.source &&
      t.isStringLiteral(statement.source)
    ) {
      addImport(statement.source.value, '*');
    }
  }

  return imports;
}

function groupImportSpecifiers(
  optimized: RewrittenImportSpecifier[]
): t.ImportDeclaration[] {
  const grouped = new Map<
    string,
    {
      defaults: t.ImportDefaultSpecifier[];
      named: t.ImportSpecifier[];
    }
  >();

  for (const specifier of optimized) {
    if (!grouped.has(specifier.source)) {
      grouped.set(specifier.source, {
        defaults: [],
        named: [],
      });
    }

    const bucket = grouped.get(specifier.source)!;
    if (specifier.kind === 'default') {
      bucket.defaults.push(t.importDefaultSpecifier(specifier.local));
      continue;
    }

    bucket.named.push(
      t.importSpecifier(specifier.local, cloneImportedName(specifier.imported))
    );
  }

  const declarations: t.ImportDeclaration[] = [];
  for (const [source, bucket] of grouped) {
    if (bucket.defaults.length === 0) {
      declarations.push(
        t.importDeclaration(bucket.named, t.stringLiteral(source))
      );
      continue;
    }

    declarations.push(
      t.importDeclaration(
        [bucket.defaults[0], ...bucket.named],
        t.stringLiteral(source)
      )
    );

    for (const defaultSpecifier of bucket.defaults.slice(1)) {
      declarations.push(
        t.importDeclaration([defaultSpecifier], t.stringLiteral(source))
      );
    }
  }

  return declarations;
}

function groupExportSpecifiers(
  optimized: RewrittenExportSpecifier[]
): t.Statement[] {
  const grouped = new Map<
    string,
    Array<t.ExportSpecifier | t.ExportNamespaceSpecifier>
  >();

  for (const specifier of optimized) {
    if (!grouped.has(specifier.source)) {
      grouped.set(specifier.source, []);
    }

    if (specifier.kind === 'namespace') {
      grouped
        .get(specifier.source)!
        .push(t.exportNamespaceSpecifier(t.identifier(specifier.exported)));
      continue;
    }

    grouped
      .get(specifier.source)!
      .push(
        t.exportSpecifier(
          t.identifier(specifier.imported),
          cloneExportedName(specifier.exported)
        )
      );
  }

  return Array.from(grouped.entries()).map(([source, specifiers]) =>
    t.exportNamedDeclaration(null, specifiers, t.stringLiteral(source))
  );
}

function createImportFallback(
  statement: t.ImportDeclaration,
  fallbackSpecifiers: t.ImportDeclaration['specifiers']
): t.ImportDeclaration | null {
  if (fallbackSpecifiers.length === 0) {
    return null;
  }

  return t.importDeclaration(
    fallbackSpecifiers,
    t.stringLiteral(statement.source.value)
  );
}

function createExportFallback(
  statement: t.ExportNamedDeclaration,
  fallbackSpecifiers: t.ExportNamedDeclaration['specifiers']
): t.ExportNamedDeclaration | null {
  if (!statement.source || fallbackSpecifiers.length === 0) {
    return null;
  }

  return t.exportNamedDeclaration(
    null,
    fallbackSpecifiers,
    t.stringLiteral(statement.source.value)
  );
}

function emitRewriteSkipped(
  action: ITransformAction,
  source: string,
  reason: BarrelBlockedReason
) {
  action.services.eventEmitter.single({
    file: action.entrypoint.name,
    kind: 'barrelRewriteSkipped',
    reason,
    source,
  });
}

function getManifestExport(
  manifest: BarrelManifest,
  exported: string
): BarrelManifestExport | null {
  return manifest.exports[exported] ?? null;
}

function* getNamedBinding(
  this: ITransformAction,
  analysisServices: Services,
  targetResolved: string,
  imported: string,
  stack: Set<string>
): Generator<any, BarrelManifestExport, any> {
  if (stack.has(targetResolved)) {
    return {
      kind: 'blocked',
      reason: 'cycle',
    };
  }

  const targetManifest = yield* getOrBuildBarrelManifest.call(
    this,
    analysisServices,
    targetResolved,
    stack
  );

  if (isBarrelEntry(targetManifest)) {
    const resolved = getManifestExport(targetManifest, imported);
    if (resolved) {
      return resolved;
    }

    return {
      kind: 'blocked',
      reason: targetManifest.complete ? 'unresolved' : 'unknown-star',
    };
  }

  return {
    kind: 'named',
    imported,
    source: targetResolved,
  };
}

function* getStarCandidates(
  this: ITransformAction,
  analysisServices: Services,
  targetResolved: string,
  stack: Set<string>
): Generator<any, { candidates: StarCandidate[]; complete: boolean }, any> {
  if (stack.has(targetResolved)) {
    return {
      candidates: [],
      complete: false,
    };
  }

  const targetManifest = yield* getOrBuildBarrelManifest.call(
    this,
    analysisServices,
    targetResolved,
    stack
  );

  if (isBarrelEntry(targetManifest)) {
    if (!targetManifest.complete) {
      return {
        candidates: [],
        complete: false,
      };
    }

    return {
      candidates: Object.entries(targetManifest.exports)
        .filter(
          ([exported, binding]) =>
            exported !== 'default' && binding.kind !== 'blocked'
        )
        .map(([exported, binding]) => ({
          binding: binding as BarrelResolvedBinding,
          exported,
        })),
      complete: true,
    };
  }

  if (!shouldUseDirectExports(targetManifest.reason)) {
    return {
      candidates: [],
      complete: false,
    };
  }

  const exports = yield* getExportsForFile.call(
    this,
    analysisServices,
    targetResolved
  );

  return {
    candidates: exports
      .filter((exported) => exported !== 'default')
      .map((exported) => ({
        binding: {
          kind: 'named',
          imported: exported,
          source: targetResolved,
        } satisfies BarrelResolvedBinding,
        exported,
      })),
    complete: true,
  };
}

function* getExportsForFile(
  this: ITransformAction,
  services: Services,
  filename: string
): Generator<any, string[], any> {
  const entrypoint = createAnalysisEntrypoint(services, filename);
  return yield* this.getNext('getExports', entrypoint, undefined, null);
}

function* getOrBuildBarrelManifest(
  this: ITransformAction,
  analysisServices: Services,
  filename: string,
  stack: Set<string> = new Set()
): Generator<any, BarrelManifestCacheEntry, any> {
  const cached = this.services.cache.get('barrelManifests', filename);
  if (cached) {
    this.services.eventEmitter.single({
      file: filename,
      kind: 'barrelManifest',
      status: 'hit',
    });
    return cached;
  }

  const loadedAndParsed = analysisServices.loadAndParseFn(
    analysisServices,
    filename,
    undefined,
    analysisServices.log
  );

  if (loadedAndParsed.evaluator === 'ignored') {
    const ignoredEntry = {
      kind: 'ineligible',
      reason: 'ignored',
    } as const;
    this.services.cache.add('barrelManifests', filename, ignoredEntry);
    return ignoredEntry;
  }

  if (loadedAndParsed.evaluator !== shaker) {
    const customEntry = {
      kind: 'ineligible',
      reason: 'custom-evaluator',
    } as const;
    this.services.cache.add('barrelManifests', filename, customEntry);
    return customEntry;
  }

  const analyzed = analyzeBarrelFile(loadedAndParsed.ast);
  if (!isRawBarrelManifest(analyzed)) {
    this.services.cache.add('barrelManifests', filename, analyzed);
    return analyzed;
  }

  const resolveEntrypoint = createAnalysisEntrypoint(
    analysisServices,
    filename,
    loadedAndParsed.code
  );
  const resolvedImports = yield* this.getNext(
    'resolveImports',
    resolveEntrypoint,
    {
      imports: buildImportsForResolve(analyzed),
    },
    null
  );

  const resolutionMap = getReexportResolutionMap(resolvedImports);
  const manifest: BarrelManifest = {
    complete: analyzed.complete,
    exports: {},
    kind: 'barrel',
  };
  const explicitExports = new Set<string>(analyzed.explicitExports);
  const nextStack = new Set(stack);
  nextStack.add(filename);

  for (const reexport of analyzed.reexports) {
    explicitExports.add(reexport.exported);
    const targetResolved = resolutionMap.get(reexport.source);

    if (!targetResolved) {
      manifest.complete = false;
      addBlockedExport(manifest.exports, reexport.exported, 'unresolved');
      continue;
    }

    if (reexport.kind === 'namespace') {
      const namespaceBinding = yield* getNamespaceBinding.call(
        this,
        analysisServices,
        targetResolved,
        nextStack
      );
      manifest.exports[reexport.exported] = namespaceBinding;
      if (namespaceBinding.kind === 'blocked') {
        manifest.complete = false;
      }
      continue;
    }

    const binding = yield* getNamedBinding.call(
      this,
      analysisServices,
      targetResolved,
      reexport.imported,
      nextStack
    );
    manifest.exports[reexport.exported] = binding;
    if (binding.kind === 'blocked') {
      manifest.complete = false;
    }
  }

  for (const exportAllSource of analyzed.exportAll) {
    const targetResolved = resolutionMap.get(exportAllSource);
    if (!targetResolved) {
      manifest.complete = false;
      continue;
    }

    const { candidates, complete } = yield* getStarCandidates.call(
      this,
      analysisServices,
      targetResolved,
      nextStack
    );

    if (!complete) {
      manifest.complete = false;
      continue;
    }

    for (const candidate of candidates) {
      addBinding(
        manifest.exports,
        candidate.exported,
        candidate.binding,
        explicitExports
      );
    }
  }

  this.services.cache.add('barrelManifests', filename, manifest);
  this.services.eventEmitter.single({
    complete: manifest.complete,
    file: filename,
    kind: 'barrelManifest',
    status: 'built',
  });

  return manifest;
}

function* getNamespaceBinding(
  this: ITransformAction,
  analysisServices: Services,
  targetResolved: string,
  stack: Set<string>
): Generator<any, BarrelManifestExport, any> {
  if (stack.has(targetResolved)) {
    return {
      kind: 'blocked',
      reason: 'cycle',
    };
  }

  const targetManifest = yield* getOrBuildBarrelManifest.call(
    this,
    analysisServices,
    targetResolved,
    stack
  );

  if (isBarrelEntry(targetManifest)) {
    return {
      kind: 'blocked',
      reason: 'namespace-barrel',
    };
  }

  return {
    kind: 'namespace',
    source: targetResolved,
  };
}

function getResolvedDependency(
  dependencies: ResolvedDependencyMap,
  source: string
): IEntrypointDependency | undefined {
  return dependencies.get(source);
}

function* rewriteImportDeclaration(
  this: ITransformAction,
  analysisServices: Services,
  statement: t.ImportDeclaration,
  dependencies: ResolvedDependencyMap
): Generator<any, t.Statement[], any> {
  const dependency = getResolvedDependency(
    dependencies,
    statement.source.value
  );
  if (!dependency?.resolved) {
    return [statement];
  }

  const manifest = yield* getOrBuildBarrelManifest.call(
    this,
    analysisServices,
    dependency.resolved
  );
  if (!isBarrelEntry(manifest)) {
    return [statement];
  }

  const optimized: RewrittenImportSpecifier[] = [];
  const fallback = [] as t.ImportDeclaration['specifiers'];

  for (const specifier of statement.specifiers) {
    if (t.isImportNamespaceSpecifier(specifier)) {
      fallback.push(specifier);
      continue;
    }

    if (t.isImportDefaultSpecifier(specifier)) {
      const binding = getManifestExport(manifest, 'default');
      if (binding?.kind === 'named' && binding.imported === 'default') {
        optimized.push({
          kind: 'default',
          local: specifier.local,
          source: binding.source,
        });
        continue;
      }

      if (binding?.kind === 'blocked') {
        emitRewriteSkipped(this, statement.source.value, binding.reason);
      }
      fallback.push(specifier);
      continue;
    }

    const imported = t.isIdentifier(specifier.imported)
      ? specifier.imported.name
      : specifier.imported.value;
    const binding = getManifestExport(manifest, imported);

    if (binding?.kind === 'named') {
      optimized.push({
        imported: binding.imported,
        kind: 'named',
        local: specifier.local,
        source: binding.source,
      });
      continue;
    }

    if (binding?.kind === 'blocked') {
      emitRewriteSkipped(this, statement.source.value, binding.reason);
    }
    fallback.push(specifier);
  }

  if (optimized.length === 0) {
    return [statement];
  }

  const rewritten = groupImportSpecifiers(optimized);
  const fallbackDeclaration = createImportFallback(statement, fallback);

  this.services.eventEmitter.single({
    file: this.entrypoint.name,
    kind: 'barrelRewrite',
    optimized: optimized.length,
    source: statement.source.value,
  });

  return fallbackDeclaration ? [fallbackDeclaration, ...rewritten] : rewritten;
}

function* rewriteExportNamedDeclaration(
  this: ITransformAction,
  analysisServices: Services,
  statement: t.ExportNamedDeclaration,
  dependencies: ResolvedDependencyMap
): Generator<any, t.Statement[], any> {
  if (!statement.source || !t.isStringLiteral(statement.source)) {
    return [statement];
  }

  const dependency = getResolvedDependency(
    dependencies,
    statement.source.value
  );
  if (!dependency?.resolved) {
    return [statement];
  }

  const manifest = yield* getOrBuildBarrelManifest.call(
    this,
    analysisServices,
    dependency.resolved
  );
  if (!isBarrelEntry(manifest)) {
    return [statement];
  }

  const optimized: RewrittenExportSpecifier[] = [];
  const fallback = [] as t.ExportNamedDeclaration['specifiers'];

  for (const specifier of statement.specifiers) {
    if (t.isExportNamespaceSpecifier(specifier)) {
      fallback.push(specifier);
      continue;
    }

    if (t.isExportDefaultSpecifier(specifier)) {
      const binding = getManifestExport(manifest, 'default');
      if (binding?.kind === 'named' && binding.imported === 'default') {
        optimized.push({
          exported: getModuleName(specifier.exported),
          imported: 'default',
          kind: 'named',
          source: binding.source,
        });
        continue;
      }

      if (binding?.kind === 'blocked') {
        emitRewriteSkipped(this, statement.source.value, binding.reason);
      }
      fallback.push(specifier);
      continue;
    }

    const imported = getModuleName(specifier.local);
    const exported = getModuleName(specifier.exported);
    const binding = getManifestExport(manifest, imported);

    if (binding?.kind === 'named' && canEmitNamedReexport(binding.imported)) {
      optimized.push({
        exported,
        imported: binding.imported,
        kind: 'named',
        source: binding.source,
      });
      continue;
    }

    if (binding?.kind === 'namespace' && t.isValidIdentifier(exported)) {
      optimized.push({
        exported,
        kind: 'namespace',
        source: binding.source,
      });
      continue;
    }

    if (binding?.kind === 'blocked') {
      emitRewriteSkipped(this, statement.source.value, binding.reason);
    }
    fallback.push(specifier);
  }

  if (optimized.length === 0) {
    return [statement];
  }

  const rewritten = groupExportSpecifiers(optimized);
  const fallbackDeclaration = createExportFallback(statement, fallback);

  this.services.eventEmitter.single({
    file: this.entrypoint.name,
    kind: 'barrelRewrite',
    optimized: optimized.length,
    source: statement.source.value,
  });

  return fallbackDeclaration ? [fallbackDeclaration, ...rewritten] : rewritten;
}

function* rewriteExportAllDeclaration(
  this: ITransformAction,
  analysisServices: Services,
  statement: t.ExportAllDeclaration,
  dependencies: ResolvedDependencyMap
): Generator<any, t.Statement[], any> {
  const dependency = getResolvedDependency(
    dependencies,
    statement.source.value
  );
  if (!dependency?.resolved) {
    return [statement];
  }

  const manifest = yield* getOrBuildBarrelManifest.call(
    this,
    analysisServices,
    dependency.resolved
  );
  if (!isBarrelEntry(manifest) || !manifest.complete) {
    return [statement];
  }

  const optimized: RewrittenExportSpecifier[] = [];
  let hasUnrewritableExport = false;
  for (const [exported, binding] of Object.entries(manifest.exports)) {
    if (exported === 'default' || binding.kind === 'blocked') {
      continue;
    }

    if (binding.kind === 'namespace') {
      if (!t.isValidIdentifier(exported)) {
        emitRewriteSkipped(this, statement.source.value, 'namespace-barrel');
        hasUnrewritableExport = true;
        continue;
      }

      optimized.push({
        exported,
        kind: 'namespace',
        source: binding.source,
      });
      continue;
    }

    if (!canEmitNamedReexport(binding.imported)) {
      emitRewriteSkipped(this, statement.source.value, 'unknown-star');
      hasUnrewritableExport = true;
      continue;
    }

    optimized.push({
      exported,
      imported: binding.imported,
      kind: 'named',
      source: binding.source,
    });
  }

  if (hasUnrewritableExport) {
    return [statement];
  }

  if (optimized.length === 0) {
    return [];
  }

  this.services.eventEmitter.single({
    complete: true,
    file: this.entrypoint.name,
    kind: 'barrelRewrite',
    optimized: optimized.length,
    source: statement.source.value,
  });

  return groupExportSpecifiers(optimized);
}

export function* rewriteOptimizedBarrelImports(
  this: ITransformAction,
  ast: t.File,
  code: string,
  resolvedImports: IEntrypointDependency[]
): Generator<any, RewriteResult, any> {
  const dependencies = buildResolvedDependencyMap(resolvedImports);
  const analysisServices = createAnalysisServices(this.services);
  const nextBody: t.Statement[] = [];
  let optimizedCount = 0;
  const optimizedSources = new Set<string>();
  let skippedCount = 0;

  for (const statement of ast.program.body) {
    if (
      t.isImportDeclaration(statement) &&
      t.isStringLiteral(statement.source)
    ) {
      const rewritten = yield* rewriteImportDeclaration.call(
        this,
        analysisServices,
        statement,
        dependencies
      );
      if (!(rewritten.length === 1 && rewritten[0] === statement)) {
        optimizedCount += 1;
        optimizedSources.add(statement.source.value);
      }
      nextBody.push(...rewritten);
      continue;
    }

    if (
      t.isExportNamedDeclaration(statement) &&
      statement.source &&
      t.isStringLiteral(statement.source)
    ) {
      const rewritten = yield* rewriteExportNamedDeclaration.call(
        this,
        analysisServices,
        statement,
        dependencies
      );
      if (!(rewritten.length === 1 && rewritten[0] === statement)) {
        optimizedCount += 1;
        optimizedSources.add(statement.source.value);
      }
      nextBody.push(...rewritten);
      continue;
    }

    if (
      t.isExportAllDeclaration(statement) &&
      statement.source &&
      t.isStringLiteral(statement.source)
    ) {
      const rewritten = yield* rewriteExportAllDeclaration.call(
        this,
        analysisServices,
        statement,
        dependencies
      );
      if (rewritten.length === 1 && rewritten[0] === statement) {
        skippedCount += 1;
      } else {
        optimizedCount += 1;
        optimizedSources.add(statement.source.value);
      }
      nextBody.push(...rewritten);
      continue;
    }

    nextBody.push(statement);
  }

  ast.program.body = nextBody;
  const rewrittenCode = generate(ast).code;

  return {
    ast,
    code: rewrittenCode,
    imports: collectOptimizedImports(ast),
    optimizedCount,
    optimizedSources: [...optimizedSources],
    skippedCount,
  };
}
