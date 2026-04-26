/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import type {
  ExportNamedDeclaration,
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
import {
  evaluateOxcStaticExpression,
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
  type OxcStaticValueCandidate,
} from '../../utils/collectOxcTemplateDependencies';
import { appendOxcWywPreval } from '../../utils/oxcPreevalStage';
import { parseOxcProgramCached } from '../../utils/parseOxc';
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

const parseProgram = (code: string, filename: string): Program =>
  parseOxcProgramCached(filename, code, 'unambiguous');

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

const isSafeLiteral = (node: Node): boolean => {
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

const isSafeStaticExpression = (expr: Node): boolean => {
  const unwrapped = unwrapExpression(expr);

  if (isSafeLiteral(unwrapped)) {
    return true;
  }

  if (unwrapped.type === 'Identifier') {
    return true;
  }

  if (unwrapped.type === 'TemplateLiteral') {
    return unwrapped.expressions.every((item) => isSafeStaticExpression(item));
  }

  if (unwrapped.type === 'UnaryExpression') {
    return isSafeStaticExpression(unwrapped.argument);
  }

  if (
    unwrapped.type === 'BinaryExpression' ||
    unwrapped.type === 'LogicalExpression'
  ) {
    return (
      isSafeStaticExpression(unwrapped.left) &&
      isSafeStaticExpression(unwrapped.right)
    );
  }

  if (unwrapped.type === 'ConditionalExpression') {
    return (
      isSafeStaticExpression(unwrapped.test) &&
      isSafeStaticExpression(unwrapped.consequent) &&
      isSafeStaticExpression(unwrapped.alternate)
    );
  }

  if (unwrapped.type === 'MemberExpression') {
    return (
      isSafeStaticExpression(unwrapped.object) &&
      (unwrapped.computed
        ? isSafeStaticExpression(unwrapped.property)
        : unwrapped.property.type === 'Identifier')
    );
  }

  if (unwrapped.type === 'ArrayExpression') {
    return unwrapped.elements.every((item) => {
      if (!item) {
        return false;
      }

      return item.type === 'SpreadElement'
        ? isSafeStaticExpression(item.argument)
        : isSafeStaticExpression(item);
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
        isSafeStaticExpression(propertyNode.value as Node)
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

const isSafeVariableDeclaration = (statement: VariableDeclaration): boolean =>
  statement.kind === 'const' &&
  statement.declarations.every(
    (declarator) => declarator.init && isSafeStaticExpression(declarator.init)
  );

const isTypeOnlyExport = (statement: ExportNamedDeclaration): boolean =>
  statement.exportKind === 'type';

const isSafeStaticStatement = (statement: Node): boolean => {
  if (statement.type.startsWith('TS') || statement.type.startsWith('JSDoc')) {
    return statement.type !== 'TSEnumDeclaration';
  }

  if (statement.type === 'EmptyStatement') {
    return true;
  }

  if (statement.type === 'ImportDeclaration') {
    return (
      isTypeOnlyImport(statement) ||
      (statement.specifiers.length > 0 &&
        statement.specifiers.every(
          (specifier) => specifier.type !== 'ImportNamespaceSpecifier'
        ))
    );
  }

  if (statement.type === 'VariableDeclaration') {
    return isSafeVariableDeclaration(statement);
  }

  if (statement.type === 'ExportNamedDeclaration') {
    if (isTypeOnlyExport(statement)) {
      return true;
    }

    if (statement.source) {
      return statement.specifiers.every(
        (specifier) => specifier.type === 'ExportSpecifier'
      );
    }

    if (!statement.declaration) {
      return true;
    }

    return (
      statement.declaration.type === 'VariableDeclaration' &&
      isSafeVariableDeclaration(statement.declaration)
    );
  }

  if (statement.type === 'ExportDefaultDeclaration') {
    return isSafeStaticExpression(statement.declaration);
  }

  if (statement.type === 'ExpressionStatement') {
    return isSafeLiteral(statement.expression);
  }

  return false;
};

const isSafeStaticProgram = (program: Program): boolean =>
  program.body.every((statement) => isSafeStaticStatement(statement));

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
  if (!isSafeStaticProgram(program)) {
    memo.set(memoKey, null);
    stack.delete(memoKey);
    return null;
  }

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

  const imports = collectImportBindings(program);
  const env = new Map<string, unknown>();
  const dependencies = new Set<string>([filename]);

  for (const binding of imports.values()) {
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
  const staticValueCache =
    preevalResult.staticValueCache ?? new Map<string, unknown>();
  const staticDependencies = new Set(preevalResult.staticDependencies ?? []);
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
  preevalResult.code = appendOxcWywPreval(
    preevalResult.baseCode ?? preevalResult.code,
    filename,
    dependencyNames
  );

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
