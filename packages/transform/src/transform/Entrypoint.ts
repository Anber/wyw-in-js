import fs from 'node:fs';
import { invariant } from 'ts-invariant';

import type { ParentEntrypoint, ITransformFileResult } from '../types';

import { BaseEntrypoint } from './BaseEntrypoint';
import { isSuperSet, mergeOnly } from './Entrypoint.helpers';
import type {
  IEntrypointCode,
  IEntrypointDependency,
  IIgnoredEntrypoint,
} from './Entrypoint.types';
import { EvaluatedEntrypoint } from './EvaluatedEntrypoint';
import { AbortError } from './actions/AbortError';
import type { ActionByType } from './actions/BaseAction';
import { BaseAction } from './actions/BaseAction';
import { UnprocessedEntrypointError } from './actions/UnprocessedEntrypointError';
import type { Services, ActionTypes, ActionQueueItem } from './types';
import { stripQueryAndHash } from '../utils/parseRequest';

const EMPTY_FILE = '=== empty file ===';
const DEFAULT_ACTION_CONTEXT = Symbol('defaultActionContext');

function hasLoop(
  name: string,
  parent: ParentEntrypoint,
  processed: string[] = []
): boolean {
  if (parent.name === name || processed.includes(parent.name)) {
    return true;
  }

  for (const p of parent.parents) {
    const found = hasLoop(name, p, [...processed, parent.name]);
    if (found) {
      return found;
    }
  }

  return false;
}

export class Entrypoint extends BaseEntrypoint {
  public readonly evaluated = false;

  public readonly loadedAndParsed: IEntrypointCode | IIgnoredEntrypoint;

  protected onSupersedeHandlers: Array<(newEntrypoint: Entrypoint) => void> =
    [];

  private actionsCache: Map<
    ActionTypes,
    Map<unknown, Map<unknown, BaseAction<ActionQueueItem>>>
  > = new Map();

  #hasWywMetadata: boolean = false;

  #isProcessing = false;

  #pendingOnly: string[] | null = null;

  #supersededWith: Entrypoint | null = null;

  #transformResultCode: string | null = null;

  private constructor(
    services: Services,
    parents: ParentEntrypoint[],
    public readonly initialCode: string | undefined,
    name: string,
    only: string[],
    exports: Record<string | symbol, unknown> | undefined,
    evaluatedOnly: string[],
    loadedAndParsed?: IEntrypointCode | IIgnoredEntrypoint,
    protected readonly resolveTasks = new Map<
      string,
      Promise<IEntrypointDependency>
    >(),
    readonly dependencies = new Map<string, IEntrypointDependency>(),
    readonly invalidationDependencies = new Map<
      string,
      IEntrypointDependency
    >(),
    readonly invalidateOnDependencyChange = new Set<string>(),
    generation = 1
  ) {
    super(
      services,
      evaluatedOnly,
      exports,
      generation,
      name,
      only,
      parents,
      dependencies,
      invalidationDependencies,
      invalidateOnDependencyChange
    );

    this.loadedAndParsed =
      loadedAndParsed ??
      services.loadAndParseFn(
        services,
        name,
        initialCode,
        parents[0]?.log ?? services.log
      );

    if (this.loadedAndParsed.code !== undefined) {
      services.cache.invalidateIfChanged(
        name,
        this.loadedAndParsed.code,
        undefined,
        this.initialCode === undefined ? 'fs' : 'loaded'
      );
    }

    const code =
      this.loadedAndParsed.evaluator === 'ignored'
        ? '[IGNORED]'
        : this.originalCode || EMPTY_FILE;

    this.log.extend('source')('created %s (%o)\n%s', name, only, code);
  }

  public get ignored() {
    return this.loadedAndParsed.evaluator === 'ignored';
  }

  public get originalCode() {
    return this.loadedAndParsed.code;
  }

  public get supersededWith(): Entrypoint | null {
    return this.#supersededWith?.supersededWith ?? this.#supersededWith;
  }

  public get transformedCode(): string | null {
    return (
      this.#transformResultCode ?? this.supersededWith?.transformedCode ?? null
    );
  }

  public static createRoot(
    services: Services,
    name: string,
    only: string[],
    loadedCode: string | undefined
  ): Entrypoint {
    const created = Entrypoint.create(services, null, name, only, loadedCode);
    invariant(created !== 'loop', 'loop detected');

    return created;
  }

