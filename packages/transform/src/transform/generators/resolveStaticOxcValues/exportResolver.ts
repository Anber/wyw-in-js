/* eslint-disable no-restricted-syntax,no-continue,@typescript-eslint/no-use-before-define */

import {
  evaluateOxcStaticExpressionAt,
  isOxcStaticSerializableValue,
  lookupStaticBinding,
} from '../../../utils/collectOxcTemplateDependencies';
import type { ITransformAction, SyncScenarioFor } from '../../types';
import {
  getStaticExportCachedResult,
  getStaticFileAnalysis,
  getStaticMetadataPreevalResult,
  setStaticExportCachedResult,
} from './cache';
import { resolveDependency } from './dependencies';
import { debugStaticResolve, getStaticBindings } from './environment';
import {
  findExportTarget,
  typeScriptEnumStaticExportValue,
} from './exportTargets';
import { resolveObjectAssignStaticExport } from './objectAssignStaticExport';
import { resolveProcessorStaticExport } from './processorStaticExport';
import {
  bindStaticResolvedValue,
  collectImportBindings,
} from './staticExpression';
import { collectStaticExpressionDependencies } from './staticExpressionDependencies';
import type { ImportBinding, StaticExportResult } from './types';
import { resolveZeroArgFunctionStaticExport } from './zeroArgFunctionStaticExport';

export function* resolveImportValue(
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
export function* resolveStaticExport(
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

  const resolvers = {
    resolveImportValue,
    resolveStaticExport,
  };

  const objectAssignResult = yield* resolveObjectAssignStaticExport(
    action,
    filename,
    code,
    program,
    target,
    stack,
    memo,
    resolvers
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
    memo,
    resolveImportValue
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

  // Build the set of import-local names registered as pure helpers via
  // pluginOptions.staticBindings. The dependency walker admits
  // CallExpressions whose callee is one of these so `cx(a, b)` and
  // `isFlagPresent('x')` stop tripping isSafeStaticExpression.
  const staticBindingsForExportShape = getStaticBindings(action);
  const staticHelperLocals = new Set<string>();
  if (staticBindingsForExportShape) {
    const fileImports = collectImportBindings(program);
    for (const [local, binding] of fileImports) {
      if (
        !binding.imported ||
        binding.imported === '*' ||
        binding.imported === 'default'
      ) {
        continue;
      }
      let override = lookupStaticBinding(
        staticBindingsForExportShape,
        binding.source,
        binding.imported
      );
      if (!override.found) {
        const dep = yield* resolveDependency(
          action,
          filename,
          binding.source,
          binding.imported
        );
        if (dep?.resolved) {
          override = lookupStaticBinding(
            staticBindingsForExportShape,
            dep.resolved,
            binding.imported
          );
        }
      }
      if (override.found && typeof override.value === 'function') {
        staticHelperLocals.add(local);
      }
    }
  }

  const staticDependencies = collectStaticExpressionDependencies(
    program,
    target,
    {
      ...(preResolvedLocals ? { preResolvedLocals } : {}),
      ...(staticHelperLocals.size > 0 ? { staticHelperLocals } : {}),
    }
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
      memo,
      resolvers
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
    let lookupName: string | null = null;
    if (target.expression.type === 'TaggedTemplateExpression') {
      lookupName = target.localName ?? null;
    } else if (target.expression.type === 'Identifier') {
      lookupName = target.expression.name;
    }

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
  const staticBindingsForExport = getStaticBindings(action);

  for (const binding of staticDependencies.imports) {
    // staticBindings overrides take precedence here too — same shape as
    // the candidate path. Try the raw specifier first, then the
    // resolved absolute path on miss.
    let override = lookupStaticBinding(
      staticBindingsForExport,
      binding.source,
      binding.imported
    );
    if (!override.found && staticBindingsForExport) {
      const dep = yield* resolveDependency(
        action,
        filename,
        binding.source,
        binding.imported
      );
      if (dep?.resolved) {
        override = lookupStaticBinding(
          staticBindingsForExport,
          dep.resolved,
          binding.imported
        );
      }
    }
    if (override.found) {
      env.set(binding.local, override.value);
      continue;
    }

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
    const metadataResult = yield* resolveProcessorStaticExport(
      action,
      filename,
      code,
      codeHash,
      program,
      exportedName,
      stack,
      memo,
      resolvers
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
