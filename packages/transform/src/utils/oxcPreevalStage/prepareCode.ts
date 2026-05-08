import { isFeatureEnabled } from '@wyw-in-js/shared';

import type { EventEmitter } from '../EventEmitter';
import {
  removeDangerousCodeWithOxc,
  replaceImportMetaEnvWithOxc,
  rewriteDynamicImportsAndAddRequireFallbackWithOxc,
} from '../oxcPreevalTransforms';
import type { OxcPreevalOptions } from './types';

const DYNAMIC_IMPORT_RE = /\bimport(?:\s|\/\*[\s\S]*?\*\/)*\(/;
const REQUIRE_CALL_RE = /\brequire(?:\s|\/\*[\s\S]*?\*\/)*\(/;

export const prepareOxcPreevalCode = (
  code: string,
  filename: string,
  options: OxcPreevalOptions,
  eventEmitter: EventEmitter
): string => {
  let nextCode = eventEmitter.perf('transform:preeval:importMetaEnv', () =>
    replaceImportMetaEnvWithOxc(code, filename)
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

  return nextCode;
};
