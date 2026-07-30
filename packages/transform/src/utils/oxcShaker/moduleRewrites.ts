/* eslint-disable no-restricted-syntax */

import fs from 'fs';
import path from 'path';

import type { Node, Program } from 'oxc-parser';

import { syncResolve, type ImportOverrides } from '@wyw-in-js/shared';

import { collectOxcExportsAndImportsFromProgram } from '../collectOxcExportsAndImports';
import type {
  collectOxcExportsAndImports,
  OxcCollectedImport,
} from '../collectOxcExportsAndImports';
import { getImportOverride, toImportKey } from '../importOverrides';
import { isOxcNode as isNode } from '../oxc/ast';
import { collectOxcPatternIdentifierNames as collectPatternNames } from '../oxc/patterns';
import { parseOxcCached } from '../parseOxc';
import { stripQueryAndHash } from '../parseRequest';
import { collectReferences } from './executableIndex';

type AnyNode = Node & Record<string, unknown>;

export type Replacement = {
  end: number;
  start: number;
  value: string;
};

type ModuleRewriteOptions = {
  importOverrides?: ImportOverrides;
  root?: string;
};

type ParsedShakerModule = ReturnType<typeof parseShakerModule>;
type RemoveUnusedImportSpecifiersResult = {
  code: string;
  parsed: ParsedShakerModule;
};

const warnedDynamicImportFiles = new Set<string>();

export const parseShakerModule = (
  code: string,
  filename: string
): { isEsModule: boolean; program: Program } => {
  try {
    const parsed = parseOxcCached(filename, code, 'unambiguous');
    return {
      isEsModule: parsed.module.hasModuleSyntax,
      program: parsed.program,
    };
  } catch (error) {
    if (process.env.WYW_DEBUG_SHAKER_DUMP) {
      const dumpFile = path.join(
        '/tmp',
        `wyw-oxc-shaker-${path
          .basename(filename)
          .replace(/[^a-z0-9_.-]/gi, '_')}-${Date.now()}.js`
      );
      fs.writeFileSync(dumpFile, code);
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown Oxc shaker parse error';
      throw new Error(`${message} [${filename}] [dump: ${dumpFile}]`);
    }

    throw error;
  }
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

const collectImportLocalNames = (node: Node): string[] => {
  if (node.type !== 'ImportDeclaration') {
    return [];
  }

  return node.specifiers.map((specifier) => specifier.local.name);
};

const getImportSpecifierLocalName = (node: Node): string | null => {
  const { local } = node as AnyNode;
  return isNode(local) && 'name' in local && typeof local.name === 'string'
    ? local.name
    : null;
};

const expandImportRemovalRange = (
  code: string,
  start: number,
  end: number
): Replacement => {
  let removalStart = start;
  while (
    removalStart > 0 &&
    (code[removalStart - 1] === ' ' || code[removalStart - 1] === '\t')
  ) {
    removalStart -= 1;
  }

  let removalEnd = end;
  if (code[removalEnd] === ';') {
    removalEnd += 1;
  }

  while (
    removalEnd < code.length &&
    (code[removalEnd] === ' ' || code[removalEnd] === '\t')
  ) {
    removalEnd += 1;
  }

  if (code[removalEnd] === '\r' && code[removalEnd + 1] === '\n') {
    removalEnd += 2;
  } else if (code[removalEnd] === '\n') {
    removalEnd += 1;
  }

  return {
    end: removalEnd,
    start: removalStart,
    value: '',
  };
};

const expandImportSpecifierRemovalRange = (
  code: string,
  start: number,
  end: number
): Replacement => {
  let removalStart = start;
  let removalEnd = end;

  let whitespaceStart = removalStart;
  while (
    whitespaceStart > 0 &&
    (code[whitespaceStart - 1] === ' ' || code[whitespaceStart - 1] === '\t')
  ) {
    whitespaceStart -= 1;
  }
  if (code[whitespaceStart - 1] !== '{') {
    removalStart = whitespaceStart;
  }

  while (
    removalEnd < code.length &&
    (code[removalEnd] === ' ' || code[removalEnd] === '\t')
  ) {
    removalEnd += 1;
  }

  if (code[removalEnd] === ',') {
    removalEnd += 1;
    while (
      removalEnd < code.length &&
      (code[removalEnd] === ' ' || code[removalEnd] === '\t')
    ) {
      removalEnd += 1;
    }
  } else {
    while (
      removalStart > 0 &&
      (code[removalStart - 1] === ' ' || code[removalStart - 1] === '\t')
    ) {
      removalStart -= 1;
    }

    if (code[removalStart - 1] === ',') {
      removalStart -= 1;
      while (
        removalStart > 0 &&
        (code[removalStart - 1] === ' ' || code[removalStart - 1] === '\t')
      ) {
        removalStart -= 1;
      }
    }
  }

  return {
    end: removalEnd,
    start: removalStart,
    value: '',
  };
};

const mergeEmptyRemovalRanges = (removals: Replacement[]): Replacement[] => {
  if (removals.length <= 1) {
    return removals;
  }

  const sorted = [...removals].sort((a, b) => a.start - b.start);
  const merged: Replacement[] = [];

  sorted.forEach((removal) => {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.value === '' &&
      removal.value === '' &&
      removal.start <= previous.end
    ) {
      previous.end = Math.max(previous.end, removal.end);
      return;
    }

    merged.push({ ...removal });
  });

  return merged;
};

