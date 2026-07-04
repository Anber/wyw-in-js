/* eslint-disable no-restricted-syntax,no-continue */

import type { ExpressionValue } from '@wyw-in-js/shared';
import { ValueType } from '@wyw-in-js/shared';
import type { Expression, Program } from 'oxc-parser';

import { getOxcNodeChildren } from '../oxc/ast';
import { applyOxcReplacements } from '../oxc/replacements';
import { createOxcLocationLookup } from '../oxc/sourceLocations';
import {
  analyzeProgram,
  containsTaggedTemplateExpression,
  createSpanLookup,
  findReferences,
  getSourceLocation,
  isBindingDeclaredWithin,
  parseOxc,
  resolveBindingAt,
} from './scopeAnalysis';
import {
  applyExpressionReplacements,
  collectIdentifierReferenceReplacements,
  collectStaticNamespaceMemberReferences,
  getConstantReplacement,
  replaceIdentifierReferences,
} from './expressionReplacements';
import {
  cloneStaticValue,
  evaluateStatic,
  isStaticSerializableValue,
  literalCode,
} from './staticEvaluator';
import type {
  Binding,
  ExtractedExpression,
  ExpressionSpan,
  ExtractionContext,
  OxcStaticImportReference,
  ProgramAnalysis,
  Replacement,
  StaticBindings,
  StaticLocalExpression,
  TemplateExtractionResult,
} from './types';

const allocateExpressionName = (ctx: ExtractionContext): string => {
  let base = '_exp';
  let idx = 1;
  while (ctx.usedNames.has(base)) {
    idx += 1;
    base = `_exp${idx}`;
  }

  ctx.usedNames.add(base);
  return base;
};

const hoistedBindingKey = (binding: Binding): string =>
  `${binding.scope.start}:${binding.scope.end}:${binding.declaredAt}:${binding.name}`;

const allocateHoistedBindingName = (
  originalName: string,
  ctx: ExtractionContext
): string => {
  const sanitized = originalName.replace(/[^A-Za-z0-9_$]/g, '_') || 'hoisted';
  const base = /^[A-Za-z_$]/.test(sanitized) ? `_${sanitized}` : '_hoisted';
  let candidate = base;
  let idx = 2;

  while (ctx.usedNames.has(candidate)) {
    candidate = `${base}${idx}`;
    idx += 1;
  }

  ctx.usedNames.add(candidate);
  return candidate;
};

const getHoistedBindingName = (
  binding: Binding,
  ctx: ExtractionContext
): string => {
  const key = hoistedBindingKey(binding);
  const existing = ctx.hoistedBindingNames.get(key);
  if (existing) {
    return existing;
  }

  const next = allocateHoistedBindingName(binding.name, ctx);
  ctx.hoistedBindingNames.set(key, next);
  return next;
};

const parenthesizeStaticReplacement = (source: string): string => `(${source})`;

const replaceStaticLocalReferences = (
  expression: Expression,
  replacements: Map<string, string>,
  ctx: ExtractionContext,
  extraReplacements: Replacement[] = []
): string => {
  if (expression.type === 'Identifier' && extraReplacements.length === 0) {
    return (
      replacements.get(expression.name) ??
      ctx.code.slice(expression.start, expression.end)
    );
  }

  const parenthesized = new Map<string, string>();
  replacements.forEach((value, key) => {
    parenthesized.set(key, parenthesizeStaticReplacement(value));
  });

  return applyExpressionReplacements(
    expression,
    [
      ...extraReplacements,
      ...collectIdentifierReferenceReplacements(expression, parenthesized),
    ],
    ctx.code
  );
};

const collectStaticLocalExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  stack: string[] = []
): StaticLocalExpression | null => {
  const replacements = new Map<string, string>();
  const importedFrom = new Set<string>();
  const imports: OxcStaticImportReference[] = [];

  for (const { name, start } of findReferences(
    expression,
    ctx.referencesByNode
  )) {
    const binding = resolveBindingAt(ctx, name, start);
    if (!binding) {
      return null;
    }

    if (binding.importedFrom) {
      importedFrom.add(binding.importedFrom);
      if (binding.imported && binding.imported !== '*') {
        imports.push({
          imported: binding.imported,
          local: binding.name,
          source: binding.importedFrom,
        });
        continue;
      }

      return null;
    }

    const replacement = getConstantReplacement(binding, ctx);
    if (replacement) {
      replacements.set(name, replacement);
      continue;
    }

    if (
      binding.kind === 'param' ||
      binding.declarationKind !== 'const' ||
      !binding.declarator?.init ||
      binding.declarator.id.type !== 'Identifier'
    ) {
      return null;
    }

    // Processor-managed bindings (const x = css``) carry their value
    // (the generated className string) via inlineConstants at candidate
    // evaluation time. Walking the TaggedTemplateExpression here would
    // pull the processor's tag import (e.g. `css` from '@linaria/core')
    // into the candidate's static imports, where it fails to resolve.
    // Leave the identifier as a free reference; the candidate-side env
    // supplies the className.
    if (binding.declarator.init.type === 'TaggedTemplateExpression') {
      continue;
    }

    const key = hoistedBindingKey(binding);
    if (stack.includes(key)) {
      return null;
    }

    const nested = collectStaticLocalExpression(binding.declarator.init, ctx, [
      ...stack,
      key,
    ]);
    if (!nested) {
      return null;
    }

    replacements.set(name, nested.source);
    nested.importedFrom.forEach((source) => importedFrom.add(source));
    imports.push(...nested.imports);
  }

  return {
    importedFrom: [...importedFrom],
    imports,
    source:
      replacements.size > 0
        ? replaceStaticLocalReferences(expression, replacements, ctx)
        : ctx.code.slice(expression.start, expression.end),
  };
};

const expressionSpanKey = (
  node: Pick<ExpressionSpan, 'end' | 'start'>
): string => `${node.start}:${node.end}`;

const containsProcessorManagedExpression = (
  node: Expression,
  ctx: ExtractionContext
): boolean =>
  ctx.processorManagedExpressionSpans.has(expressionSpanKey(node)) ||
  getOxcNodeChildren(node).some((child) =>
    containsProcessorManagedExpression(child as Expression, ctx)
  );

const declarationInitCode = (
  init: Expression,
  ctx: ExtractionContext
): string => {
  const renamedDependencies = new Map<string, string>();
  findReferences(init, ctx.referencesByNode).forEach(({ name, start }) => {
    const dependency = resolveBindingAt(ctx, name, start);
    if (
      !dependency ||
      dependency.importedFrom ||
      dependency.isRoot ||
      dependency.declarator?.id.type !== 'Identifier'
    ) {
      return;
    }

    renamedDependencies.set(name, getHoistedBindingName(dependency, ctx));
  });

  return renamedDependencies.size > 0
    ? replaceIdentifierReferences(init, renamedDependencies, ctx.code)
    : ctx.code.slice(init.start, init.end);
};

const addHoistedCode = (
  key: string,
  code: string,
  ctx: ExtractionContext
): void => {
  if (ctx.hoistedDeclarations.has(key)) {
    return;
  }

  ctx.hoistedDeclarations.set(key, code);
  const declarations =
    ctx.hoistedDeclarationsByInsertionPoint.get(ctx.currentInsertionPoint) ??
    [];
  declarations.push(code);
  ctx.hoistedDeclarationsByInsertionPoint.set(
    ctx.currentInsertionPoint,
    declarations
  );
};

