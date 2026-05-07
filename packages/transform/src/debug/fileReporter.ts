/* eslint-disable no-console */
import { createWriteStream, existsSync, mkdirSync } from 'fs';
import path from 'path';

import type {
  OnAction,
  OnEvent,
  OnActionFinishArgs,
  OnActionStartArgs,
  OnEntrypointEvent,
  PerfFinishEvent,
} from '../utils/EventEmitter';
import { EventEmitter, isOnActionStartArgs } from '../utils/EventEmitter';

type Timings = Map<string, Map<string, number>>;

export interface IFileReporterOptions {
  dir?: string;
  print?: boolean;
}

export interface IProcessedEvent {
  file: string;
  fileIdx: string;
  imports: { from: string; what: string[] }[];
  only: string[];
  phase?: 'initial' | 'rewritten';
  type: 'dependency';
}

export interface IQueueActionEvent {
  action: string;
  args?: string[];
  datetime: Date;
  file: string;
  queueIdx: string;
  type: 'queue-action';
}

const workingDir = process.cwd();

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }

  if (typeof value === 'string' && path.isAbsolute(value)) {
    return path.relative(workingDir, value);
  }

  if (value instanceof Map) {
    return Array.from(value.entries()).reduce((obj, [k, v]) => {
      const key = replacer(k, k) as string;
      return {
        ...obj,
        [key]: replacer(key, v),
      };
    }, {});
  }

  return value;
}

function printTimings(timings: Timings, startedAt: number, sourceRoot: string) {
  if (timings.size === 0) {
    return;
  }

  console.log(`\nTimings:`);
  console.log(`  Total: ${(performance.now() - startedAt).toFixed()}ms`);

  Array.from(timings.entries()).forEach(([label, byLabel]) => {
    console.log(`\n  By ${label}:`);

    const array = Array.from(byLabel.entries());
    // array.sort(([, a], [, b]) => b - a);
    array
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([value, time]) => {
        const name = value.startsWith(sourceRoot)
          ? path.relative(sourceRoot, value)
          : value;
        console.log(`    ${name}: ${time}ms`);
      });
  });
}

const writeJSONl = (stream: NodeJS.WritableStream, data: unknown) => {
  stream.write(`${JSON.stringify(data, replacer)}\n`);
};

const isPerfFinishEvent = (event: unknown): event is PerfFinishEvent => {
  if (!event || typeof event !== 'object') {
    return false;
  }

  return (
    'type' in event &&
    event.type === 'perf-span' &&
    'method' in event &&
    typeof event.method === 'string' &&
    'spanId' in event &&
    typeof event.spanId === 'number' &&
    'startedAt' in event &&
    typeof event.startedAt === 'number' &&
    'finishedAt' in event &&
    typeof event.finishedAt === 'number' &&
    'durationMs' in event &&
    typeof event.durationMs === 'number'
  );
};

const isPerfStartEvent = (event: unknown) => {
  if (!event || typeof event !== 'object') {
    return false;
  }

  return 'type' in event && event.type === 'perf-span-start';
};

export const createFileReporter = (
  options: IFileReporterOptions | false = false
) => {
  if (!options || !options.dir) {
    return {
      emitter: EventEmitter.dummy,
      onDone: () => {},
    };
  }

  const reportFolder = existsSync(options.dir)
    ? options.dir
    : mkdirSync(options.dir, {
        recursive: true,
      });

  if (!reportFolder) {
    throw new Error(`Could not create directory ${options.dir}`);
  }

  const actionStream = createWriteStream(
    path.join(options.dir, 'actions.jsonl')
  );

  const dependenciesStream = createWriteStream(
    path.join(options.dir, 'dependencies.jsonl')
  );

  const entrypointStream = createWriteStream(
    path.join(options.dir, 'entrypoints.jsonl')
  );

  const staticResolveStream = createWriteStream(
    path.join(options.dir, 'static-resolve.jsonl')
  );

  const perfSpanStream = createWriteStream(
    path.join(options.dir, 'perf-spans.jsonl')
  );

  const startedAt = performance.now();
  const timings: Timings = new Map();
  const addTiming = (label: string, key: string, value: number) => {
    if (!timings.has(label)) {
      timings.set(label, new Map());
    }

    const forLabel = timings.get(label)!;
    forLabel.set(key, Math.round((forLabel.get(key) || 0) + value));
  };

  const processDependencyEvent = ({
    file,
    only,
    imports,
    fileIdx,
  }: IProcessedEvent) => {
    writeJSONl(dependenciesStream, {
      file,
      only,
      imports,
      fileIdx,
    });
  };

  const processSingleEvent = (
    meta: Record<string, unknown> | IProcessedEvent | IQueueActionEvent
  ) => {
    if (meta.type === 'dependency') {
      processDependencyEvent(meta as IProcessedEvent);
      return;
    }

    if (meta.type === 'staticResolve') {
      writeJSONl(staticResolveStream, meta);
    }
  };

  const startTimes = new Map<string, number>();

  const onEvent: OnEvent = (meta, type, event) => {
    if (type === 'single') {
      processSingleEvent(meta);
      return;
    }

    if (type === 'finish' && isPerfFinishEvent(event)) {
      addTiming('method', event.method, event.durationMs);
      writeJSONl(perfSpanStream, event);
      return;
    }

    if (type === 'start' && isPerfStartEvent(event)) {
      return;
    }

    if (type === 'start') {
      Object.entries(meta).forEach(([label, value]) => {
        startTimes.set(`${label}\0${value}`, performance.now());
      });
    } else {
      Object.entries(meta).forEach(([label, value]) => {
        const startTime = startTimes.get(`${label}\0${value}`);
        if (startTime) {
          addTiming(label, String(value), performance.now() - startTime);
        }
      });
    }
  };

  let actionId = 0;
  const onAction: OnAction = (
    ...args: OnActionStartArgs | OnActionFinishArgs
  ) => {
    if (isOnActionStartArgs(args)) {
      const [, timestamp, type, idx, entrypointRef] = args;
      writeJSONl(actionStream, {
        actionId,
        entrypointRef,
        idx,
        startedAt: timestamp,
        type,
      });

      // eslint-disable-next-line no-plusplus
      return actionId++;
    }

    const [result, timestamp, id, isAsync, error] = args;
    writeJSONl(actionStream, {
      actionId: id,
      error,
      finishedAt: timestamp,
      isAsync,
      result: `${result}ed`,
    });

    return id;
  };

  const onEntrypointEvent: OnEntrypointEvent = (
    emitterId,
    timestamp,
    event
  ) => {
    entrypointStream.write(
      `${JSON.stringify([emitterId, timestamp, event])}\n`
    );
  };

  const emitter = new EventEmitter(onEvent, onAction, onEntrypointEvent);

  return {
    emitter,
    onDone: (sourceRoot: string) => {
      if (options.print) {
        printTimings(timings, startedAt, sourceRoot);

        console.log('\nMemory usage:', process.memoryUsage());
      }

      actionStream.end();
      dependenciesStream.end();
      entrypointStream.end();
      staticResolveStream.end();
      perfSpanStream.end();
      timings.clear();
    },
  };
};
