/**
 * Collector traverses the AST and collects information about imports and
 * all usages of WYW-processors.
 */

import type { BabelFile, PluginObj } from '@babel/core';
import type { NodePath } from '@babel/traverse';

import type { ValueCache } from '@wyw-in-js/processor-utils';
import { logger } from '@wyw-in-js/shared';
import type { StrictOptions } from '@wyw-in-js/shared';

import { EventEmitter } from '../utils/EventEmitter';
import { applyProcessors } from '../utils/getTagProcessor';
import type { Core } from '../babel';
import type { IPluginState } from '../types';
import type { WYWTransformMetadata } from '../utils/TransformMetadata';
import { removeWithRelated } from '../utils/scopeHelpers';
import { invalidateTraversalCache } from '../utils/traversalCache';

export const filename = __filename;

export function collector(
  file: BabelFile,
  options: Pick<
    StrictOptions,
    'classNameSlug' | 'displayName' | 'extensions' | 'evaluate' | 'tagResolver'
  > & { eventEmitter?: EventEmitter },
  values: ValueCache
) {
  const eventEmitter = options.eventEmitter ?? EventEmitter.dummy;
  const processors: WYWTransformMetadata['processors'] = [];

  eventEmitter.perf('transform:collector:processTemplate', () => {
    applyProcessors(file.path, file.opts, options, (processor) => {
      processor.build(values);
      processor.doRuntimeReplacement();
      processors.push(processor);
    });
  });

  if (processors.length === 0) {
    // We didn't find any processors.
    return processors;
  }

  // We can remove __wywPreval export and all related code
  const prevalExport = (
    file.path.scope.getData('__wywPreval') as NodePath | undefined
  )?.findParent((p) => p.isExpressionStatement());
  if (prevalExport) {
    removeWithRelated([prevalExport]);
  }

  return processors;
}

export default function collectorPlugin(
  babel: Core,
  options: StrictOptions & { eventEmitter?: EventEmitter; values?: ValueCache }
): PluginObj<IPluginState> {
  const values = options.values ?? new Map<string, unknown>();
  const debug = logger.extend('collector');
  return {
    name: '@wyw-in-js/transform/collector',
    pre(file: BabelFile) {
      debug('start %s', file.opts.filename);

      const processors = collector(file, options, values);

      if (processors.length === 0) {
        // We didn't find any wyw-in-js template literals.
        return;
      }

      this.file.metadata.wywInJS = {
        processors,
        replacements: [],
        rules: {},
        dependencies: [],
      };

      debug('end %s', file.opts.filename);
    },
    visitor: {},
    post(file: BabelFile) {
      invalidateTraversalCache(file.path);
    },
  };
}
