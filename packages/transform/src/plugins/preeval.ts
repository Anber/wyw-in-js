/**
 * This file is a babel preset used to transform files inside evaluators.
 * It works the same as main `babel/extract` preset, but do not evaluate lazy dependencies.
 */
import type { BabelFile, PluginObj } from '@babel/core';

import type { StrictOptions } from '@wyw-in-js/shared';
import { isFeatureEnabled, logger } from '@wyw-in-js/shared';

import type { Core } from '../babel';
import type { IPluginState } from '../types';
import { EventEmitter } from '../utils/EventEmitter';
import { addIdentifierToWywPreval } from '../utils/addIdentifierToWywPreval';
import { getFileIdx } from '../utils/getFileIdx';
import { processTemplateExpression } from '../utils/processTemplateExpression';
import { removeDangerousCode } from '../utils/removeDangerousCode';
import { invalidateTraversalCache } from '../utils/traversalCache';

export type PreevalOptions = Pick<
  StrictOptions,
  'classNameSlug' | 'displayName' | 'evaluate' | 'features'
> & { eventEmitter: EventEmitter };

export function preeval(
  babel: Core,
  { eventEmitter = EventEmitter.dummy, ...options }: PreevalOptions
): PluginObj<IPluginState & { onFinish: () => void }> {
  const { types: t } = babel;
  return {
    name: '@wyw-in-js/transform/preeval',
    pre(file: BabelFile) {
      const filename = file.opts.filename!;
      const log = logger.extend('preeval').extend(getFileIdx(filename));

      log('start', 'Looking for template literals…');

      const rootScope = file.scope;
      this.processors = [];

      eventEmitter.perf('transform:preeval:processTemplate', () => {
        file.path.traverse({
          Identifier: (p) => {
            processTemplateExpression(p, file.opts, options, (processor) => {
              processor.dependencies.forEach((dependency) => {
                if (dependency.ex.type === 'Identifier') {
                  addIdentifierToWywPreval(rootScope, dependency.ex.name);
                }
              });

              processor.doEvaltimeReplacement();
              this.processors.push(processor);
            });
          },
        });
      });

      if (
        isFeatureEnabled(options.features, 'dangerousCodeRemover', filename)
      ) {
        log('start', 'Strip all JSX and browser related stuff');
        eventEmitter.perf('transform:preeval:removeDangerousCode', () =>
          removeDangerousCode(file.path)
        );
      }
    },
    visitor: {},
    post(file: BabelFile) {
      const log = logger
        .extend('preeval')
        .extend(getFileIdx(file.opts.filename!));

      invalidateTraversalCache(file.path);

      if (this.processors.length === 0) {
        log('end', "We didn't find any wyw-in-js template literals");

        // We didn't find any wyw-in-js template literals.
        return;
      }

      this.file.metadata.wywInJS = {
        processors: this.processors,
        replacements: [],
        rules: {},
        dependencies: [],
      };

      const wywPreval = file.path.getData('__wywPreval');
      if (!wywPreval) {
        // Event if there is no dependencies, we still need to add __wywPreval
        const wywExport = t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.memberExpression(
              t.identifier('exports'),
              t.identifier('__wywPreval')
            ),
            t.objectExpression([])
          )
        );

        file.path.pushContainer('body', wywExport);
      }

      log('end', '__wywPreval has been added');
    },
  };
}

export default preeval;
