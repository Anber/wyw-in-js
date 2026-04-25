/* eslint-disable no-restricted-syntax */

import fs from 'fs';
import path from 'path';

import type { Node, Program } from 'oxc-parser';

import { syncResolve, type ImportOverrides } from '@wyw-in-js/shared';

import {
  collectOxcExportsAndImports,
  collectOxcExportsAndImportsFromProgram,
  type OxcCollectedImport,
} from './collectOxcExportsAndImports';
import { getImportOverride, toImportKey } from './importOverrides';
import { parseOxcCached } from './parseOxc';
import { stripQueryAndHash } from './parseRequest';

type AnyNode = Node & Record<string, unknown>;

type Replacement = {
  end: number;
  start: number;
  value: string;
};

type OxcShakerOptions = {
  importOverrides?: ImportOverrides;
  keepSideEffects?: boolean;
  onlyExports: string[];
  root?: string;
};

type StatementInfo = {
  bindings: Set<string>;
  exportNames: Set<string>;
  imports: OxcCollectedImport[];
  mutations: Set<string>;
  node: Node;
  references: Set<string>;
  sideEffectImport: boolean;
};

export type OxcShakerResult = {
  code: string;
  imports: Map<string, string[]>;
};
type ParsedOxcProgram = ReturnType<typeof parseOxc>;
type RemoveUnusedImportSpecifiersResult = {
  code: string;
  parsed: ParsedOxcProgram;
};

const warnedDynamicImportFiles = new Set<string>();

const isNode = (value: unknown): value is Node =>
  !!value &&
  typeof value === 'object' &&
  'type' in value &&
  typeof (value as { type?: unknown }).type === 'string';

const getChildren = (node: Node): Node[] => {
  const result: Node[] = [];
  const record = node as AnyNode;

  Object.keys(record).forEach((key) => {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'range') {
      return;
    }

    const value = record[key];
    if (isNode(value)) {
      result.push(value);
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => {
        if (isNode(item)) {
          result.push(item);
        }
      });
    }
  });

  return result;
};

const parseOxc = (
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
        `wyw-oxc-shaker-${path.basename(filename).replace(/[^a-z0-9_.-]/gi, '_')}-${Date.now()}.js`
      );
      fs.writeFileSync(dumpFile, code);
      const message =
        error instanceof Error ? error.message : 'Unknown Oxc shaker parse error';
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

const collectBindingNames = (node: Node | null | undefined): string[] => {
  if (!node) {
    return [];
  }

  if (node.type === 'Identifier') {
    return [node.name];
  }

  if (node.type === 'RestElement') {
    return collectBindingNames(node.argument);
  }

  if (node.type === 'AssignmentPattern') {
    return collectBindingNames(node.left);
  }

  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectBindingNames(property.argument)
        : collectBindingNames(property.value)
    );
  }

  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) => collectBindingNames(element));
  }

  return [];
};

const declarationBindings = (
  declaration: Node | null | undefined
): string[] => {
  if (!declaration) {
    return [];
  }

  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((item) =>
      collectBindingNames(item.id)
    );
  }

  if (
    (declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'ClassDeclaration' ||
      declaration.type === 'TSEnumDeclaration') &&
    declaration.id
  ) {
    return [declaration.id.name];
  }

  return [];
};

const moduleExportName = (node: Node): string | null => {
  if (node.type === 'Identifier' || node.type === 'Literal') {
    return String((node as AnyNode).name ?? (node as AnyNode).value);
  }

  return null;
};

const isBindingIdentifier = (node: Node, parent: Node | null): boolean => {
  if (node.type !== 'Identifier' || !parent) {
    return false;
  }

  const parentNode = parent as AnyNode;
  if (parent.type === 'VariableDeclarator' && parentNode.id === node) {
    return true;
  }

  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ClassDeclaration' ||
      parent.type === 'ClassExpression' ||
      parent.type === 'TSEnumDeclaration') &&
    parentNode.id === node
  ) {
    return true;
  }

  if (
    (parent.type === 'ImportSpecifier' ||
      parent.type === 'ImportDefaultSpecifier' ||
      parent.type === 'ImportNamespaceSpecifier') &&
    parentNode.local === node
  ) {
    return true;
  }

  return false;
};