const declarationCode = (binding: Binding, ctx: ExtractionContext): string => {
  const { declarator } = binding;
  if (!declarator) {
    return '';
  }

  const { id } = declarator;
  if (id.type !== 'Identifier') {
    const idCode = ctx.code.slice(id.start, id.end);
    if (!declarator.init) {
      return `let ${idCode};`;
    }

    return `let ${idCode} = ${declarationInitCode(declarator.init, ctx)};`;
  }

  const hoistedName = getHoistedBindingName(binding, ctx);
  if (!declarator.init) {
    return `let ${hoistedName};`;
  }

  return `let ${hoistedName} = ${declarationInitCode(declarator.init, ctx)};`;
};

const assertHoistable = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  if (!binding.declarator?.init || binding.importedFrom || binding.isRoot) {
    return;
  }

  if (stack.includes(binding.name)) {
    return;
  }

  const refs = findReferences(binding.declarator.init, ctx.referencesByNode);
  refs.forEach(({ name, start }) => {
    const nextBinding = resolveBindingAt(ctx, name, start);
    if (!nextBinding) {
      return;
    }

    if (nextBinding.kind === 'param') {
      throw new Error(
        `This identifier cannot be used in the template, because it is a function parameter.`
      );
    }

    assertHoistable(nextBinding, ctx, [...stack, binding.name]);
  });
};

const addHoistedDeclaration = (
  binding: Binding,
  ctx: ExtractionContext,
  stack: string[] = []
): void => {
  if (
    !binding.declaration ||
    !binding.declarator ||
    binding.importedFrom ||
    binding.isRoot ||
    stack.includes(binding.name)
  ) {
    return;
  }

  const hoistSource = binding.declarator.init ?? binding.declarator;
  findReferences(hoistSource, ctx.referencesByNode).forEach(
    ({ name, start }) => {
      const dependency = resolveBindingAt(ctx, name, start);
      if (dependency) {
        addHoistedDeclaration(dependency, ctx, [...stack, binding.name]);
      }
    }
  );

  if (!ctx.hoistedDeclarations.has(binding.name)) {
    addHoistedCode(binding.name, declarationCode(binding, ctx), ctx);
  }
};

const literalExpressionValue = (
  expression: Expression,
  ctx: ExtractionContext
): Omit<ExpressionValue, 'buildCodeFrameError'> | null => {
  if (expression.type !== 'Literal') {
    return null;
  }

  if (
    expression.value !== null &&
    typeof expression.value !== 'string' &&
    typeof expression.value !== 'number' &&
    typeof expression.value !== 'boolean'
  ) {
    return null;
  }

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

  const loc = getSourceLocation(expression.start, expression.end, ctx);
  const ex =
    expression.value === null
      ? { loc, type }
      : {
          loc,
          type,
          value: expression.value,
        };

  return {
    ex,
    kind: ValueType.CONST,
    source: ctx.code.slice(expression.start, expression.end),
    value: expression.value,
  } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>;
};

