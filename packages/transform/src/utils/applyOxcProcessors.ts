/* eslint-disable no-restricted-syntax */

import { basename, dirname } from 'path';

import { BaseProcessor, expressionToCode } from '@wyw-in-js/processor-utils';
import type {
  Expression as ProcessorExpression,
  IFileContext,
  Param,
  Params,
  SourceLocation,
} from '@wyw-in-js/processor-utils';
import type { ExpressionValue, StrictOptions } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type {
  CallExpression,
  Expression,
  MemberExpression,
  Node,
  Program,
  TaggedTemplateExpression,
} from 'oxc-parser';

import { collectOxcProcessorImportsFromProgram } from './collectOxcExportsAndImports';
import { EventEmitter } from './EventEmitter';
import { collectOxcExpressionDependencies } from './collectOxcTemplateDependencies';
import { isNotNull } from './isNotNull';
import {
  createOxcAstService,
  printOxcAstServiceImport,
  type AddedImport,
  type OxcAstService,
} from './oxcAstService';
import { parseOxcProgramCached } from './parseOxc';
import { getProcessorForImport, type ProcessorClass } from './processorLookup';

type DefinedProcessor = [ProcessorClass, { imported: string; source: string }];

type Replacement = {
  end: number;
  start: number;
  value: string;
};

type ApplyOxcProcessorsResult = {
  code: string;
  processors: BaseProcessor[];
};

type AnyNode = Node & Record<string, unknown>;

type OxcIdentifier = Expression & {
  name: string;
  type: 'Identifier';
};

type ProcessorUsage =
  | {
      ancestors: Node[];
      callee: Expression;
      collapseQualifiedCallee: boolean;
      definedProcessor: DefinedProcessor;
      kind: 'call';
      replacementTarget: Expression;
      target: CallExpression;
    }
  | {
      ancestors: Node[];
      callee: Expression;
      collapseQualifiedCallee: boolean;
      definedProcessor: DefinedProcessor;
      kind: 'template';
      replacementTarget: Expression;
      target: TaggedTemplateExpression;
    };

type ExpressionSpan = {
  end: number;
  start: number;
};

type CreatedProcessor = {
  astService: OxcAstService;
  processor: BaseProcessor;
};

type QualifiedExpression = Expression & {
  expressions?: Expression[];
};

type CallExpressionLike = Expression & {
  arguments: Node[];
  callee: Expression;
  type: 'CallExpression';
};

type SequenceExpressionLike = Expression & {
  expressions: Expression[];
  type: 'SequenceExpression';
};

type LocationLookup = (offset: number) => SourceLocation['start'];

type TopLevelStatementInfo = {
  bindings: Set<string>;
  node: Node;
  references: Set<string>;
};

type ScopedBindingKind = 'function' | 'import' | 'param' | 'variable';

type ScopedBindingInfo = {
  declaration: Node;
  dependencies: Set<string>;
  externalReferences: number;
  id: string;
  incomingFromBindings: Set<string>;
  kind: ScopedBindingKind;
  name: string;
};

type ScopedCleanupScope = {
  bindings: Map<string, string>;
  parent: ScopedCleanupScope | null;
};

let didWarnSkipSymbolMismatch = false;
const GENERATED_HELPER_NAME_RE = /^_exp\d*$/;

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

const parseOxc = (code: string, filename: string): Program => {
  return parseOxcProgramCached(filename, code, 'module');
};