const isIdentifierReference = (
  node: Node,
  parent: Node | null,
  grandparent: Node | null
): boolean => {
  if (node.type !== 'Identifier') {
    return false;
  }

  if (isBindingIdentifier(node, parent)) {
    return false;
  }

  if (!parent) {
    return true;
  }

  const parentNode = parent as AnyNode;
  if (
    parent.type === 'Property' &&
    parentNode.key === node &&
    !parentNode.computed
  ) {
    return false;
  }

  if (
    parent.type === 'MemberExpression' &&
    parentNode.property === node &&
    !parentNode.computed
  ) {
    return false;
  }

  if (
    parent.type === 'ExportSpecifier' &&
    parentNode.exported === node
  ) {
    return false;
  }

  if (parent.type === 'ExportSpecifier' && parentNode.local === node) {
    return grandparent?.type === 'ExportNamedDeclaration'
      ? !grandparent.source
      : true;
  }

  return true;
};

const collectReferences = (node: Node): Set<string> => {
  const references = new Set<string>();

  const visit = (
    current: Node,
    parent: Node | null = null,
    grandparent: Node | null = null
  ): void => {
    if (current.type.startsWith('TS') && current.type !== 'TSEnumDeclaration') {
      return;
    }

    if (isIdentifierReference(current, parent, grandparent)) {
      references.add((current as AnyNode).name as string);
    }

    getChildren(current).forEach((child) => visit(child, current, parent));
  };

  visit(node);

  return references;
};

const getMutatedBinding = (node: Node): string | null => {
  if (node.type === 'Identifier') {
    return node.name;
  }

  if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
    return node.object.name;
  }

  return null;
};

const getMutationCallTarget = (node: Node): string | null => {
  if (node.type !== 'CallExpression') {
    return null;
  }

  const { callee } = node;
  if (
    callee.type !== 'MemberExpression' ||
    callee.object.type !== 'Identifier' ||
    callee.object.name !== 'Object' ||
    callee.computed ||
    callee.property.type !== 'Identifier'
  ) {
    return null;
  }

  if (
    callee.property.name !== 'assign' &&
    callee.property.name !== 'defineProperty' &&
    callee.property.name !== 'defineProperties'
  ) {
    return null;
  }

  const [target] = node.arguments;
  if (!target || target.type === 'SpreadElement') {
    return null;
  }

  return getMutatedBinding(target);
};

const collectMutations = (node: Node): Set<string> => {
  const mutations = new Set<string>();

  const visit = (current: Node): void => {
    if (current.type === 'AssignmentExpression') {
      const mutated = getMutatedBinding(current.left);
      if (mutated) {
        mutations.add(mutated);
      }
    } else if (current.type === 'UpdateExpression') {
      const mutated = getMutatedBinding(current.argument);
      if (mutated) {
        mutations.add(mutated);
      }
    } else {
      const mutated = getMutationCallTarget(current);
      if (mutated) {
        mutations.add(mutated);
      }
    }

    getChildren(current).forEach(visit);
  };

  visit(node);
  return mutations;
};

const buildStatementInfo = (
  program: Program,
  collected: ReturnType<typeof collectOxcExportsAndImports>
): StatementInfo[] => {
  const { exports: collectedExports, imports: collectedImports } = collected;
  const importsByStart = new Map<number, OxcCollectedImport[]>();
  collectedImports.forEach((item) => {
    const bucket = importsByStart.get(item.local.start) ?? [];
    bucket.push(item);
    importsByStart.set(item.local.start, bucket);
  });

  return program.body.map((statement) => {
    const node = statement as Node;
    const exportNames = new Set<string>();
    const bindings = new Set<string>();
    const imports: OxcCollectedImport[] = [];
    const references = collectReferences(node);
    let sideEffectImport = false;

    if (node.type === 'ImportDeclaration') {
      sideEffectImport = node.specifiers.length === 0;
      node.specifiers.forEach((specifier) => {
        bindings.add(specifier.local.name);
        const matched = importsByStart.get(specifier.local.start) ?? [];
        imports.push(...matched);
      });

      if (sideEffectImport) {
        const matched = collectedImports.filter(
          (item) =>
            item.imported === 'side-effect' &&
            item.local.start === node.start &&
            item.local.end === node.end
        );
        imports.push(...matched);
      }
    } else if (node.type === 'ExportNamedDeclaration') {
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
      if (node.declaration) {
        declarationBindings(node.declaration).forEach((name) =>
          exportNames.add(name)
        );
      }

      node.specifiers.forEach((specifier) => {
        const local = moduleExportName(specifier.local);
        const exported = moduleExportName(specifier.exported);
        if (local && !node.source) references.add(local);
        if (exported) exportNames.add(exported);
      });
    } else if (node.type === 'ExportDefaultDeclaration') {
      exportNames.add('default');
      declarationBindings(node.declaration).forEach((name) =>
        bindings.add(name)
      );
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exported) {
        const exported = moduleExportName(node.exported);
        if (exported) {
          exportNames.add(exported);
        }
      } else {
        exportNames.add('*');
      }
    } else {
      Object.entries(collectedExports).forEach(([exported, local]) => {
        if (local.start >= node.start && local.end <= node.end) {
          exportNames.add(exported);
        }
      });
      declarationBindings(node).forEach((name) => bindings.add(name));
    }

    return {
      bindings,
      exportNames,
      imports,
      mutations: collectMutations(node),
      node,
      references,
      sideEffectImport,
    };
  });
};

