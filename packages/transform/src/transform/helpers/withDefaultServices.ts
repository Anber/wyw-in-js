import { TransformCacheCollection } from '../../cache';
import { EventEmitter } from '../../utils/EventEmitter';
import { loadAndParse } from '../Entrypoint.helpers';
import { rootLog } from '../rootLog';
import type { Services } from '../types';

type RequiredServices = 'options';
export type PartialServices = Partial<Omit<Services, RequiredServices>> &
  Pick<Services, RequiredServices>;

export const withDefaultServices = ({
  cache = new TransformCacheCollection(),
  emitWarning,
  eventEmitter = EventEmitter.dummy,
  loadDependencyCode,
  loadAndParseFn = loadAndParse,
  log = rootLog,
  options,
  asyncResolveKey,
}: PartialServices): Services => ({
  cache,
  emitWarning,
  eventEmitter,
  loadDependencyCode,
  loadAndParseFn,
  log,
  options,
  asyncResolveKey,
});