const visit = (
  node: Node,
  enter: (node: Node, parent: Node | null) => void,
  parent: Node | null = null
): void => {
  enter(node, parent);
  getChildren(node).forEach((child) => visit(child, enter, node));
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

const insertAddedImports = (
  code: string,
  program: Program,
  addedImports: AddedImport[]
): string => {
  if (addedImports.length === 0) {
    return code;
  }

  const uniqueImports = [
    ...new Map(
      addedImports.map((item) => [
        `${item.source}\0${item.imported}\0${item.local}`,
        item,
      ])
    ).values(),
  ];
  const importBlock = uniqueImports.map(printOxcAstServiceImport).join('\n');
  const lastImport = [...program.body]
    .reverse()
    .find((statement) => statement.type === 'ImportDeclaration');
  const hashbangEnd = code.startsWith('#!')
    ? (() => {
        const newline = code.indexOf('\n');
        return newline === -1 ? code.length : newline + 1;
      })()
    : 0;
  const insertionPoint = lastImport?.end ?? hashbangEnd;
  const prefix = code.slice(0, insertionPoint);
  const suffix = code.slice(insertionPoint);
  const leadingBreak = prefix.length > 0 && !prefix.endsWith('\n') ? '\n' : '';
  const trailingBreak = suffix.length > 0 && !suffix.startsWith('\n') ? '\n' : '';

  return `${prefix}${leadingBreak}${importBlock}${trailingBreak}${suffix}`;
};

const createLocationLookup = (code: string): LocationLookup => {
  const lineStarts = [0];
  for (let idx = 0; idx < code.length; idx += 1) {
    if (code[idx] === '\n') {
      lineStarts.push(idx + 1);
    }
  }

  return (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const next = lineStarts[mid + 1] ?? Infinity;
      if (lineStarts[mid] <= offset && offset < next) {
        return {
          column: offset - lineStarts[mid],
          line: mid + 1,
        };
      }

      if (offset < lineStarts[mid]) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    const lastLine = lineStarts.length - 1;
    return {
      column: Math.max(0, offset - lineStarts[lastLine]),
      line: lastLine + 1,
    };
  };
};

const getSourceLocation = (
  start: number,
  end: number,
  loc: LocationLookup,
  filename?: string | null
): SourceLocation => ({
  end: loc(end),
  filename: filename ?? undefined,
  start: loc(start),
});

const buildCodeFrameError = (
  code: string,
  location: SourceLocation,
  message: string
): Error => {
  const lines = code.split('\n');
  const startLine = location.start.line;
  const endLine = location.end.line;
  const frameStart = Math.max(1, startLine - 2);
  const frameEnd = Math.min(lines.length, endLine + 2);
  const lineNoWidth = String(frameEnd).length;
  const frame: string[] = [];

  for (let lineNo = frameStart; lineNo <= frameEnd; lineNo += 1) {
    const marker = lineNo === startLine ? '>' : ' ';
    const line = lines[lineNo - 1] ?? '';
    frame.push(
      line.length > 0
        ? `${marker} ${String(lineNo).padStart(lineNoWidth)} | ${line}`
        : `${marker} ${String(lineNo).padStart(lineNoWidth)} |`
    );

    if (lineNo === startLine) {
      const pointerLength =
        startLine === endLine
          ? Math.max(1, location.end.column - location.start.column)
          : 1;
      frame.push(
        `  ${' '.repeat(lineNoWidth)} | ${' '.repeat(
          location.start.column
        )}${'^'.repeat(pointerLength)}`
      );
    }
  }

  const prefix = location.filename ? `${location.filename}: ` : '';
  return new Error(`${prefix}${message}\n${frame.join('\n')}`);
};

const collectUsedNames = (program: Program): Set<string> => {
  const names = new Set<string>();
  visit(program, (node) => {
    if (node.type === 'Identifier') {
      names.add(node.name);
    }
  });

  return names;
};

const isNodeReference = (node: Node, parent: Node | null): boolean => {
  if (node.type === 'Identifier') {
    const parentRecord = parent as AnyNode | null;

    if (!parentRecord) {
      return true;
    }

    if (
      parent?.type === 'ImportDeclaration' ||
      parent?.type === 'ImportSpecifier' ||
      parent?.type === 'ImportDefaultSpecifier' ||
      parent?.type === 'ImportNamespaceSpecifier'
    ) {
      return false;
    }

    if (
      parent?.type === 'MemberExpression' &&
      parentRecord.property === node &&
      !parentRecord.computed
    ) {
      return false;
    }

    if (
      (parent?.type === 'VariableDeclarator' ||
        parent?.type === 'FunctionDeclaration' ||
        parent?.type === 'ClassDeclaration' ||
        parent?.type === 'ClassExpression') &&
      parentRecord.id === node
    ) {
      return false;
    }

    if (
      (parent?.type === 'PropertyDefinition' ||
        parent?.type === 'MethodDefinition') &&
      parentRecord.key === node &&
      !parentRecord.computed
    ) {
      return false;
    }

    if (
      parent?.type === 'Property' &&
      parentRecord.key === node &&
      parentRecord.value !== node &&
      !parentRecord.computed
    ) {
      return false;
    }

    return true;
  }

  if (node.type === 'JSXIdentifier') {
    const parentRecord = parent as AnyNode | null;
    if (parent?.type === 'JSXAttribute' && parentRecord?.name === node) {
      return false;
    }

    return true;
  }

  return false;
};

const collectReferencedNames = (root: Node): Set<string> => {
  const names = new Set<string>();

  const walk = (node: Node, parent: Node | null = null): void => {
    if (node.type === 'ImportDeclaration') {
      return;
    }

    if (
      isNodeReference(node, parent) &&
      'name' in node &&
      typeof node.name === 'string'
    ) {
      names.add(node.name);
    }

    getChildren(node).forEach((child) => walk(child, node));
  };

  walk(root);
  return names;
};

const collectImportLocalNames = (node: Node): string[] => {
  if (node.type !== 'ImportDeclaration') {
    return [];
  }

  const specifiers = (node as AnyNode).specifiers;
  if (!Array.isArray(specifiers)) {
    return [];
  }

  return specifiers
    .map((specifier) => {
      const local = (specifier as AnyNode).local;
      return isNode(local) && 'name' in local && typeof local.name === 'string'
        ? local.name
        : null;
    })
    .filter(isNotNull);
};

const getImportSpecifierLocalName = (node: Node): string | null => {
  const local = (node as AnyNode).local;
  return isNode(local) && 'name' in local && typeof local.name === 'string'
    ? local.name
    : null;
};

const collectDeclaredNames = (node: Node): string[] => {
  if (node.type === 'Identifier') {
    return [node.name];
  }

  if (node.type === 'RestElement') {
    return collectDeclaredNames(node.argument);
  }

  if (node.type === 'AssignmentPattern') {
    return collectDeclaredNames(node.left);
  }

  if (node.type === 'ObjectPattern') {
    return node.properties.flatMap((property) =>
      property.type === 'RestElement'
        ? collectDeclaredNames(property.argument)
        : collectDeclaredNames(property.value)
    );
  }

  if (node.type === 'ArrayPattern') {
    return node.elements.flatMap((element) =>
      element ? collectDeclaredNames(element) : []
    );
  }

  if (node.type === 'TSParameterProperty') {
    return collectDeclaredNames(node.parameter);
  }

  return [];
};

const collectTopLevelBindings = (statement: Node): Set<string> => {
  const bindings = new Set<string>();

  if (statement.type === 'ImportDeclaration') {
    collectImportLocalNames(statement).forEach((name) => bindings.add(name));
    return bindings;
  }

  if (statement.type === 'VariableDeclaration') {
    const declarations = (statement as AnyNode).declarations;
    if (!Array.isArray(declarations)) {
      return bindings;
    }

    declarations.forEach((declarator) => {
      const id = (declarator as AnyNode).id;
      if (isNode(id)) {
        collectDeclaredNames(id).forEach((name) => bindings.add(name));
      }
    });
    return bindings;
  }

  if (
    (statement.type === 'FunctionDeclaration' ||
      statement.type === 'ClassDeclaration' ||
      statement.type === 'TSEnumDeclaration') &&
    'id' in statement
  ) {
    const id = (statement as AnyNode).id;
    if (isNode(id) && id.type === 'Identifier') {
      bindings.add(id.name);
    }
    return bindings;
  }

  if (statement.type === 'ExportNamedDeclaration') {
    const declaration = (statement as AnyNode).declaration;
    return isNode(declaration) ? collectTopLevelBindings(declaration) : bindings;
  }

  return bindings;
};

const collectTopLevelStatementInfos = (program: Program): TopLevelStatementInfo[] =>
  program.body.map((statement) => ({
    bindings: collectTopLevelBindings(statement),
    node: statement,
    references: collectReferencedNames(statement),
  }));

const collectTopLevelBindingsFromStatements = (
  statements: TopLevelStatementInfo[]
): Set<string> => new Set(statements.flatMap((statement) => [...statement.bindings]));

const collectRemovableNamesFromStatements = (
  statements: TopLevelStatementInfo[],
  initialNames: Set<string>
): Set<string> => {
  const removable = new Set(initialNames);
  const bindingToStatement = new Map<string, TopLevelStatementInfo>();

  statements.forEach((statement) => {
    statement.bindings.forEach((name) => {
      bindingToStatement.set(name, statement);
    });
  });

  const queue = [...removable];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const statement = bindingToStatement.get(name);
    if (!statement) {
      continue;
    }

    statement.references.forEach((reference) => {
      if (bindingToStatement.has(reference) && !removable.has(reference)) {
        removable.add(reference);
        queue.push(reference);
      }
    });
  }

  return removable;
};