const collectImportLocalNames = (node: Node): string[] => {
  if (node.type !== 'ImportDeclaration') {
    return [];
  }

  return node.specifiers.map((specifier) => specifier.local.name);
};

const getImportSpecifierLocalName = (node: Node): string | null => {
  const local = (node as AnyNode).local;
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
  const parsed = parseOxc(code, filename);
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
      parsed: parseOxc(nextCode, filename),
    };
  } catch {
    return {
      code,
      parsed,
    };
  }
};

const hasImportOverride = (
  source: string,
  options: Pick<OxcShakerOptions, 'importOverrides' | 'root'>
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
  options: OxcShakerOptions
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
  options: OxcShakerOptions
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

const removeExportKeyword = (code: string, node: Node): Replacement | null => {
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

const splitExportedVariableDeclaration = (
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
    collectBindingNames(declarator.id)
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

export const shakeOxcToESM = (
  code: string,
  filename: string,
  options: OxcShakerOptions
): OxcShakerResult => {
  const parsed = parseOxc(code, filename);
  const { program } = parsed;
  const collected = collectOxcExportsAndImportsFromProgram(
    program,
    code,
    parsed.isEsModule
  );
  const statements = buildStatementInfo(program, collected);
  const bindingOwners = new Map<string, StatementInfo>();
  statements.forEach((statement) => {
    statement.bindings.forEach((binding) => {
      if (!bindingOwners.has(binding)) {
        bindingOwners.set(binding, statement);
      }
    });
  });

  const requested = new Set(options.onlyExports);
  const keepAllExports = requested.has('*');
  const liveStatements = new Set<StatementInfo>();
  const liveExportStatements = new Set<StatementInfo>();
  const queue: StatementInfo[] = [];
  const mutationsByBinding = new Map<string, StatementInfo[]>();

  statements.forEach((statement) => {
    statement.mutations.forEach((binding) => {
      const bucket = mutationsByBinding.get(binding) ?? [];
      bucket.push(statement);
      mutationsByBinding.set(binding, bucket);
    });
  });

  const mark = (statement: StatementInfo, exported = false): void => {
    if (!liveStatements.has(statement)) {
      liveStatements.add(statement);
      queue.push(statement);
    }

    if (exported) {
      liveExportStatements.add(statement);
    }
  };

  statements.forEach((statement) => {
    const hasWildcardReexport = statement.exportNames.has('*');
    if (
      statement.exportNames.size > 0 &&
      (keepAllExports ||
        (hasWildcardReexport &&
          requested.size > 0 &&
          !requested.has('side-effect')) ||
        [...statement.exportNames].some((name) => requested.has(name)))
    ) {
      mark(statement, true);
    }

    if (
      statement.sideEffectImport &&
      (requested.has('side-effect') ||
        options.keepSideEffects ||
        statement.imports.some((item) =>
          hasImportOverride(item.source, options)
        ))
    ) {
      mark(statement);
    }
  });

  while (queue.length > 0) {
    const current = queue.shift()!;
    current.references.forEach((name) => {
      const owner = bindingOwners.get(name);
      if (owner) {
        mark(owner);
      }
    });
    current.bindings.forEach((binding) => {
      mutationsByBinding.get(binding)?.forEach((mutation) => {
        mark(mutation);
      });
    });
  }

  const replacements: Replacement[] = [];
  statements.forEach((statement) => {
    if (!liveStatements.has(statement)) {
      replacements.push({
        end: statement.node.end,
        start: statement.node.start,
        value: '',
      });
      return;
    }

    if (!liveExportStatements.has(statement)) {
      const replacement = removeExportKeyword(code, statement.node);
      if (replacement) {
        replacements.push(replacement);
      }
      return;
    }

    const splitReplacement = splitExportedVariableDeclaration(
      code,
      statement.node,
      requested
    );
    if (splitReplacement) {
      replacements.push(splitReplacement);
    }
  });

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