const extractExpression = (
  expression: Expression,
  ctx: ExtractionContext,
  evaluate: boolean
): ExtractedExpression => {
  const source = ctx.code.slice(expression.start, expression.end);
  // Only inline function expressions are function-valued here. A bare
  // identifier that points to a local function may be a styled runtime
  // component, so it has to stay as a lazy `_exp()` reference.
  const isFunction =
    expression.type === 'FunctionExpression' ||
    expression.type === 'ArrowFunctionExpression';

  if (evaluate) {
    const evaluated = evaluateStatic(expression, ctx);
    const literal = literalCode(evaluated);
    if (literal) {
      findReferences(expression, ctx.referencesByNode).forEach(({ name }) =>
        ctx.dependencyNames.add(name)
      );
      return {
        expressionCode: literal,
        importedFrom: [],
        kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
        staticImports: [],
        staticValue: isStaticSerializableValue(evaluated)
          ? cloneStaticValue(evaluated)
          : undefined,
      };
    }
  }

  const identifierReplacements = new Map<string, string>();
  const importedFrom: string[] = [];
  const namespaceStatic = collectStaticNamespaceMemberReferences(
    expression,
    ctx
  );
  const staticIdentifierReplacements = new Map<string, string>();
  const staticImports: OxcStaticImportReference[] = [
    ...namespaceStatic.imports,
  ];
  let hasNonStaticLocalReference = false;
  let hasInlinableLocalReference = false;

  findReferences(expression, ctx.referencesByNode).forEach(
    ({ name, start }) => {
      const binding = resolveBindingAt(ctx, name, start);
      if (!binding) {
        return;
      }

      if (isFunction && isBindingDeclaredWithin(binding, expression)) {
        return;
      }

      ctx.dependencyNames.add(name);

      if (binding.importedFrom) {
        importedFrom.push(binding.importedFrom);
        if (binding.imported && binding.imported !== '*') {
          staticImports.push({
            imported: binding.imported,
            local: binding.name,
            source: binding.importedFrom,
          });
        } else if (
          binding.imported === '*' &&
          namespaceStatic.coveredReferenceStarts.has(start)
        ) {
          // The static candidate source gets a synthetic named import alias,
          // while the eval fallback keeps the original namespace expression.
        } else {
          hasNonStaticLocalReference = true;
        }
        return;
      }

      const replacement = getConstantReplacement(binding, ctx);
      if (evaluate && replacement) {
        identifierReplacements.set(name, replacement);
        return;
      }

      const init = binding.declarator?.init;
      // Processor-managed bindings (`const x = css```, or object literals
      // containing processor tags) carry values that only become known after
      // processors run. Leave the identifier free in the candidate source so
      // the resolver can supply it via inlineConstants at evaluation time.
      const isProcessorManagedLocal =
        !!evaluate &&
        !!init &&
        (containsTaggedTemplateExpression(init) ||
          containsProcessorManagedExpression(init, ctx));
      const staticLocalExpression =
        evaluate && init && !isProcessorManagedLocal
          ? collectStaticLocalExpression(init, ctx, [
              hoistedBindingKey(binding),
            ])
          : null;
      if (staticLocalExpression) {
        staticIdentifierReplacements.set(name, staticLocalExpression.source);
        importedFrom.push(...staticLocalExpression.importedFrom);
        staticImports.push(...staticLocalExpression.imports);
      } else if (isProcessorManagedLocal) {
        hasInlinableLocalReference = true;
      } else {
        hasNonStaticLocalReference = true;
      }

      if (!isProcessorManagedLocal) {
        assertHoistable(binding, ctx);
        addHoistedDeclaration(binding, ctx);
        if (!binding.isRoot && binding.declarator?.id.type === 'Identifier') {
          identifierReplacements.set(name, getHoistedBindingName(binding, ctx));
        }
      }
    }
  );

  // Merge literal-const inlines (e.g. `const A = 32` -> "32") with
  // local-to-imported substitutions (e.g. `const X = imp.y` -> "imp.y").
  // Both must reach the candidate source so the resolver's evaluator
  // can fold every Identifier in the expression; env only carries
  // imported bindings, never same-file locals.
  const mergedReplacements = new Map(staticIdentifierReplacements);
  identifierReplacements.forEach((value, key) => {
    if (!mergedReplacements.has(key)) {
      mergedReplacements.set(key, value);
    }
  });

  let staticExpressionCode: string | undefined;
  if (mergedReplacements.size > 0) {
    staticExpressionCode = replaceStaticLocalReferences(
      expression,
      mergedReplacements,
      ctx,
      namespaceStatic.replacements
    );
  } else if (namespaceStatic.replacements.length > 0) {
    staticExpressionCode = applyExpressionReplacements(
      expression,
      namespaceStatic.replacements,
      ctx.code
    );
  }

  return {
    expressionCode:
      identifierReplacements.size > 0
        ? replaceIdentifierReferences(
            expression,
            identifierReplacements,
            ctx.code
          )
        : source,
    importedFrom,
    kind: isFunction ? ValueType.FUNCTION : ValueType.LAZY,
    staticExpressionCode,
    hasInlinableLocalReference:
      !hasNonStaticLocalReference && hasInlinableLocalReference,
    staticImports: hasNonStaticLocalReference ? [] : staticImports,
  };
};