const removeUnusedImportSpecifiers = (
  code: string,
  filename: string
): RemoveUnusedImportSpecifiersResult => {
  const parsed = parseShakerModule(code, filename);
  const { program } = parsed;
  const referencedNames = new Set<string>();

  program.body.forEach((statement) => {
    if (statement.type === 'ImportDeclaration') {
      return;
    }

    collectReferences(statement as Node).forEach((name) =>
      referencedNames.add(name)
    );
  });

  const removals: Replacement[] = [];
  program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration') {
      return;
    }

    if (statement.specifiers.length === 0) {
      return;
    }

    const localNames = collectImportLocalNames(statement);
    if (localNames.every((localName) => !referencedNames.has(localName))) {
      removals.push(
        expandImportRemovalRange(code, statement.start, statement.end)
      );
      return;
    }

    if (statement.specifiers.length <= 1) {
      return;
    }

    statement.specifiers.forEach((specifier) => {
      const localName = getImportSpecifierLocalName(specifier);
      if (localName && !referencedNames.has(localName)) {
        removals.push(
          expandImportSpecifierRemovalRange(
            code,
            specifier.start,
            specifier.end
          )
        );
      }
    });
  });

  if (removals.length === 0) {
    return {
      code,
      parsed,
    };
  }

  const mergedRemovals = mergeEmptyRemovalRanges(removals);
  const nextCode = applyReplacements(code, mergedRemovals);

  try {
    return {
      code: nextCode,
      parsed: parseShakerModule(nextCode, filename),
    };
  } catch {
    return {
      code,
      parsed,
    };
  }
};

export const hasImportOverride = (
  source: string,
  options: Pick<ModuleRewriteOptions, 'importOverrides' | 'root'>
): boolean => {
  const { importOverrides } = options;
  if (!importOverrides || Object.keys(importOverrides).length === 0) {
    return false;
  }

  const stripped = stripQueryAndHash(source);
  const direct =
    getImportOverride(importOverrides, source) ??
    (stripped !== source ? getImportOverride(importOverrides, stripped) : null);

  if (direct && ('mock' in direct || 'noShake' in direct)) {
    return true;
  }

  if (!stripped.startsWith('.') && !path.isAbsolute(stripped)) {
    return false;
  }

  return false;
};

const importsToMap = (
  collected: ReturnType<typeof collectOxcExportsAndImports>
): Map<string, string[]> => {
  const result = new Map<string, string[]>();

  const add = (source: string, imported: string): void => {
    const bucket = result.get(source) ?? [];
    if (!bucket.includes(imported)) {
      bucket.push(imported);
    }

    result.set(source, bucket);
  };

  collected.imports.forEach((item) => {
    const imported = item.imported || 'side-effect';
    add(item.source, imported);
  });

  collected.reexports.forEach((item) => {
    add(item.source, item.imported || 'side-effect');
  });

  return result;
};

const dynamicImportWarningsEnabled = (): boolean =>
  Boolean(process.env.WYW_WARN_DYNAMIC_IMPORTS) &&
  process.env.WYW_WARN_DYNAMIC_IMPORTS !== '0' &&
  process.env.WYW_WARN_DYNAMIC_IMPORTS !== 'false';

const filterDynamicImportsForWarning = (
  imports: OxcCollectedImport[],
  filename: string,
  options: ModuleRewriteOptions
): string[] => {
  const sources = Array.from(
    new Set(
      imports
        .filter((item) => item.type === 'dynamic')
        .map((item) => item.source)
    )
  ).sort();

  if (
    !options.importOverrides ||
    Object.keys(options.importOverrides).length === 0
  ) {
    return sources;
  }

  const shouldWarn = (source: string): boolean => {
    const strippedSource = stripQueryAndHash(source);
    const direct =
      getImportOverride(options.importOverrides, source) ??
      (strippedSource !== source
        ? getImportOverride(options.importOverrides, strippedSource)
        : undefined);

    if (direct !== undefined) {
      return false;
    }

    const isFileImport =
      strippedSource.startsWith('.') || path.isAbsolute(strippedSource);
    if (!isFileImport) {
      return true;
    }

    try {
      const resolved = syncResolve(strippedSource, filename, []);
      const importKey = toImportKey({
        resolved,
        root: options.root,
        source: strippedSource,
      }).key;

      return (
        getImportOverride(options.importOverrides, importKey) === undefined
      );
    } catch {
      return true;
    }
  };

  return sources.filter(shouldWarn);
};

