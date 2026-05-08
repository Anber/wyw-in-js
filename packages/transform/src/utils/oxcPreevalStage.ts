import { parseSync } from 'oxc-parser';

import type { IFileContext } from '@wyw-in-js/processor-utils';
import type { StrictOptions } from '@wyw-in-js/shared';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import { EventEmitter } from './EventEmitter';
import type { WYWTransformMetadata } from './TransformMetadata';
import type { OxcStaticValueCandidate } from './collectOxcTemplateDependencies';
import { applyOxcProcessors } from './applyOxcProcessors';
import {
  removeDangerousCodeWithOxc,
  replaceImportMetaEnvWithOxc,
  rewriteDynamicImportsAndAddRequireFallbackWithOxc,
} from './oxcPreevalTransforms';

type OxcPreevalOptions = Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'eval'
  | 'extensions'
  | 'features'
  | 'staticBindings'
  | 'tagResolver'
> & { eventEmitter?: EventEmitter };

type OxcPreevalResult = {
  baseCode: string;
  code: string;
  dependencyNames: string[];
  metadata: WYWTransformMetadata | null;
  processorClassNames: Record<string, string>;
  staticDependencies: string[];
  staticValueCache: Map<string, unknown>;
  staticValueCandidates: OxcStaticValueCandidate[];
};

const DYNAMIC_IMPORT_RE = /\bimport(?:\s|\/\*[\s\S]*?\*\/)*\(/;
const REQUIRE_CALL_RE = /\brequire(?:\s|\/\*[\s\S]*?\*\/)*\(/;

const getEvalStrategy = (options: OxcPreevalOptions) =>
  options.eval?.strategy ?? 'hybrid';

const usesStaticEvaluation = (options: OxcPreevalOptions): boolean =>
  getEvalStrategy(options) !== 'execute';

const parseSourceType = (
  code: string,
  filename: string
): 'module' | 'script' => {
  const parsed = parseSync(filename, code, {
    astType:
      filename.endsWith('.ts') || filename.endsWith('.tsx') ? 'ts' : 'js',
    range: true,
    sourceType: 'unambiguous',
  });
  const fatalError = parsed.errors.find((error) => error.severity === 'Error');
  if (fatalError) {
    throw new Error(fatalError.message);
  }

  return parsed.program.sourceType === 'script' ? 'script' : 'module';
};

export const appendOxcWywPreval = (
  code: string,
  filename: string,
  dependencyNames: string[]
): string => {
  const uniqueNames = [...new Set(dependencyNames)];
  const properties = uniqueNames.map((name) => `${name}: ${name}`).join(', ');
  const object = uniqueNames.length > 0 ? `{ ${properties} }` : '{}';

  if (parseSourceType(code, filename) === 'script') {
    return `${code}\nexports.__wywPreval = ${object};`;
  }

  return `${code}\nexport const __wywPreval = ${object};`;
};

export const runOxcPreevalStage = (
  code: string,
  fileContext: IFileContext,
  options: OxcPreevalOptions
): OxcPreevalResult => {
  const filename = fileContext.filename ?? 'unknown.js';
  const dependencyNames: string[] = [];
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;

  const processed = eventEmitter.perf('transform:preeval:processTemplate', () =>
    applyOxcProcessors(code, fileContext, options, (processor) => {
      processor.dependencies.forEach((dependency) => {
        if (dependency.ex.type === 'Identifier') {
          dependencyNames.push(dependency.ex.name);
        }
      });

      processor.doEvaltimeReplacement();
    })
  );
  const staticValuesEnabled = usesStaticEvaluation(options);
  const staticValueNames = staticValuesEnabled
    ? new Set(processed.staticValues.map((item) => item.name))
    : null;
  const evalDependencyNames = staticValuesEnabled
    ? dependencyNames.filter((name) => !staticValueNames!.has(name))
    : dependencyNames;
  if (
    getEvalStrategy(options) === 'static' &&
    evalDependencyNames.length > 0 &&
    processed.staticValues.length === 0
  ) {
    throw new Error(
      `[wyw-in-js] eval.strategy: "static" cannot fall back to the build-time evaluator for ${filename}.`
    );
  }

  let nextCode = eventEmitter.perf('transform:preeval:importMetaEnv', () =>
    replaceImportMetaEnvWithOxc(processed.code, filename)
  );

  if (isFeatureEnabled(options.features, 'dangerousCodeRemover', filename)) {
    nextCode = eventEmitter.perf('transform:preeval:removeDangerousCode', () =>
      removeDangerousCodeWithOxc(nextCode, filename, options.codeRemover)
    );
  }

  const shouldRewriteDynamicImports = DYNAMIC_IMPORT_RE.test(nextCode);
  const shouldAddRequireFallback = REQUIRE_CALL_RE.test(nextCode);
  if (shouldRewriteDynamicImports || shouldAddRequireFallback) {
    nextCode = rewriteDynamicImportsAndAddRequireFallbackWithOxc(
      nextCode,
      filename,
      {
        addRequireFallback: shouldAddRequireFallback,
        eventEmitter,
        rewriteDynamicImports: shouldRewriteDynamicImports,
      }
    );
  }

  if (processed.processors.length === 0) {
    return {
      baseCode: nextCode,
      code: nextCode,
      dependencyNames: [],
      metadata: null,
      processorClassNames: {},
      staticDependencies: [],
      staticValueCandidates: [],
      staticValueCache: new Map(),
    };
  }

  const staticValueCache = new Map<string, unknown>();
  if (staticValuesEnabled) {
    processed.staticValues.forEach(({ name, value }) => {
      staticValueCache.set(name, value);
    });
  }

  return {
    baseCode: nextCode,
    code: appendOxcWywPreval(nextCode, filename, evalDependencyNames),
    dependencyNames: evalDependencyNames,
    metadata: {
      dependencies: [],
      processors: processed.processors,
      replacements: [],
      rules: {},
    },
    processorClassNames: Object.fromEntries(
      processed.processorClassNamesByLocal
    ),
    staticDependencies: [],
    staticValueCandidates: staticValuesEnabled
      ? processed.staticValueCandidates
      : [],
    staticValueCache,
  };
};