const getInsertionPoints = (
  program: Program,
  expressions: Expression[]
): number[] => {
  if (expressions.length === 0) {
    return [];
  }

  if (program.body.length === 0) {
    return expressions.map(() => 0);
  }

  const insertionPoints: number[] = [];
  let ownerIndex = 0;

  expressions.forEach((expression) => {
    while (
      ownerIndex < program.body.length - 1 &&
      program.body[ownerIndex]!.end < expression.start
    ) {
      ownerIndex += 1;
    }

    let owner: Program['body'][number] | undefined = program.body[ownerIndex];
    if (
      !owner ||
      owner.start > expression.start ||
      owner.end < expression.end
    ) {
      owner = program.body.find(
        (statement) =>
          statement.start <= expression.start && statement.end >= expression.end
      );
    }

    insertionPoints.push(owner?.start ?? 0);
  });

  return insertionPoints;
};

const extractExpressions = (
  code: string,
  filename: string,
  evaluate: boolean,
  program: Program,
  analysis: Pick<
    ProgramAnalysis,
    'bindingsByName' | 'rootMutationsByBinding' | 'usedNames'
  >,
  expressions: Expression[],
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = []
): TemplateExtractionResult => {
  if (expressions.length === 0) {
    return {
      code,
      dependencyNames: [],
      expressionValues: [],
      staticValueCandidates: [],
      staticValues: [],
    };
  }

  const insertionPoints = getInsertionPoints(program, expressions);
  const ctx: ExtractionContext = {
    bindingResolutionCache: new Map(),
    bindingsByName: analysis.bindingsByName,
    code,
    currentInsertionPoint: insertionPoints[0] ?? 0,
    currentExpressionStart: expressions[0].start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedBindingNames: new Map(),
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createOxcLocationLookup(code),
    processorManagedExpressionSpans: new Set(
      processorManagedExpressionSpans.map(expressionSpanKey)
    ),
    referencesByNode: new WeakMap(),
    replacements: [],
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    staticBindings,
    staticImportAliases: new Map(),
    staticValueCandidates: [],
    staticValues: [],
    usedNames: new Set(analysis.usedNames),
  };

  expressions.forEach((expression, index) => {
    ctx.currentInsertionPoint = insertionPoints[index] ?? 0;
    ctx.currentExpressionStart = expression.start;

    const literal = literalExpressionValue(expression, ctx);
    if (literal) {
      ctx.expressionValues.push(literal);
      return;
    }

    const {
      expressionCode,
      hasInlinableLocalReference,
      importedFrom,
      kind,
      staticExpressionCode,
      staticImports,
      staticValue,
    } = extractExpression(expression, ctx, evaluate);
    const expName = allocateExpressionName(ctx);

    addHoistedCode(
      expName,
      `const ${expName} = () => (${expressionCode});`,
      ctx
    );
    if (staticValue !== undefined && kind !== ValueType.FUNCTION) {
      ctx.staticValues.push({
        name: expName,
        value: staticValue,
      });
    } else if (
      (staticImports.length > 0 ||
        hasInlinableLocalReference ||
        staticExpressionCode !== undefined) &&
      kind !== ValueType.FUNCTION
    ) {
      const uniqueImports = new Map<string, OxcStaticImportReference>();
      staticImports.forEach((item) => {
        uniqueImports.set(
          `${item.local}\0${item.importLocal ?? ''}\0${item.source}\0${
            item.imported
          }`,
          item
        );
      });
      ctx.staticValueCandidates.push({
        imports: [...uniqueImports.values()],
        name: expName,
        source: staticExpressionCode ?? expressionCode,
      });
    }
    ctx.replacements.push({
      start: expression.start,
      end: expression.end,
      value: `${expName}()`,
    });
    ctx.expressionValues.push({
      ex: {
        loc: getSourceLocation(expression.start, expression.end, ctx),
        name: expName,
        type: 'Identifier',
      },
      importedFrom,
      kind,
      source: ctx.code.slice(expression.start, expression.end),
    } as unknown as Omit<ExpressionValue, 'buildCodeFrameError'>);
  });

  ctx.hoistedDeclarationsByInsertionPoint.forEach((declarations, point) => {
    ctx.replacements.push({
      start: point,
      end: point,
      value: `${declarations.join('\n')}\n`,
    });
  });

  return {
    code: applyOxcReplacements(code, ctx.replacements),
    dependencyNames: [...ctx.dependencyNames],
    expressionValues: ctx.expressionValues,
    staticValueCandidates: ctx.staticValueCandidates,
    staticValues: ctx.staticValues,
  };
};

