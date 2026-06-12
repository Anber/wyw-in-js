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
  const dependencyNames: string[] = [];
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

  return {
    dependencyNames,
    processed,
  };
};
