import * as babelCore from '@babel/core';

import { TransformCacheCollection } from '../../cache';
import { EventEmitter } from '../../utils/EventEmitter';
import { loadAndParse } from '../Entrypoint.helpers';
import { rootLog } from '../rootLog';
import type { Services } from '../types';

type RequiredServices = 'options';
export type PartialServices = Partial<Omit<Services, RequiredServices>> &
  Pick<Services, RequiredServices>;

export const withDefaultServices = ({
  babel = babelCore,
  cache = new TransformCacheCollection(),
  emitWarning,
  eventEmitter = EventEmitter.dummy,
  loadAndParseFn = loadAndParse,
  log = rootLog,
  options,
}: PartialServices): Services => ({
  babel,
  cache,
  emitWarning,
  eventEmitter,
  loadAndParseFn,
  log,
  options,
});
