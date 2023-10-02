/**
 * Collector traverses the AST and collects information about imports and
 * all usages of WYW-processors.
 */

import type { BabelFile, PluginObj } from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type { Identifier } from '@babel/types';

import type { ValueCache } from '@wyw-in-js/processor-utils';
import { logger } from '@wyw-in-js/shared';
import type { StrictOptions } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import type { IPluginState } from '../types';
import { processTemplateExpression } from '../utils/processTemplateExpression';
import { removeWithRelated } from '../utils/scopeHelpers';
import type { WYWTransformMetadata } from '../utils/transformMetadata';
import { invalidateTraversalCache } from '../utils/traversalCache';

export const filename = __filename;

export function collector(
  file: BabelFile,
  options: Pick<
    StrictOptions,
    'classNameSlug' | 'displayName' | 'evaluate' | 'tagResolver'
  >,
  values: ValueCache
) {
  const processors: WYWTransformMetadata['processors'] = [];

  const identifiers: NodePath<Identifier>[] = [];
  file.path.traverse({
    Identifier: (p) => {
      identifiers.push(p);
    },
  });

  // TODO: process transformed literals
  identifiers.forEach((p) => {
    processTemplateExpression(p, file.opts, options, (processor) => {
      processor.build(values);
      processor.doRuntimeReplacement();
      processors.push(processor);
    });
  });

  if (processors.length === 0) {
    // We didn't find any processors.
    return processors;
  }

  // We can remove __linariaPreval export and all related code
  const prevalExport = (
    file.path.scope.getData('__linariaPreval') as NodePath | undefined
  )?.findParent((p) => p.isExpressionStatement());
  if (prevalExport) {
    removeWithRelated([prevalExport]);
  }

  return processors;
}

export default function collectorPlugin(
  babel: Core,
  options: StrictOptions & { values?: ValueCache }
): PluginObj<IPluginState> {
  const values = options.values ?? new Map<string, unknown>();
  const debug = logger.extend('collector');
  return {
    name: '@wyw-in-js/transform/collector',
    pre(file: BabelFile) {
      debug('start %s', file.opts.filename);

      const processors = collector(file, options, values);

      if (processors.length === 0) {
        // We didn't find any Linaria template literals.
        return;
      }

      this.file.metadata.linaria = {
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