export const isOxcStaticSerializableValue = (value: unknown): boolean =>
  isStaticSerializableValue(value);

export const evaluateOxcStaticExpressionAt = (
  code: string,
  filename: string,
  expressionSpan: ExpressionSpan,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup([expressionSpan]),
  });
  const [expression] = analysis.targetExpressions;
  if (!expression) {
    return undefined;
  }

  const ctx: ExtractionContext = {
    bindingResolutionCache: new Map(),
    bindingsByName: analysis.bindingsByName,
    code,
    currentInsertionPoint: 0,
    currentExpressionStart: expression.start,
    dependencyNames: new Set(),
    expressionValues: [],
    filename,
    hoistedBindingNames: new Map(),
    hoistedDeclarations: new Map(),
    hoistedDeclarationsByInsertionPoint: new Map(),
    loc: createOxcLocationLookup(code),
    processorManagedExpressionSpans: new Set(),
    referencesByNode: new WeakMap(),
    replacements: [],
    rootMutationsByBinding: analysis.rootMutationsByBinding,
    staticBindings,
    staticImportAliases: new Map(),
    staticValueCandidates: [],
    staticValues: [],
    usedNames: new Set(analysis.usedNames),
  };

  return evaluateStatic(expression, ctx, new Map(env));
};

export const evaluateOxcStaticExpression = (
  source: string,
  filename: string,
  env: Map<string, unknown> = new Map(),
  staticBindings?: StaticBindings
): unknown | undefined => {
  const code = `const __wyw_static_value = ${source};`;
  const program = parseOxc(code, filename);
  const declaration = program.body[0];
  if (declaration?.type !== 'VariableDeclaration') {
    return undefined;
  }

  const [declarator] = declaration.declarations;
  if (!declarator?.init) {
    return undefined;
  }

  return evaluateOxcStaticExpressionAt(
    code,
    filename,
    {
      end: declarator.init.end,
      start: declarator.init.start,
    },
    env,
    staticBindings
  );
};

export const collectOxcExpressionDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetExpressionSpans?: ExpressionSpan[],
  staticBindings?: StaticBindings,
  processorManagedExpressionSpans: ExpressionSpan[] = []
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTargetExpressions: true,
    expressionSpanLookup: createSpanLookup(targetExpressionSpans),
  });

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    analysis.targetExpressions,
    staticBindings,
    processorManagedExpressionSpans
  );
};

export const collectOxcTemplateDependencies = (
  code: string,
  filename: string,
  evaluate = false,
  targetTemplateSpans?: ExpressionSpan[]
): TemplateExtractionResult => {
  const program = parseOxc(code, filename);
  const analysis = analyzeProgram(program, {
    collectTemplateLiterals: true,
    templateSpanLookup: createSpanLookup(targetTemplateSpans),
  });
  const expressions = analysis.templateLiterals.flatMap(
    (template) => template.expressions
  );

  return extractExpressions(
    code,
    filename,
    evaluate,
    program,
    analysis,
    expressions
  );
};
