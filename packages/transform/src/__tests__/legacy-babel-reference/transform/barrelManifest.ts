/* eslint-disable no-continue, @typescript-eslint/no-use-before-define */
import babelTraverse from '@babel/traverse';
import { getBindingIdentifiers } from '@babel/types';
import type {
  ClassDeclaration,
  Declaration,
  ExportAllDeclaration,
  ExportDefaultSpecifier,
  ExportNamedDeclaration,
  ExportNamespaceSpecifier,
  ExportSpecifier,
  File,
  FunctionDeclaration,
  Identifier,
  ImportDeclaration,
  ImportSpecifier,
  Program,
  StringLiteral,
  VariableDeclaration,
} from '@babel/types';

const traverse =
  (babelTraverse as unknown as { default?: typeof babelTraverse }).default ??
  babelTraverse;

export type BarrelSkipReason =
  | 'custom-evaluator'
  | 'empty'
  | 'ignored'
  | 'impure'
  | 'namespace-barrel'
  | 'unknown-star';

export type BarrelBlockedReason =
  | 'ambiguous'
  | 'cycle'
  | 'namespace-barrel'
  | 'unknown-star'
  | 'unresolved';

export type BarrelResolvedBinding =
  | {
      imported: string;
      kind: 'named';
      source: string;
    }
  | {
      kind: 'namespace';
      source: string;
    };

export type BarrelManifestExport =
  | BarrelResolvedBinding
  | {
      kind: 'blocked';
      reason: BarrelBlockedReason;
    };

export type BarrelManifest = {
  complete: boolean;
  exports: Record<string, BarrelManifestExport>;
  kind: 'barrel';
};

export type BarrelManifestCacheEntry =
  | BarrelManifest
  | {
      kind: 'ineligible';
      reason: BarrelSkipReason;
    };

export type RawBarrelReexport =
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

export type RawBarrelManifest = {
  complete: boolean;
  explicitExports: string[];
  exportAll: string[];
  kind: 'barrel';
  reexports: RawBarrelReexport[];
};

type LocalImportBinding =
  | {
      imported: string;
      kind: 'named';
      source: string;
    }
  | {
      kind: 'namespace';
      source: string;
    };

const isTypeOnlyImport = (statement: ImportDeclaration): boolean => {
  if (statement.importKind === 'type') {
    return true;
  }

  if (statement.specifiers.length === 0) {
    return false;
  }

  return statement.specifiers.every(
    (specifier) =>
      specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'
  );
};

const isTypeOnlyExport = (statement: ExportNamedDeclaration): boolean =>
  statement.exportKind === 'type';

const getModuleExportName = (node: Identifier | StringLiteral): string =>
  node.type === 'Identifier' ? node.name : node.value;

const isTypeOnlyStatement = (statement: Program['body'][number]): boolean => {
  switch (statement.type) {
    case 'EmptyStatement':
    case 'TSDeclareFunction':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
      return true;
    default:
      return false;
  }
};

function collectExportNamedDeclaration(
  statement: ExportNamedDeclaration,
  reexports: RawBarrelReexport[],
  explicitExports: Set<string>
): boolean {
  if (!statement.source) {
    return isTypeOnlyExport(statement);
  }

  if (isTypeOnlyExport(statement)) {
    return true;
  }

  const source = statement.source.value;
  for (const specifier of statement.specifiers) {
    if (specifier.type === 'ExportSpecifier') {
      if (specifier.exportKind === 'type') {
        continue;
      }

      explicitExports.add(getModuleExportName(specifier.exported));
      reexports.push(getNamedReexport(specifier, source));
      continue;
    }

    if (specifier.type === 'ExportDefaultSpecifier') {
      explicitExports.add(getModuleExportName(specifier.exported));
      reexports.push(getDefaultReexport(specifier, source));
      continue;
    }

    if (specifier.type === 'ExportNamespaceSpecifier') {
      explicitExports.add(getModuleExportName(specifier.exported));
      reexports.push(getNamespaceReexport(specifier, source));
      continue;
    }

    return false;
  }

  return statement.specifiers.length > 0;
}

function getNamedReexport(
  specifier: ExportSpecifier,
  source: string
): RawBarrelReexport {
  return {
    exported: getModuleExportName(specifier.exported),
    imported: getModuleExportName(specifier.local),
    kind: 'named',
    source,
  };
}

function getDefaultReexport(
  specifier: ExportDefaultSpecifier,
  source: string
): RawBarrelReexport {
  return {
    exported: getModuleExportName(specifier.exported),
    imported: 'default',
    kind: 'named',
    source,
  };
}

function getNamespaceReexport(
  specifier: ExportNamespaceSpecifier,
  source: string
): RawBarrelReexport {
  return {
    exported: getModuleExportName(specifier.exported),
    kind: 'namespace',
    source,
  };
}

const collectImportBinding = (
  statement: ImportDeclaration,
  imports: Map<string, LocalImportBinding>
): boolean => {
  if (statement.importKind === 'type') {
    return true;
  }

  if (statement.specifiers.length === 0) {
    return false;
  }

  let sawValueImport = false;
  for (const specifier of statement.specifiers) {
    if (
      specifier.type === 'ImportSpecifier' &&
      specifier.importKind === 'type'
    ) {
      continue;
    }

    sawValueImport = true;

    if (specifier.type === 'ImportSpecifier') {
      imports.set(specifier.local.name, {
        imported: getImportSpecifierName(specifier),
        kind: 'named',
        source: statement.source.value,
      });
      continue;
    }

    if (specifier.type === 'ImportDefaultSpecifier') {
      imports.set(specifier.local.name, {
        imported: 'default',
        kind: 'named',
        source: statement.source.value,
      });
      continue;
    }

    imports.set(specifier.local.name, {
      kind: 'namespace',
      source: statement.source.value,
    });
  }

  return sawValueImport || isTypeOnlyImport(statement);
};