const createScopedCleanupScope = (
  parent: ScopedCleanupScope | null
): ScopedCleanupScope => ({
  bindings: new Map(),
  parent,
});

const resolveScopedBinding = (
  scope: ScopedCleanupScope,
  name: string
): string | null => {
  let current: ScopedCleanupScope | null = scope;
  while (current) {
    const bindingId = current.bindings.get(name);
    if (bindingId) {
      return bindingId;
    }

    current = current.parent;
  }

  return null;
};

const collectScopedBindingInfos = (
  program: Program
): Map<string, ScopedBindingInfo> => {
  const bindings = new Map<string, ScopedBindingInfo>();
  let sequence = 0;

  const addBinding = (
    scope: ScopedCleanupScope,
    name: string,
    kind: ScopedBindingKind,
    declaration: Node
  ): string => {
    const id = `${kind}:${name}:${declaration.start}:${sequence}`;
    sequence += 1;

    bindings.set(id, {
      declaration,
      dependencies: new Set(),
      externalReferences: 0,
      id,
      incomingFromBindings: new Set(),
      kind,
      name,
    });
    scope.bindings.set(name, id);
    return id;
  };

  const addPatternBindings = (
    scope: ScopedCleanupScope,
    pattern: Node,
    kind: ScopedBindingKind,
    declaration: Node
  ): void => {
    collectDeclaredNames(pattern).forEach((name) => {
      addBinding(scope, name, kind, declaration);
    });
  };

  const recordReference = (
    scope: ScopedCleanupScope,
    name: string,
    ownerBindingId: string | null
  ): void => {
    const targetId = resolveScopedBinding(scope, name);
    if (!targetId) {
      return;
    }

    const target = bindings.get(targetId);
    if (!target) {
      return;
    }

    if (ownerBindingId && ownerBindingId !== targetId) {
      target.incomingFromBindings.add(ownerBindingId);
      bindings.get(ownerBindingId)?.dependencies.add(targetId);
      return;
    }

    target.externalReferences += 1;
  };

  const walkPatternReferenceSubexpressions = (
    node: Node,
    scope: ScopedCleanupScope,
    ownerBindingId: string | null
  ): void => {
    if (node.type === 'Identifier') {
      return;
    }

    if (node.type === 'TSParameterProperty') {
      walkPatternReferenceSubexpressions(node.parameter, scope, ownerBindingId);
      return;
    }

    if (node.type === 'RestElement') {
      walkPatternReferenceSubexpressions(node.argument, scope, ownerBindingId);
      return;
    }

    if (node.type === 'AssignmentPattern') {
      walkPatternReferenceSubexpressions(node.left, scope, ownerBindingId);
      walk(node.right, scope, node, ownerBindingId);
      return;
    }

    if (node.type === 'ObjectPattern') {
      node.properties.forEach((property) => {
        if (property.type === 'RestElement') {
          walkPatternReferenceSubexpressions(
            property.argument,
            scope,
            ownerBindingId
          );
          return;
        }

        if (property.computed && isNode(property.key)) {
          walk(property.key, scope, property, ownerBindingId);
        }

        walkPatternReferenceSubexpressions(
          property.value,
          scope,
          ownerBindingId
        );
      });
      return;
    }

    if (node.type === 'ArrayPattern') {
      node.elements.forEach((element) => {
        if (element && isNode(element)) {
          walkPatternReferenceSubexpressions(element, scope, ownerBindingId);
        }
      });
    }
  };

  const walk = (
    node: Node,
    scope: ScopedCleanupScope,
    parent: Node | null = null,
    ownerBindingId: string | null = null
  ): void => {
    if (node.type === 'ImportDeclaration') {
      const specifiers = (node as AnyNode).specifiers;
      if (Array.isArray(specifiers)) {
        specifiers.forEach((specifier) => {
          const local = (specifier as AnyNode).local;
          if (
            isNode(local) &&
            local.type === 'Identifier' &&
            typeof local.name === 'string'
          ) {
            addBinding(scope, local.name, 'import', node);
          }
        });
      }
      return;
    }

    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      walk(node.declaration, scope, node, ownerBindingId);
      collectTopLevelBindings(node).forEach((name) => {
        recordReference(scope, name, ownerBindingId);
      });
      return;
    }

    if (node.type === 'ExportDefaultDeclaration') {
      const declaration = (node as AnyNode).declaration;
      if (isNode(declaration)) {
        walk(declaration, scope, node, ownerBindingId);
        if (
          (declaration.type === 'FunctionDeclaration' ||
            declaration.type === 'ClassDeclaration') &&
          declaration.id
        ) {
          recordReference(scope, declaration.id.name, ownerBindingId);
        }
      }
      return;
    }

    if (node.type === 'VariableDeclaration') {
      const declarations = (node as AnyNode).declarations;
      if (!Array.isArray(declarations)) {
        return;
      }

      declarations.forEach((declarator) => {
        const id = (declarator as AnyNode).id;
        if (isNode(id)) {
          addPatternBindings(scope, id, 'variable', node);
        }
      });

      declarations.forEach((declarator) => {
        const id = (declarator as AnyNode).id;
        const init = (declarator as AnyNode).init;
        if (!isNode(id) || !isNode(init)) {
          return;
        }

        const ownerName = collectDeclaredNames(id)[0] ?? null;
        const nextOwner =
          ownerName !== null ? resolveScopedBinding(scope, ownerName) : null;
        walk(init, scope, declarator as Node, nextOwner);
      });
      return;
    }

    if (node.type === 'FunctionDeclaration' && node.id) {
      const functionBindingId = addBinding(scope, node.id.name, 'function', node);
      const fnScope = createScopedCleanupScope(scope);

      node.params.forEach((param) => {
        addPatternBindings(fnScope, param, 'param', param);
        walkPatternReferenceSubexpressions(
          param,
          fnScope,
          functionBindingId
        );
      });

      if (node.body) {
        walk(node.body, fnScope, node, functionBindingId);
      }
      return;
    }

    if (
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const fnScope = createScopedCleanupScope(scope);
      if (node.type === 'FunctionExpression' && node.id) {
        addBinding(fnScope, node.id.name, 'function', node);
      }

      node.params.forEach((param) => {
        addPatternBindings(fnScope, param, 'param', param);
        walkPatternReferenceSubexpressions(param, fnScope, ownerBindingId);
      });

      if (node.body) {
        walk(node.body, fnScope, node, ownerBindingId);
      }
      return;
    }

    if (node.type === 'BlockStatement') {
      const blockScope = createScopedCleanupScope(scope);
      getChildren(node).forEach((child) => walk(child, blockScope, node, ownerBindingId));
      return;
    }

    if (
      isNodeReference(node, parent) &&
      'name' in node &&
      typeof node.name === 'string'
    ) {
      recordReference(scope, node.name, ownerBindingId);
    }

    getChildren(node).forEach((child) => walk(child, scope, node, ownerBindingId));
  };

  walk(program, createScopedCleanupScope(null));
  return bindings;
};

