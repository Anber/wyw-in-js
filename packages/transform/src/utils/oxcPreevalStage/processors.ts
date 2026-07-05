import type { IFileContext } from '@wyw-in-js/processor-utils';

import type { EventEmitter } from '../EventEmitter';
import { applyOxcProcessors } from '../applyOxcProcessors';
import type { ApplyOxcProcessorsResult } from '../applyOxcProcessors/types';
import type { OxcPreevalOptions } from './types';

type PreevalProcessorCollection = {
  dependencyNames: string[];
  processed: ApplyOxcProcessorsResult;
};

export const collectPreevalProcessors = (
  code: string,
  fileContext: IFileContext,
  options: OxcPreevalOptions,
  eventEmitter: EventEmitter
): PreevalProcessorCollection => {
  const processed = eventEmitter.perf('transform:preeval:processTemplate', () =>
    applyOxcProcessors(
      code,
      fileContext,
      options,
      (processor) => {
        processor.doEvaltimeReplacement();
      },
      false,
      true
    )
  );
  const dependencyNames = processed.processors.flatMap((processor) =>
    processor.dependencies.flatMap((dependency) =>
      dependency.ex.type === 'Identifier' ? [dependency.ex.name] : []
    )
  );

  return {
    dependencyNames,
    processed,
  };
};
