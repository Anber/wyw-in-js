/* eslint-disable no-continue, @typescript-eslint/no-use-before-define */
import type {
  ExportAllDeclaration,
  ExportDefaultSpecifier,
  ExportNamedDeclaration,
  ExportNamespaceSpecifier,
  ExportSpecifier,
  File,
  Identifier,
  ImportDeclaration,
  Program,
  StringLiteral,
} from '@babel/types';

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
      kind: 'named';
      imported: string;
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
  exportAll: string[];
  kind: 'barrel';
  reexports: RawBarrelReexport[];
};

const isTypeOnlyImport = (statement: ImportDeclaration): boolean => {
  if (statement.importKind === 'type') {
    return true;
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
  if (statement.type === 'EmptyStatement') {
    return true;
  }

  return statement.type.startsWith('TS');
};

function collectExportNamedDeclaration(
  statement: ExportNamedDeclaration,
  reexports: RawBarrelReexport[]
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
      reexports.push(getNamedReexport(specifier, source));
      continue;
    }

    if (specifier.type === 'ExportDefaultSpecifier') {
      reexports.push(getDefaultReexport(specifier, source));
      continue;
    }

    if (specifier.type === 'ExportNamespaceSpecifier') {
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

function isPureBarrelProgram(program: Program): RawBarrelManifest | null {
  const reexports: RawBarrelReexport[] = [];
  const exportAll: string[] = [];

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (!isTypeOnlyImport(statement)) {
        return null;
      }
      continue;
    }

    if (statement.type === 'ExportNamedDeclaration') {
      if (!collectExportNamedDeclaration(statement, reexports)) {
        return null;
      }
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

  if (reexports.length === 0 && exportAll.length === 0) {
    return null;
  }

  return {
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
  const result = isPureBarrelProgram(ast.program);

  if (!result) {
    return {
      kind: 'ineligible',
      reason: 'impure',
    };
  }

  return result;
}