const collectScopedRemovableBindingIds = (
  bindings: Map<string, ScopedBindingInfo>,
  initialNames: Set<string>
): Set<string> => {
  const removable = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;

    bindings.forEach((binding) => {
      if (
        removable.has(binding.id) ||
        binding.kind === 'import' ||
        binding.kind === 'param' ||
        binding.externalReferences > 0
      ) {
        return;
      }

      const seededByName =
        initialNames.has(binding.name) ||
        (GENERATED_HELPER_NAME_RE.test(binding.name) &&
          binding.incomingFromBindings.size === 0);
      const allIncomingRemovable =
        binding.incomingFromBindings.size > 0 &&
        [...binding.incomingFromBindings].every((sourceId) =>
          removable.has(sourceId)
        );

      if (
        (seededByName && binding.incomingFromBindings.size === 0) ||
        allIncomingRemovable
      ) {
        removable.add(binding.id);
        changed = true;
      }
    });
  }

  return removable;
};

const collectUnusedScopedDeclarationRemovals = (
  code: string,
  bindings: Map<string, ScopedBindingInfo>,
  initialRemovableNames: Set<string>
): Replacement[] => {
  const removableBindingIds = collectScopedRemovableBindingIds(
    bindings,
    initialRemovableNames
  );
  const removals = new Map<string, Replacement>();

  bindings.forEach((binding) => {
    if (
      !removableBindingIds.has(binding.id) ||
      binding.kind === 'import' ||
      binding.kind === 'param' ||
      binding.externalReferences > 0 ||
      [...binding.incomingFromBindings].some(
        (sourceId) => !removableBindingIds.has(sourceId)
      )
    ) {
      return;
    }

    if (
      binding.kind === 'function' &&
      binding.declaration.type === 'FunctionDeclaration'
    ) {
      const range = expandImportRemovalRange(
        code,
        binding.declaration.start,
        binding.declaration.end
      );
      removals.set(`${range.start}:${range.end}`, range);
      return;
    }

    if (binding.declaration.type !== 'VariableDeclaration') {
      return;
    }

    const declarations = (binding.declaration as AnyNode).declarations;
    if (!Array.isArray(declarations) || declarations.length !== 1) {
      return;
    }

    const range = expandImportRemovalRange(
      code,
      binding.declaration.start,
      binding.declaration.end
    );
    removals.set(`${range.start}:${range.end}`, range);
  });

  return [...removals.values()];
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

const collectUnusedImportRemovals = (
  code: string,
  program: Program,
  referencedNames: Set<string>,
  removableNames: Set<string>
): Replacement[] => {
  const removals: Replacement[] = [];

  program.body.forEach((statement) => {
    if (statement.type !== 'ImportDeclaration') {
      return;
    }

    const localNames = collectImportLocalNames(statement);
    const removableLocalNames = localNames.filter((localName) =>
      removableNames.has(localName)
    );
    if (
      removableLocalNames.length > 0 &&
      removableLocalNames.length === localNames.length &&
      removableLocalNames.every((localName) => !referencedNames.has(localName))
    ) {
      removals.push(
        expandImportRemovalRange(code, statement.start, statement.end)
      );
      return;
    }

    const specifiers = (statement as AnyNode).specifiers;
    if (!Array.isArray(specifiers) || specifiers.length <= 1) {
      return;
    }

    specifiers.forEach((specifier) => {
      if (!isNode(specifier)) {
        return;
      }

      const localName = getImportSpecifierLocalName(specifier);
      if (
        localName &&
        removableNames.has(localName) &&
        !referencedNames.has(localName)
      ) {
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

  return removals;
};

const collectUnusedTopLevelDeclarationRemovals = (
  code: string,
  program: Program,
  referencedNames: Set<string>,
  removableNames: Set<string>
): Replacement[] => {
  const removals: Replacement[] = [];

  program.body.forEach((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return;
    }

    const localNames = [...collectTopLevelBindings(statement)];

    if (
      localNames.length > 0 &&
      localNames.every((localName) => removableNames.has(localName)) &&
      localNames.every((localName) => !referencedNames.has(localName))
    ) {
      removals.push(
        expandImportRemovalRange(code, statement.start, statement.end)
      );
    }
  });

  return removals;
};

const collectUnusedGeneratedHelperDeclarationRemovals = (
  code: string,
  program: Program,
  referencedNames: Set<string>
): Replacement[] => {
  const removals: Replacement[] = [];

  program.body.forEach((statement) => {
    if (statement.type !== 'VariableDeclaration') {
      return;
    }

    const localNames = [...collectTopLevelBindings(statement)];
    if (
      localNames.length > 0 &&
      localNames.every((localName) => GENERATED_HELPER_NAME_RE.test(localName)) &&
      localNames.every((localName) => !referencedNames.has(localName))
    ) {
      removals.push(
        expandImportRemovalRange(code, statement.start, statement.end)
      );
    }
  });

  return removals;
};

const collectTopLevelExpressionStatementRemovals = (
  code: string,
  statements: TopLevelStatementInfo[],
  topLevelBindings: Set<string>,
  removableExpressionRefs: Set<string>
): Replacement[] => {
  const removals: Replacement[] = [];

  statements.forEach((statement) => {
    if (statement.node.type !== 'ExpressionStatement') {
      return;
    }

    const expression = statement.node.expression;
    const isPureExpression =
      expression.type === 'Identifier' ||
      expression.type === 'Literal' ||
      expression.type === 'ObjectExpression' ||
      expression.type === 'ArrayExpression' ||
      expression.type === 'ArrowFunctionExpression' ||
      expression.type === 'FunctionExpression' ||
      (expression.type === 'TemplateLiteral' &&
        expression.expressions.length === 0);
    if (!isPureExpression) {
      return;
    }

    const localReferences = [...statement.references].filter((name) =>
      topLevelBindings.has(name)
    );

    if (
      localReferences.length > 0 &&
      localReferences.every((name) => removableExpressionRefs.has(name))
    ) {
      removals.push(
        expandImportRemovalRange(
          code,
          statement.node.start,
          statement.node.end
        )
      );
    }
  });

  return removals;
};

const collectEmptyTopLevelBlockRemovals = (
  code: string,
  program: Program
): Replacement[] => {
  const removals: Replacement[] = [];

  program.body.forEach((statement) => {
    if (statement.type !== 'BlockStatement' || statement.body.length > 0) {
      return;
    }

    removals.push(expandImportRemovalRange(code, statement.start, statement.end));
  });

  return removals;
};

const removeUnusedAfterReplacement = (
  code: string,
  filename: string,
  initialRemovableNames: Set<string>,
  removableExpressionRefs: Set<string>
): string => {
  let current = code;
  const cumulativeRemovableNames = new Set(initialRemovableNames);
  const applyIfParsable = (next: string): string => {
    try {
      parseOxc(next, filename);
      return next;
    } catch {
      return current;
    }
  };

  for (let idx = 0; idx < 5; idx += 1) {
    const previous = current;
    const program = parseOxc(current, filename);
    const statements = collectTopLevelStatementInfos(program);
    const removableNames = collectRemovableNamesFromStatements(
      statements,
      cumulativeRemovableNames
    );
    removableNames.forEach((name) => cumulativeRemovableNames.add(name));
    const referencedNames = collectReferencedNames(program);
    const topLevelBindings = collectTopLevelBindingsFromStatements(statements);
    const scopedBindings = collectScopedBindingInfos(program);
    const removals = mergeEmptyRemovalRanges([
      ...collectUnusedScopedDeclarationRemovals(
        current,
        scopedBindings,
        cumulativeRemovableNames
      ),
      ...collectUnusedTopLevelDeclarationRemovals(
        current,
        program,
        referencedNames,
        cumulativeRemovableNames
      ),
      ...collectUnusedGeneratedHelperDeclarationRemovals(
        current,
        program,
        referencedNames
      ),
      ...collectUnusedImportRemovals(
        current,
        program,
        referencedNames,
        cumulativeRemovableNames
      ),
      ...collectTopLevelExpressionStatementRemovals(
        current,
        statements,
        topLevelBindings,
        removableExpressionRefs
      ),
      ...collectEmptyTopLevelBlockRemovals(current, program),
    ]);
    current =
      removals.length > 0
        ? applyIfParsable(applyReplacements(current, removals))
        : current;

    if (current === previous) {
      return current;
    }
  }

  return current;
};

const getMemberName = (node: MemberExpression): string | null => {
  if (node.computed) {
    return node.property.type === 'Literal' &&
      typeof node.property.value === 'string'
      ? node.property.value
      : null;
  }

  return node.property.type === 'Identifier' ? node.property.name : null;
};

const unwrapQualifiedExpression = (node: Expression): Expression => {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'ParenthesizedExpression'
  ) {
    return unwrapQualifiedExpression(
      (node as QualifiedExpression & { expression: Expression }).expression
    );
  }

  if (node.type === 'SequenceExpression') {
    const sequence = node as SequenceExpressionLike;
    return unwrapQualifiedExpression(
      sequence.expressions[sequence.expressions.length - 1] ?? node
    );
  }

  return node;
};

const getRootIdentifier = (node: Expression): OxcIdentifier | null => {
  const expression = unwrapQualifiedExpression(node);

  if (expression.type === 'Identifier') {
    return expression;
  }

  if (expression.type === 'MemberExpression') {
    return getRootIdentifier(expression.object);
  }

  if (expression.type === 'CallExpression') {
    return getRootIdentifier((expression as CallExpressionLike).callee);
  }

  return null;
};

const getQualifiedName = (node: Expression): string | null => {
  const expression = unwrapQualifiedExpression(node);

  if (expression.type === 'Identifier') {
    return expression.name;
  }

  if (expression.type === 'MemberExpression') {
    const object = getQualifiedName(expression.object);
    const member = getMemberName(expression);
    return object && member ? `${object}.${member}` : null;
  }

  if (expression.type === 'CallExpression') {
    return getQualifiedName((expression as CallExpressionLike).callee);
  }

  return null;
};

const resolveDefinedProcessor = (
  callee: Expression,
  definedProcessors: Map<string, DefinedProcessor>
): {
  collapseQualifiedCallee: boolean;
  definedProcessor: DefinedProcessor;
} | null => {
  const qualified = getQualifiedName(callee);
  if (qualified) {
    const definedProcessor = definedProcessors.get(qualified);
    if (definedProcessor) {
      return {
        collapseQualifiedCallee: qualified.includes('.'),
        definedProcessor,
      };
    }
  }

  const root = getRootIdentifier(callee);
  if (!root) {
    return null;
  }

  const definedProcessor = definedProcessors.get(root.name);
  return definedProcessor
    ? {
        collapseQualifiedCallee: false,
        definedProcessor,
      }
    : null;
};

const isCallTagOfTaggedTemplate = (node: Node, parent: Node | null): boolean =>
  parent?.type === 'TaggedTemplateExpression' && parent.tag === node;

const expandReplacementTarget = (
  target: Expression,
  ancestors: Node[]
): Expression => {
  let current: Expression = target;

  for (let idx = ancestors.length - 1; idx >= 0; idx -= 1) {
    const ancestor = ancestors[idx];
    if (
      ancestor.type === 'SequenceExpression' &&
      ancestor.expressions[ancestor.expressions.length - 1] === current
    ) {
      current = ancestor as Expression;
      continue;
    }

    if (
      ancestor.type === 'ParenthesizedExpression' &&
      ancestor.expression === current
    ) {
      current = ancestor as Expression;
      continue;
    }

    break;
  }

  return current;
};

const collectProcessorUsages = (
  program: Program,
  definedProcessors: Map<string, DefinedProcessor>
): ProcessorUsage[] => {
  const usages: ProcessorUsage[] = [];

  const walk = (
    node: Node,
    ancestors: Node[],
    parent: Node | null = null
  ): void => {
    if (node.type === 'TaggedTemplateExpression') {
      const callee = node.tag as Expression;
      const resolvedProcessor = resolveDefinedProcessor(
        callee,
        definedProcessors
      );
      if (resolvedProcessor) {
        usages.push({
          ancestors,
          callee,
          collapseQualifiedCallee: resolvedProcessor.collapseQualifiedCallee,
          definedProcessor: resolvedProcessor.definedProcessor,
          kind: 'template',
          replacementTarget: expandReplacementTarget(node, ancestors),
          target: node,
        });
      }
    } else if (
      node.type === 'CallExpression' &&
      !isCallTagOfTaggedTemplate(node, parent)
    ) {
      const { callee } = node as CallExpressionLike;
      const resolvedProcessor = resolveDefinedProcessor(
        callee,
        definedProcessors
      );
      if (resolvedProcessor) {
        usages.push({
          ancestors,
          callee,
          collapseQualifiedCallee: resolvedProcessor.collapseQualifiedCallee,
          definedProcessor: resolvedProcessor.definedProcessor,
          kind: 'call',
          replacementTarget: expandReplacementTarget(
            node as CallExpression,
            ancestors
          ),
          target: node as CallExpression,
        });
      }
    }

    getChildren(node).forEach((child) =>
      walk(child, [...ancestors, node], node)
    );
  };

  walk(program, []);

  return usages.sort((a, b) => a.target.start - b.target.start);
};

const expressionSpan = (expression: Expression): ExpressionSpan => ({
  end: expression.end,
  start: expression.start,
});

const collectCallArgumentSpans = (node: Expression): ExpressionSpan[] => {
  const expression = unwrapQualifiedExpression(node);

  if (expression.type === 'CallExpression') {
    const call = expression as CallExpressionLike;
    const calleeSpans = collectCallArgumentSpans(call.callee);
    const argumentSpans = call.arguments.flatMap((arg) =>
      arg.type === 'SpreadElement' ? [] : [expressionSpan(arg as Expression)]
    );
    return [...calleeSpans, ...argumentSpans];
  }

  if (expression.type === 'MemberExpression') {
    return collectCallArgumentSpans(expression.object);
  }

  return [];
};

const collectUsageExpressionSpans = (
  usage: ProcessorUsage
): ExpressionSpan[] => {
  const calleeSpans = collectCallArgumentSpans(usage.callee);
  if (usage.kind === 'template') {
    return [
      ...calleeSpans,
      ...usage.target.quasi.expressions.map((expression) =>
        expressionSpan(expression as Expression)
      ),
    ];
  }

  return [
    ...calleeSpans,
    ...usage.target.arguments.flatMap((arg) =>
      arg.type === 'SpreadElement' ? [] : [expressionSpan(arg as Expression)]
    ),
  ];
};

const literalExpressionValue = (
  expression: Expression,
  code: string,
  source: string,
  location: SourceLocation
): ExpressionValue | null => {
  if (expression.type !== 'Literal') {
    return null;
  }

  if (
    expression.value === null ||
    typeof expression.value === 'string' ||
    typeof expression.value === 'number' ||
    typeof expression.value === 'boolean'
  ) {
    let type:
      | 'BooleanLiteral'
      | 'NullLiteral'
      | 'NumericLiteral'
      | 'StringLiteral';
    if (expression.value === null) {
      type = 'NullLiteral';
    } else if (typeof expression.value === 'string') {
      type = 'StringLiteral';
    } else if (typeof expression.value === 'number') {
      type = 'NumericLiteral';
    } else {
      type = 'BooleanLiteral';
    }

    const ex =
      expression.value === null
        ? { loc: location, type }
        : {
            loc: location,
            type,
            value: expression.value,
          };

    return {
      buildCodeFrameError: (message: string) =>
        buildCodeFrameError(code, location, message),
      ex,
      kind: ValueType.CONST,
      source,
      value: expression.value,
    } as ExpressionValue;
  }

  return null;
};

const expressionValue = (
  expression: Expression,
  code: string,
  loc: LocationLookup,
  filename?: string | null
): ExpressionValue => {
  const source = code.slice(expression.start, expression.end);
  const location = getSourceLocation(
    expression.start,
    expression.end,
    loc,
    filename
  );
  const literal = literalExpressionValue(expression, code, source, location);
  if (literal) {
    return literal;
  }

  const helperCallName =
    expression.type === 'CallExpression' &&
    expression.arguments.length === 0 &&
    expression.callee.type === 'Identifier' &&
    GENERATED_HELPER_NAME_RE.test(expression.callee.name)
      ? expression.callee.name
      : null;

  return {
    buildCodeFrameError: (message: string) =>
      buildCodeFrameError(code, location, message),
    ex:
      expression.type === 'Identifier'
        ? { loc: location, name: expression.name, type: 'Identifier' }
        : helperCallName
          ? { loc: location, name: helperCallName, type: 'Identifier' }
        : {
            loc: location,
            name: code.slice(expression.start, expression.end),
            type: 'Identifier',
          },
    kind:
      expression.type === 'ArrowFunctionExpression' ||
      expression.type === 'FunctionExpression'
        ? ValueType.FUNCTION
        : ValueType.LAZY,
    source,
  } as ExpressionValue;
};

const withCurrentExpressionLocation = (
  value: ExpressionValue,
  expression: Expression,
  loc: LocationLookup,
  filename?: string | null
): ExpressionValue => {
  const location = getSourceLocation(
    expression.start,
    expression.end,
    loc,
    filename
  );

  if (value.kind === ValueType.CONST) {
    return {
      ...value,
      ex: {
        ...value.ex,
        loc: location,
      },
    };
  }

  if (value.kind === ValueType.FUNCTION) {
    return {
      ...value,
      ex: {
        ...value.ex,
        loc: location,
      },
    };
  }

  return {
    ...value,
    ex: {
      ...value.ex,
      loc: location,
    },
  };
};

const shiftExpressionValue = (
  expressionValues: ExpressionValue[],
  expression: Expression,
  code: string,
  loc: LocationLookup,
  filename?: string | null
): ExpressionValue =>
  expressionValues.length > 0
    ? withCurrentExpressionLocation(
        expressionValues.shift()!,
        expression,
        loc,
        filename
      )
    : expressionValue(expression, code, loc, filename);

const zipTemplate = (
  template: TaggedTemplateExpression,
  code: string,
  loc: LocationLookup,
  filename: string | null | undefined,
  expressionValues: ExpressionValue[]
): Param => {
  const parts = template.quasi.quasis.flatMap((quasi, idx) => {
    const expression = template.quasi.expressions[idx];
    const templateElement = {
      ...quasi,
      loc: getSourceLocation(quasi.start, quasi.end, loc, filename),
    };

    return [
      templateElement,
      expression
        ? shiftExpressionValue(
            expressionValues,
            expression as Expression,
            code,
            loc,
            filename
          )
        : null,
    ].filter(isNotNull);
  });

  return ['template', parts] as Param;
};

const buildCalleeParams = (
  node: Expression,
  code: string,
  loc: LocationLookup,
  filename: string | null | undefined,
  expressionValues: ExpressionValue[],
  collapseQualifiedCallee = false
): Params | null => {
  const expression = unwrapQualifiedExpression(node);

  if (
    collapseQualifiedCallee &&
    (expression.type === 'Identifier' || expression.type === 'MemberExpression')
  ) {
    return [['callee', expression] as Param];
  }

  if (expression.type === 'Identifier') {
    return [['callee', { name: expression.name, type: 'Identifier' }]];
  }

  if (expression.type === 'MemberExpression') {
    const params = buildCalleeParams(
      expression.object,
      code,
      loc,
      filename,
      expressionValues,
      collapseQualifiedCallee
    );
    const member = getMemberName(expression);
    return params && member ? [...params, ['member', member]] : null;
  }

  if (expression.type === 'CallExpression') {
    const call = expression as CallExpressionLike;
    const params = buildCalleeParams(
      call.callee,
      code,
      loc,
      filename,
      expressionValues,
      collapseQualifiedCallee
    );
    if (!params) {
      return null;
    }

    const callValues = call.arguments
      .filter((arg) => arg.type !== 'SpreadElement')
      .map((arg) =>
        shiftExpressionValue(
          expressionValues,
          arg as Expression,
          code,
          loc,
          filename
        )
      );

    return [...params, ['call', ...callValues]];
  }

  return null;
};

const buildParams = (
  usage: ProcessorUsage,
  code: string,
  loc: LocationLookup,
  filename: string | null | undefined,
  expressionValues: ExpressionValue[],
  collapseQualifiedCallee: boolean
): Params | null => {
  const params = buildCalleeParams(
    usage.callee,
    code,
    loc,
    filename,
    expressionValues,
    collapseQualifiedCallee
  );
  if (!params) {
    return null;
  }

  if (usage.kind === 'template') {
    return [
      ...params,
      zipTemplate(usage.target, code, loc, filename, expressionValues),
    ];
  }

  const callValues = usage.target.arguments
    .filter((arg) => arg.type !== 'SpreadElement')
    .map((arg) =>
      shiftExpressionValue(
        expressionValues,
        arg as Expression,
        code,
        loc,
        filename
      )
    );

  return [...params, ['call', ...callValues]];
};

const getPropertyKeyName = (property: AnyNode, code: string): string | null => {
  const { key } = property;
  if (!isNode(key)) {
    return null;
  }

  if (key.type === 'Identifier') {
    return key.name;
  }

  if (key.type === 'Literal') {
    return String(key.value);
  }

  return typeof key.start === 'number' && typeof key.end === 'number'
    ? code.slice(key.start, key.end)
    : null;
};

const getDisplayName = (
  ancestors: Node[],
  idx: number,
  code: string,
  filename?: string | null
): string => {
  const owner = [...ancestors].reverse().find((node) => {
    return (
      node.type === 'Property' ||
      node.type === 'JSXOpeningElement' ||
      node.type === 'VariableDeclarator'
    );
  }) as AnyNode | undefined;

  if (owner?.type === 'Property') {
    const keyName = getPropertyKeyName(owner, code);
    if (keyName) {
      return keyName;
    }
  } else if (owner?.type === 'JSXOpeningElement') {
    const { name } = owner;
    if (isNode(name) && name.type === 'JSXIdentifier') {
      return name.name;
    }
  } else if (owner?.type === 'VariableDeclarator') {
    const { id } = owner;
    if (isNode(id) && id.type === 'Identifier') {
      return id.name;
    }
  }

  let displayName = basename(filename ?? 'unknown').replace(/\.[a-z\d]+$/, '');
  if (filename && /^index\.[a-z\d]+$/.test(basename(filename))) {
    displayName = basename(dirname(filename));
  }

  if (!displayName) {
    throw new Error(
      "Couldn't determine a name for the component. Ensure that it's either:\n" +
        '- Assigned to a variable\n' +
        '- Is an object property\n' +
        '- Is a prop in a JSX element\n'
    );
  }

  return `${displayName}${idx}`;
};

const getTagOwner = (ancestors: Node[]): AnyNode | null => {
  const owner = [...ancestors]
    .reverse()
    .find(
      (node) =>
        node.type === 'Property' ||
        node.type === 'JSXOpeningElement' ||
        node.type === 'VariableDeclarator'
    ) as AnyNode | undefined;

  return owner ?? null;
};

const isTagReferenced = (program: Program, ancestors: Node[]): boolean => {
  const owner = getTagOwner(ancestors);
  if (owner?.type !== 'VariableDeclarator') {
    return true;
  }

  const { id } = owner;
  if (!isNode(id) || id.type !== 'Identifier') {
    return true;
  }

  if (ancestors.some((node) => node.type === 'ExportNamedDeclaration')) {
    return true;
  }

  let referenced = false;
  visit(program, (node, parent) => {
    const referenceName =
      node.type === 'Identifier' || node.type === 'JSXIdentifier'
        ? node.name
        : null;

    if (
      referenced ||
      referenceName !== id.name ||
      (node.type === 'Identifier' &&
        node.start === id.start &&
        node.end === id.end)
    ) {
      return;
    }

    referenced = isNodeReference(node, parent);
  });

  return referenced;
};

const isReplacementPure = (replacement: ProcessorExpression): boolean =>
  replacement.type === 'CallExpression';

const createProcessor = (
  definedProcessor: DefinedProcessor,
  params: Params,
  target: Expression,
  replacementTarget: Expression,
  ancestors: Node[],
  fileContext: IFileContext,
  options: Pick<
    StrictOptions,
    'classNameSlug' | 'displayName' | 'extensions' | 'evaluate' | 'tagResolver'
  >,
  code: string,
  loc: LocationLookup,
  idx: number,
  isReferenced: boolean,
  usedNames: Set<string>,
  replacements: Replacement[]
): CreatedProcessor | null => {
  const [Processor, tagSource] = definedProcessor;
  const astService = createOxcAstService(usedNames);

  const replacer = (
    replacement:
      | ProcessorExpression
      | ((tagPath: unknown) => ProcessorExpression),
    isPure: boolean
  ) => {
    const next =
      typeof replacement === 'function' ? replacement(target) : replacement;
    const replacementCode = expressionToCode(next);
    replacements.push({
      start: replacementTarget.start,
      end: replacementTarget.end,
      value:
        isPure && isReplacementPure(next)
          ? `/*#__PURE__*/${replacementCode}`
          : replacementCode,
    });
  };

  try {
    let displayName: string;
    try {
      displayName = getDisplayName(ancestors, idx, code, fileContext.filename);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Couldn't determine a name for the component")
      ) {
        const displayNameNode =
          target.type === 'TaggedTemplateExpression'
            ? target.tag
            : target.type === 'CallExpression'
              ? target.callee
              : target;
        const pointerNode =
          displayNameNode.type === 'MemberExpression'
            ? getRootIdentifier(displayNameNode) ?? displayNameNode
            : displayNameNode;
        throw buildCodeFrameError(
          code,
          getSourceLocation(
            pointerNode.start,
            pointerNode.end,
            loc,
            fileContext.filename
          ),
          error.message
        );
      }
      throw error;
    }

    return {
      astService,
      processor: new Processor(
        params,
        tagSource,
        astService,
        getSourceLocation(target.start, target.end, loc, fileContext.filename),
        replacer,
        displayName,
        isReferenced,
        idx,
        options,
        fileContext
      ),
    };
  } catch (e) {
    if (e === BaseProcessor.SKIP) {
      return null;
    }

    if (
      typeof e === 'symbol' &&
      e.description === BaseProcessor.SKIP.description
    ) {
      if (!didWarnSkipSymbolMismatch) {
        didWarnSkipSymbolMismatch = true;
        // eslint-disable-next-line no-console
        console.warn(
          [
            "[wyw-in-js] Processor threw Symbol('skip') that does not match BaseProcessor.SKIP identity.",
            'This usually means duplicate copies of @wyw-in-js/processor-utils (or the processor) are bundled/installed.',
            'Consider deduping dependencies to avoid subtle issues (instanceof checks, sentinels, etc).',
          ].join('\n')
        );
      }

      return null;
    }

    throw e;
  }
};

export const applyOxcProcessors = (
  code: string,
  fileContext: IFileContext,
  options: Pick<
    StrictOptions,
    'classNameSlug' | 'displayName' | 'extensions' | 'evaluate' | 'tagResolver'
  > & { eventEmitter?: EventEmitter },
  callback: (processor: BaseProcessor) => void,
  cleanupUnused = false
): ApplyOxcProcessorsResult => {
  const filename = fileContext.filename ?? 'unknown.js';
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;
  let workingCode = code;
  let program = parseOxc(workingCode, filename);
  const definedProcessors = new Map<string, DefinedProcessor>();
  const removableImportLocals = new Set<string>();
  const removableExpressionRefs = new Set<string>();

  eventEmitter.perf('transform:preeval:processTemplate:imports', () => {
    const imports = eventEmitter.perf(
      'transform:preeval:processTemplate:imports:analysis',
      () => collectOxcProcessorImportsFromProgram(program, workingCode)
    );

    eventEmitter.perf('transform:preeval:processTemplate:imports:lookup', () => {
      imports.forEach((item) => {
        const localName = item.local.name ?? item.local.code;
        if (item.imported === 'side-effect' || !localName) {
          return;
        }

        const [processor, tagSource] = getProcessorForImport(
          {
            imported: item.imported,
            source: item.source,
          },
          filename,
          options
        );

        if (processor) {
          definedProcessors.set(localName, [processor, tagSource]);
          removableImportLocals.add(localName);
          const rootLocalName = localName.split('.')[0];
          if (rootLocalName) {
            removableImportLocals.add(rootLocalName);
          }
        }
      });
    });
  });

  if (definedProcessors.size === 0) {
    return {
      code: workingCode,
      processors: [],
    };
  }

  let processorUsages = eventEmitter.perf(
    'transform:preeval:processTemplate:usages',
    () => collectProcessorUsages(program, definedProcessors)
  );
  if (processorUsages.length === 0) {
    return {
      code: workingCode,
      processors: [],
    };
  }

  const targetExpressionSpans =
    processorUsages.flatMap(collectUsageExpressionSpans);

  const extracted =
    targetExpressionSpans.length > 0
      ? eventEmitter.perf('transform:preeval:processTemplate:deps', () =>
          collectOxcExpressionDependencies(
            workingCode,
            filename,
            options.evaluate,
            targetExpressionSpans
          )
        )
      : {
          code: workingCode,
          dependencyNames: [],
          expressionValues: [],
        };

  if (extracted.code !== workingCode) {
    workingCode = extracted.code;
    program = eventEmitter.perf(
      'transform:preeval:processTemplate:reparse',
      () => parseOxc(workingCode, filename)
    );
    processorUsages = eventEmitter.perf(
      'transform:preeval:processTemplate:usages',
      () => collectProcessorUsages(program, definedProcessors)
    );
  }

  const templateExpressionValues = extracted.expressionValues.map(
    (value) =>
      ({
        ...value,
        buildCodeFrameError: (message: string) =>
          buildCodeFrameError(code, value.ex.loc!, message),
      }) as ExpressionValue
  );
  const loc = createLocationLookup(workingCode);
  const usedNames = eventEmitter.perf(
    'transform:preeval:processTemplate:usedNames',
    () => collectUsedNames(program)
  );
  const addedImports: AddedImport[] = [];
  const replacements: Replacement[] = [];
  const processors: BaseProcessor[] = [];
  extracted.dependencyNames.forEach((name: string) =>
    removableImportLocals.add(name)
  );

  eventEmitter.perf('transform:preeval:processTemplate:processors', () => {
    processorUsages.forEach((usage, idx) => {
      const params = buildParams(
        usage,
        workingCode,
        loc,
        filename,
        templateExpressionValues,
        usage.collapseQualifiedCallee
      );
      if (!params) {
        return;
      }

      const created = createProcessor(
        usage.definedProcessor,
        params,
        usage.target,
        usage.replacementTarget,
        usage.ancestors,
        fileContext,
        options,
        workingCode,
        loc,
        idx,
        isTagReferenced(program, usage.ancestors),
        usedNames,
        replacements
      );

      if (!created) {
        return;
      }

      const { astService, processor } = created;

      const owner = getTagOwner(usage.ancestors);
      if (owner?.type === 'VariableDeclarator') {
        const id = owner.id;
        if (isNode(id) && id.type === 'Identifier') {
          removableExpressionRefs.add(id.name);
        }
      }

      processors.push(processor);
      callback(processor);
      addedImports.push(...astService.getAddedImports());
    });
  });

  const replacedCode = applyReplacements(workingCode, replacements);
  const codeWithAddedImports = insertAddedImports(
    replacedCode,
    program,
    addedImports
  );

  return {
    code: cleanupUnused
      ? eventEmitter.perf('transform:preeval:processTemplate:cleanup', () =>
          removeUnusedAfterReplacement(
            codeWithAddedImports,
            filename,
            removableImportLocals,
            new Set([
              ...removableExpressionRefs,
              ...extracted.dependencyNames,
            ])
          )
        )
      : codeWithAddedImports,
    processors,
  };
};
