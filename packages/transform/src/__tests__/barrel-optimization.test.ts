import fs from 'fs';
import os from 'os';
import path from 'path';

import { TransformCacheCollection } from '../cache';
import { Entrypoint } from '../transform/Entrypoint';
import { syncActionRunner } from '../transform/actions/actionRunner';
import { baseProcessingHandlers } from '../transform/generators/baseProcessingHandlers';
import { syncResolveImports } from '../transform/generators/resolveImports';
import { loadWywOptions } from '../transform/helpers/loadWywOptions';
import { withDefaultServices } from '../transform/helpers/withDefaultServices';
import type { IResolveImportsAction } from '../transform/types';
import { EventEmitter, type EntrypointEvent } from '../utils/EventEmitter';

const extensions = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
];

const resolveWithExtensions = (candidate: string): string | null => {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }

  for (const ext of extensions) {
    const withExt = `${candidate}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  return null;
};

const createResolver =
  (root: string) =>
  (what: string, importer: string): string => {
    if (path.isAbsolute(what)) {
      const resolved = resolveWithExtensions(what);
      if (resolved) {
        return resolved;
      }
    }

    if (what.startsWith('.')) {
      const resolved = resolveWithExtensions(
        path.resolve(path.dirname(importer), what)
      );
      if (resolved) {
        return resolved;
      }
    }

    throw new Error(
      `Unexpected resolve ${JSON.stringify(what)} from ${importer} in ${root}`
    );
  };

const createRecorder = () => {
  const singles: Record<string, unknown>[] = [];
  const entrypointEvents: Array<{
    event: EntrypointEvent;
    idx: number;
  }> = [];

  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type === 'single') {
        singles.push(labels);
      }
    },
    () => 0,
    (idx, _timestamp, event) => {
      entrypointEvents.push({ idx, event });
    }
  );

  return {
    entrypointEvents,
    eventEmitter,
    singles,
  };
};

const createServices = (
  root: string,
  filename: string,
  cache: TransformCacheCollection,
  eventEmitter: EventEmitter
) =>
  withDefaultServices({
    cache,
    eventEmitter,
    options: {
      filename,
      root,
      pluginOptions: loadWywOptions({
        babelOptions: {
          babelrc: false,
          configFile: false,
          presets: ['@babel/preset-typescript'],
        },
        configFile: false,
      }),
    },
  });

const runEntrypoint = (
  root: string,
  filename: string,
  cache: TransformCacheCollection,
  eventEmitter: EventEmitter
) => {
  const services = createServices(root, filename, cache, eventEmitter);
  const entrypoint = Entrypoint.createRoot(
    services,
    filename,
    ['*'],
    undefined
  );
  if (entrypoint.ignored) {
    throw new Error(`Unexpected ignored entrypoint ${filename}`);
  }

  const handlers = {
    ...baseProcessingHandlers,
    resolveImports(this: IResolveImportsAction) {
      return syncResolveImports.call(this, createResolver(root));
    },
  };

  syncActionRunner(
    entrypoint.createAction('processEntrypoint', undefined, null),
    handlers
  );

  return entrypoint;
};

describe('barrel optimization', () => {
  it('rewrites pure barrel imports to leaf modules and reuses the manifest cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-opt-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const blueFile = path.join(root, 'blue.ts');
      const consumerA = path.join(root, 'consumer-a.ts');
      const consumerB = path.join(root, 'consumer-b.ts');

      fs.writeFileSync(
        barrelFile,
        `export { red } from './red';\nexport { blue } from './blue';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(blueFile, `export const blue = 'blue';\n`);
      fs.writeFileSync(
        consumerA,
        `import { red } from './barrel';\nexport const value = red;\n`
      );
      fs.writeFileSync(
        consumerB,
        `import { blue } from './barrel';\nexport const value = blue;\n`
      );

      const cache = new TransformCacheCollection();
      const recorder = createRecorder();

      const first = runEntrypoint(
        root,
        consumerA,
        cache,
        recorder.eventEmitter
      );
      const second = runEntrypoint(
        root,
        consumerB,
        cache,
        recorder.eventEmitter
      );

      expect(first.transformedCode).toContain(redFile);
      expect(first.transformedCode).not.toContain(barrelFile);
      expect(second.transformedCode).toContain(blueFile);
      expect(second.transformedCode).not.toContain(barrelFile);

      expect(
        recorder.singles
          .filter(
            (event) =>
              event.kind === 'barrelManifest' && event.file === barrelFile
          )
          .map((event) => event.status)
      ).toEqual(['built', 'hit']);

      const barrelEntrypointIds = recorder.entrypointEvents
        .filter(
          ({ event }) =>
            event.type === 'created' && event.filename === barrelFile
        )
        .map(({ idx }) => idx);

      expect(
        recorder.entrypointEvents.filter(
          ({ event, idx }) =>
            event.type === 'superseded' && barrelEntrypointIds.includes(idx)
        )
      ).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rewrites export-star barrel chains to the final leaf modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-star-'));

    try {
      const baseFile = path.join(root, 'base.ts');
      const midFile = path.join(root, 'mid.ts');
      const consumerFile = path.join(root, 'consumer.ts');

      fs.writeFileSync(
        baseFile,
        `export default 42;\nexport const alpha = 'alpha';\n`
      );
      fs.writeFileSync(
        midFile,
        `export * from './base';\nexport { default as thing } from './base';\n`
      );
      fs.writeFileSync(
        consumerFile,
        `export * from './mid';\nexport { thing } from './mid';\n`
      );

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        new TransformCacheCollection(),
        createRecorder().eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(baseFile);
      expect(entrypoint.transformedCode).not.toContain(midFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the original barrel path for impure barrels', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wyw-barrel-impure-'));

    try {
      const barrelFile = path.join(root, 'barrel.ts');
      const redFile = path.join(root, 'red.ts');
      const consumerFile = path.join(root, 'consumer.ts');
      const cache = new TransformCacheCollection();
      const recorder = createRecorder();

      fs.writeFileSync(
        barrelFile,
        `console.log('side effect');\nexport { red } from './red';\n`
      );
      fs.writeFileSync(redFile, `export const red = 'red';\n`);
      fs.writeFileSync(
        consumerFile,
        `import { red } from './barrel';\nexport const value = red;\n`
      );

      const entrypoint = runEntrypoint(
        root,
        consumerFile,
        cache,
        recorder.eventEmitter
      );

      expect(entrypoint.transformedCode).toContain(`require("./barrel")`);
      expect(entrypoint.transformedCode).not.toContain(`require("${redFile}")`);
      expect(
        recorder.entrypointEvents.filter(
          ({ event }) =>
            event.type === 'created' && event.filename === barrelFile
        )
      ).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
