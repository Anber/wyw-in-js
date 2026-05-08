import type { IFileContext } from '@wyw-in-js/processor-utils';

import { EventEmitter } from './EventEmitter';
import { appendOxcWywPreval } from './oxcPreevalStage/prevalExport';
import { prepareOxcPreevalCode } from './oxcPreevalStage/prepareCode';
import { collectPreevalProcessors } from './oxcPreevalStage/processors';
import { createStaticPreevalOverlay } from './oxcPreevalStage/staticOverlay';
import type {
  OxcPreevalOptions,
  OxcPreevalResult,
} from './oxcPreevalStage/types';

export { appendOxcWywPreval } from './oxcPreevalStage/prevalExport';

export const runOxcPreevalStage = (
  code: string,
  fileContext: IFileContext,
  options: OxcPreevalOptions
): OxcPreevalResult => {
  const filename = fileContext.filename ?? 'unknown.js';
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;
  const { dependencyNames, processed } = collectPreevalProcessors(
    code,
    fileContext,
    options,
    eventEmitter
  );
  const staticOverlay = createStaticPreevalOverlay(
    processed,
    dependencyNames,
    options
  );
  const baseCode = prepareOxcPreevalCode(
    processed.code,
    filename,
    options,
    eventEmitter
  );

  if (processed.processors.length === 0) {
    return {
      baseCode,
      code: baseCode,
      dependencyNames: [],
      metadata: null,
      processorClassNames: {},
      staticDependencies: [],
      staticValueCandidates: [],
      staticValueCache: new Map(),
    };
  }

  return {
    baseCode,
    code: appendOxcWywPreval(
      baseCode,
      filename,
      staticOverlay.evalDependencyNames
    ),
    dependencyNames: staticOverlay.evalDependencyNames,
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
    staticValueCache: staticOverlay.staticValueCache,
    staticValueCandidates: staticOverlay.staticValueCandidates,
  };
};
