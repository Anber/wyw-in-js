import { parseSync } from 'oxc-parser';

import type { IFileContext } from '@wyw-in-js/processor-utils';
import type { StrictOptions } from '@wyw-in-js/shared';
import { isFeatureEnabled } from '@wyw-in-js/shared';

import type { WYWTransformMetadata } from './TransformMetadata';
import { applyOxcProcessors } from './applyOxcProcessors';
import {
  addRequireFallbackWithOxc,
  removeDangerousCodeWithOxc,
  replaceImportMetaEnvWithOxc,
  rewriteDynamicImportsWithOxc,
} from './oxcPreevalTransforms';

type OxcPreevalOptions = Pick<
  StrictOptions,
  | 'classNameSlug'
  | 'codeRemover'
  | 'displayName'
  | 'evaluate'
  | 'extensions'
  | 'features'
  | 'tagResolver'
>;

type OxcPreevalResult = {
  code: string;
  metadata: WYWTransformMetadata | null;
};

const DYNAMIC_IMPORT_RE = /\bimport(?:\s|\/\*[\s\S]*?\*\/)*\(/;
const REQUIRE_CALL_RE = /\brequire(?:\s|\/\*[\s\S]*?\*\/)*\(/;

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

const appendWywPreval = (
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

  const processed = applyOxcProcessors(
    code,
    fileContext,
    options,
    (processor) => {
      processor.dependencies.forEach((dependency) => {
        if (dependency.ex.type === 'Identifier') {
          dependencyNames.push(dependency.ex.name);
        }
      });

      processor.doEvaltimeReplacement();
    }
  );

  let nextCode = replaceImportMetaEnvWithOxc(processed.code, filename);

  if (isFeatureEnabled(options.features, 'dangerousCodeRemover', filename)) {
    nextCode = removeDangerousCodeWithOxc(
      nextCode,
      filename,
      options.codeRemover
    );
  }

  if (DYNAMIC_IMPORT_RE.test(nextCode)) {
    nextCode = rewriteDynamicImportsWithOxc(nextCode, filename);
  }

  if (REQUIRE_CALL_RE.test(nextCode)) {
    nextCode = addRequireFallbackWithOxc(nextCode, filename);
  }

  if (processed.processors.length === 0) {
    return {
      code: nextCode,
      metadata: null,
    };
  }

  return {
    code: appendWywPreval(nextCode, filename, dependencyNames),
    metadata: {
      dependencies: [],
      processors: processed.processors,
      replacements: [],
      rules: {},
    },
  };
};