  protected static create(
    services: Services,
    parent: ParentEntrypoint | null,
    name: string,
    only: string[],
    loadedCode: string | undefined
  ): Entrypoint | 'loop' {
    const { cache, eventEmitter } = services;
    return eventEmitter.perf('createEntrypoint', () => {
      const [status, entrypoint] = Entrypoint.innerCreate(
        services,
        parent
          ? {
              evaluated: parent.evaluated,
              log: parent.log,
              name: parent.name,
              parents: parent.parents,
              seqId: parent.seqId,
            }
          : null,
        name,
        only,
        loadedCode
      );

      if (status !== 'cached') {
        cache.add('entrypoints', name, entrypoint);
      }

      return status === 'loop' ? 'loop' : entrypoint;
    });
  }

  private static innerCreate(
    services: Services,
    parent: ParentEntrypoint | null,
    name: string,
    only: string[],
    loadedCode: string | undefined
  ): ['loop' | 'created' | 'cached', Entrypoint] {
    const { cache } = services;

    const cached = cache.get('entrypoints', name);
    let changed = false;
    if (loadedCode !== undefined) {
      changed = cache.invalidateIfChanged(
        name,
        loadedCode,
        undefined,
        'loaded'
      );
    } else if (cached && cached.initialCode === undefined) {
      try {
        changed = cache.invalidateIfChanged(
          name,
          fs.readFileSync(stripQueryAndHash(name), 'utf8'),
          undefined,
          'fs'
        );
      } catch {
        changed = false;
      }
    }

    if (!cached?.evaluated && cached?.ignored) {
      return ['cached', cached];
    }

    const exports = cached?.exports;
    const evaluatedOnly = changed ? [] : cached?.evaluatedOnly ?? [];

    const mergedOnly = cached?.only ? mergeOnly(cached.only, only) : [...only];

    if (cached?.evaluated) {
      cached.log('is already evaluated with', cached.evaluatedOnly);
    }

    if (!changed && cached && !cached.evaluated) {
      const isLoop = parent && hasLoop(name, parent);
      if (isLoop) {
        parent.log('[createEntrypoint] %s is a loop', name);
      }

      if (parent && !cached.parents.map((p) => p.name).includes(parent.name)) {
        cached.parents.push(parent);
      }

      if (isSuperSet(cached.only, mergedOnly)) {
        cached.log('is cached', name);
        return [isLoop ? 'loop' : 'cached', cached];
      }

      cached.log(
        'is cached, but with different `only` %o (the cached one %o)',
        only,
        cached?.only
      );

      if (cached.#isProcessing) {
        cached.deferOnlySupersede(mergedOnly);
        cached.log(
          'is being processed, defer supersede (%o -> %o)',
          cached.only,
          mergedOnly
        );
        return [isLoop ? 'loop' : 'cached', cached];
      }

      return [isLoop ? 'loop' : 'created', cached.supersede(mergedOnly)];
    }

    const newEntrypoint = new Entrypoint(
      services,
      parent ? [parent] : [],
      loadedCode,
      name,
      mergedOnly,
      exports,
      evaluatedOnly,
      undefined,
      cached && 'resolveTasks' in cached ? cached.resolveTasks : undefined,
      cached && 'dependencies' in cached ? cached.dependencies : undefined,
      cached && 'invalidationDependencies' in cached
        ? cached.invalidationDependencies
        : undefined,
      cached && 'invalidateOnDependencyChange' in cached
        ? cached.invalidateOnDependencyChange
        : undefined,
      cached ? cached.generation + 1 : 1
    );

    if (cached && !cached.evaluated) {
      cached.log('is cached, but with different code');
      cached.supersede(newEntrypoint);
    }

    return ['created', newEntrypoint];
  }

  public addDependency(dependency: IEntrypointDependency): void {
    this.resolveTasks.delete(dependency.source);
    this.dependencies.set(dependency.source, dependency);
  }

  public addInvalidationDependency(dependency: IEntrypointDependency): void {
    this.resolveTasks.delete(dependency.source);
    this.invalidationDependencies.set(dependency.source, dependency);
  }

  public addResolveTask(
    name: string,
    dependency: Promise<IEntrypointDependency>
  ): void {
    this.resolveTasks.set(name, dependency);
  }

