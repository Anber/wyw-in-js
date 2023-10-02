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
import { addIdentifierToLinariaPreval } from '../utils/addIdentifierToLinariaPreval';
import { getFileIdx } from '../utils/getFileIdx';
import { processTemplateExpression } from '../utils/processTemplateExpression';
import { removeDangerousCode } from '../utils/removeDangerousCode';
import { invalidateTraversalCache } from '../utils/traversalCache';

export type PreevalOptions = Pick<
  StrictOptions,
  'classNameSlug' | 'displayName' | 'evaluate' | 'features'
> & { eventEmitter: EventEmitter };

export default function preeval(
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
                  addIdentifierToLinariaPreval(rootScope, dependency.ex.name);
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
        log('end', "We didn't find any Linaria template literals");

        // We didn't find any Linaria template literals.
        return;
      }

      this.file.metadata.linaria = {
        processors: this.processors,
        replacements: [],
        rules: {},
        dependencies: [],
      };

      const linariaPreval = file.path.getData('__linariaPreval');
      if (!linariaPreval) {
        // Event if there is no dependencies, we still need to add __linariaPreval
        const linariaExport = t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.memberExpression(
              t.identifier('exports'),
              t.identifier('__linariaPreval')
            ),
            t.objectExpression([])
          )
        );

        file.path.pushContainer('body', linariaExport);
      }

      log('end', '__linariaPreval has been added');
    },
  };
}