const getImportSpecifierName = (specifier: ImportSpecifier): string =>
  getModuleExportName(specifier.imported);

const getLocalDeclarationNames = (
  declaration: Declaration
): string[] | null => {
  if (
    declaration.type === 'VariableDeclaration' ||
    declaration.type === 'FunctionDeclaration' ||
    declaration.type === 'ClassDeclaration'
  ) {
    return Object.keys(
      getBindingIdentifiers(
        declaration as
          | VariableDeclaration
          | FunctionDeclaration
          | ClassDeclaration
      )
    );
  }

  if (
    declaration.type === 'TSEnumDeclaration' ||
    declaration.type === 'TSModuleDeclaration'
  ) {
    return null;
  }

  return [];
};

const collectLocalExportNamedDeclaration = (
  statement: ExportNamedDeclaration,
  importedBindings: Map<string, LocalImportBinding>,
  passthroughCandidates: Map<string, string[]>,
  explicitExports: Set<string>
): { complete: boolean; ok: boolean } => {
  let complete = true;

  if (isTypeOnlyExport(statement)) {
    return {
      complete: true,
      ok: true,
    };
  }

  if (statement.declaration) {
    const names = getLocalDeclarationNames(statement.declaration);
    if (names === null) {
      return {
        complete: false,
        ok: false,
      };
    }

    for (const name of names) {
      explicitExports.add(name);
    }

    return {
      complete: names.length === 0,
      ok: true,
    };
  }

  for (const specifier of statement.specifiers) {
    if (specifier.type !== 'ExportSpecifier') {
      return {
        complete: false,
        ok: false,
      };
    }

    if (specifier.exportKind === 'type') {
      continue;
    }

    const exported = getModuleExportName(specifier.exported);
    explicitExports.add(exported);

    if (specifier.local.type !== 'Identifier') {
      complete = false;
      continue;
    }

    if (!importedBindings.has(specifier.local.name)) {
      complete = false;
      continue;
    }

    if (!passthroughCandidates.has(specifier.local.name)) {
      passthroughCandidates.set(specifier.local.name, []);
    }
    passthroughCandidates.get(specifier.local.name)!.push(exported);
  }

  return {
    complete: complete && statement.specifiers.length > 0,
    ok: true,
  };
};

const collectPassthroughReexports = (
  ast: File,
  importedBindings: Map<string, LocalImportBinding>,
  passthroughCandidates: Map<string, string[]>,
  reexports: RawBarrelReexport[]
): { complete: boolean; ok: boolean } => {
  let complete = true;
  const bindingReferenceCounts = new Map<string, number>();

  traverse(ast, {
    Program(path) {
      for (const localName of passthroughCandidates.keys()) {
        bindingReferenceCounts.set(
          localName,
          path.scope.getBinding(localName)?.referencePaths.length ?? -1
        );
      }
      path.stop();
    },
  });

  for (const [localName, exportedNames] of passthroughCandidates) {
    if (bindingReferenceCounts.get(localName) !== exportedNames.length) {
      complete = false;
      continue;
    }

    const imported = importedBindings.get(localName)!;
    for (const exported of exportedNames) {
      if (imported.kind === 'namespace') {
        reexports.push({
          exported,
          kind: 'namespace',
          source: imported.source,
        });
        continue;
      }

      reexports.push({
        exported,
        imported: imported.imported,
        kind: 'named',
        source: imported.source,
      });
    }
  }

  return {
    complete,
    ok: true,
  };
};

function analyzeBarrelProgram(ast: File): RawBarrelManifest | null {
  const reexports: RawBarrelReexport[] = [];
  const explicitExports = new Set<string>();
  const exportAll: string[] = [];
  const importedBindings = new Map<string, LocalImportBinding>();
  const passthroughCandidates = new Map<string, string[]>();
  let complete = true;

  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (!collectImportBinding(statement, importedBindings)) {
        return null;
      }
      continue;
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.source) {
        if (
          !collectExportNamedDeclaration(statement, reexports, explicitExports)
        ) {
          return null;
        }
        continue;
      }

      const localResult = collectLocalExportNamedDeclaration(
        statement,
        importedBindings,
        passthroughCandidates,
        explicitExports
      );
      if (!localResult.ok) {
        return null;
      }
      complete = complete && localResult.complete;
      continue;
    }

    if (statement.type === 'ExportAllDeclaration') {
      if (statement.exportKind === 'type') {
        continue;
      }

      if (!statement.source) {
        return null;
      }

      exportAll.push(getExportAllSource(statement));
      continue;
    }

    if (statement.type === 'ExportDefaultDeclaration') {
      return null;
    }

    if (!isTypeOnlyStatement(statement)) {
      return null;
    }
  }

  const passthroughResult = collectPassthroughReexports(
    ast,
    importedBindings,
    passthroughCandidates,
    reexports
  );
  if (!passthroughResult.ok) {
    return null;
  }
  complete = complete && passthroughResult.complete;

  if (reexports.length === 0 && exportAll.length === 0) {
    return null;
  }

  return {
    complete,
    explicitExports: [...explicitExports],
    exportAll,
    kind: 'barrel',
    reexports,
  };
}

const getExportAllSource = (statement: ExportAllDeclaration): string =>
  statement.source.value;

export function analyzeBarrelFile(
  ast: File
): BarrelManifestCacheEntry | RawBarrelManifest {
  const result = analyzeBarrelProgram(ast);

  if (!result) {
    return {
      kind: 'ineligible',
      reason: 'impure',
    };
  }

  return result;
}