  public applyDeferredSupersede() {
    if (this.#supersededWith || this.#pendingOnly === null) {
      return null;
    }

    const mergedOnly = mergeOnly(this.only, this.#pendingOnly);
    this.#pendingOnly = null;

    if (isSuperSet(this.only, mergedOnly)) {
      return null;
    }

    this.log('apply deferred supersede (%o -> %o)', this.only, mergedOnly);

    const nextEntrypoint = this.supersede(mergedOnly);
    this.services.cache.add('entrypoints', this.name, nextEntrypoint);

    return nextEntrypoint;
  }

  public assertNotSuperseded() {
    if (this.supersededWith) {
      this.log('superseded');
      throw new AbortError('superseded');
    }
  }

  public assertTransformed() {
    if (this.transformedCode === null) {
      this.log('not transformed');
      throw new UnprocessedEntrypointError(this.supersededWith ?? this);
    }
  }

  public beginProcessing() {
    this.#isProcessing = true;
  }

  public createAction<
    TType extends ActionTypes,
    TAction extends ActionByType<TType>,
  >(
    actionType: TType,
    data: TAction['data'],
    abortSignal: AbortSignal | null = null,
    actionContext: unknown = DEFAULT_ACTION_CONTEXT
  ): BaseAction<TAction> {
    if (!this.actionsCache.has(actionType)) {
      this.actionsCache.set(actionType, new Map());
    }

    const contexts = this.actionsCache.get(actionType)!;
    if (!contexts.has(actionContext)) {
      contexts.set(actionContext, new Map());
    }

    const cache = contexts.get(actionContext)!;
    const cached = cache.get(data);
    if (cached && !cached.abortSignal?.aborted) {
      return cached as BaseAction<TAction>;
    }

    const newAction = new BaseAction<TAction>(
      actionType as TAction['type'],
      this.services,
      this,
      data,
      abortSignal,
      actionContext
    );

    cache.set(data, newAction);

    this.services.eventEmitter.entrypointEvent(this.seqId, {
      type: 'actionCreated',
      actionType,
      actionIdx: newAction.idx,
    });

    return newAction;
  }

  public createChild(
    name: string,
    only: string[],
    loadedCode?: string
  ): Entrypoint | 'loop' {
    return Entrypoint.create(this.services, this, name, only, loadedCode);
  }

  public createEvaluated() {
    const evaluatedOnly = mergeOnly(this.evaluatedOnly, this.only);
    this.log('create EvaluatedEntrypoint for %o', evaluatedOnly);

    const evaluated = new EvaluatedEntrypoint(
      this.services,
      evaluatedOnly,
      this.exportsProxy,
      this.generation + 1,
      this.name,
      this.only,
      this.parents,
      this.dependencies,
      this.invalidationDependencies,
      this.invalidateOnDependencyChange
    );

    evaluated.initialCode = this.initialCode;

    return evaluated;
  }

  public endProcessing() {
    this.#isProcessing = false;
  }

  public getDependency(name: string): IEntrypointDependency | undefined {
    return this.dependencies.get(name);
  }

  public getInvalidationDependency(
    name: string
  ): IEntrypointDependency | undefined {
    return this.invalidationDependencies.get(name);
  }

  public markInvalidateOnDependencyChange(filename: string): void {
    this.invalidateOnDependencyChange.add(filename);
  }

  public getResolveTask(
    name: string
  ): Promise<IEntrypointDependency> | undefined {
    return this.resolveTasks.get(name);
  }

  public hasWywMetadata() {
    return this.#hasWywMetadata;
  }

  public onSupersede(callback: (newEntrypoint: Entrypoint) => void) {
    if (this.#supersededWith) {
      callback(this.#supersededWith);
      return () => {};
    }

    this.onSupersedeHandlers.push(callback);

    return () => {
      const index = this.onSupersedeHandlers.indexOf(callback);
      if (index >= 0) {
        this.onSupersedeHandlers.splice(index, 1);
      }
    };
  }

  public setTransformResult(res: ITransformFileResult | null) {
    this.#hasWywMetadata = Boolean(res?.metadata);
    this.#transformResultCode = res?.code ?? null;

    this.services.eventEmitter.entrypointEvent(this.seqId, {
      isNull: res === null,
      type: 'setTransformResult',
    });
  }

  private deferOnlySupersede(only: string[]) {
    this.#pendingOnly = this.#pendingOnly
      ? mergeOnly(this.#pendingOnly, only)
      : [...only];
  }

  private supersede(newOnlyOrEntrypoint: string[] | Entrypoint): Entrypoint {
    this.#pendingOnly = null;
    const newEntrypoint =
      newOnlyOrEntrypoint instanceof Entrypoint
        ? newOnlyOrEntrypoint
        : new Entrypoint(
            this.services,
            this.parents,
            this.initialCode,
            this.name,
            newOnlyOrEntrypoint,
            this.exports,
            this.evaluatedOnly,
            this.loadedAndParsed,
            this.resolveTasks,
            this.dependencies,
            this.invalidationDependencies,
            this.invalidateOnDependencyChange,
            this.generation + 1
          );

    this.services.eventEmitter.entrypointEvent(this.seqId, {
      type: 'superseded',
      with: newEntrypoint.seqId,
    });
    this.log(
      'superseded by %s (%o -> %o)',
      newEntrypoint.name,
      this.only,
      newEntrypoint.only
    );
    this.#supersededWith = newEntrypoint;
    this.onSupersedeHandlers.forEach((handler) => handler(newEntrypoint));

    return newEntrypoint;
  }
}