const warnDynamicImports = (
  imports: OxcCollectedImport[],
  filename: string,
  options: ModuleRewriteOptions
): void => {
  if (
    !dynamicImportWarningsEnabled() ||
    warnedDynamicImportFiles.has(filename)
  ) {
    return;
  }

  const sourcesToWarn = filterDynamicImportsForWarning(
    imports,
    filename,
    options
  );
  if (sourcesToWarn.length === 0) {
    return;
  }

  warnedDynamicImportFiles.add(filename);

  const overrideKeys = sourcesToWarn
    .map((source) => {
      const strippedSource = stripQueryAndHash(source);
      const isFileImport =
        strippedSource.startsWith('.') || path.isAbsolute(strippedSource);

      if (!isFileImport) {
        return { key: source, source };
      }

      try {
        const resolved = syncResolve(strippedSource, filename, []);
        return {
          key: toImportKey({
            resolved,
            root: options.root,
            source: strippedSource,
          }).key,
          source,
        };
      } catch {
        return { key: strippedSource, source };
      }
    })
    .filter((item, index, array) => {
      const firstIndexForKey = array.findIndex((i) => i.key === item.key);
      return firstIndexForKey === index;
    });

  const warning = [
    `[wyw-in-js] Dynamic imports reached prepare stage`,
    ``,
    `file: ${filename}`,
    `count: ${sourcesToWarn.length}`,
    `sources:`,
    ...sourcesToWarn.map((source) => `  - ${source}`),
    ``,
    `note: these imports will be resolved/processed even if they are lazy (e.g. React.lazy(() => import(...)))`,
    ``,
    `tip: if the imported module is runtime-only or heavy, mock it during evaluation via importOverrides:`,
    `  importOverrides: {`,
    ...overrideKeys.map(
      ({ key, source }) =>
        `    '${key}': { mock: './path/to/mock' }, // from ${source}`
    ),
    `  }`,
    ``,
    `note: importOverrides affects only build-time evaluation (it does not change your bundler runtime behavior)`,
  ].join('\n');

  // eslint-disable-next-line no-console
  console.warn(warning);
};

export const removeExportKeyword = (
  code: string,
  node: Node
): Replacement | null => {
  if (
    node.type !== 'ExportNamedDeclaration' ||
    !node.declaration ||
    node.start === node.declaration.start
  ) {
    return null;
  }

  return {
    end: node.declaration.start,
    start: node.start,
    value: '',
  };
};

export const splitExportedVariableDeclaration = (
  code: string,
  node: Node,
  requested: Set<string>
): Replacement | null => {
  if (
    node.type !== 'ExportNamedDeclaration' ||
    !node.declaration ||
    node.declaration.type !== 'VariableDeclaration' ||
    node.declaration.declarations.length <= 1
  ) {
    return null;
  }

  const declarators = node.declaration.declarations;
  const declaratorNames = declarators.map((declarator) =>
    collectPatternNames(declarator.id)
  );
  const requestedNames = declaratorNames
    .flat()
    .filter((name) => requested.has(name));

  if (
    requestedNames.length === 0 ||
    requestedNames.length === declaratorNames.flat().length
  ) {
    return null;
  }

  const declarationCode = `${node.declaration.kind} ${declarators
    .map((declarator) => code.slice(declarator.start, declarator.end))
    .join(', ')};`;

  return {
    end: node.end,
    start: node.start,
    value: `${declarationCode}\nexport { ${requestedNames.join(', ')} };`,
  };
};

export const finalizeShakenModule = (
  code: string,
  filename: string,
  replacements: Replacement[],
  options: ModuleRewriteOptions
): { code: string; imports: Map<string, string[]> } => {
  const cleaned = removeUnusedImportSpecifiers(
    applyReplacements(code, replacements),
    filename
  );
  const nextCode = cleaned.code;
  const nextCollected = collectOxcExportsAndImportsFromProgram(
    cleaned.parsed.program,
    nextCode,
    cleaned.parsed.isEsModule
  );
  warnDynamicImports(nextCollected.imports, filename, options);

  return {
    code: nextCode,
    imports: importsToMap(nextCollected),
  };
};
