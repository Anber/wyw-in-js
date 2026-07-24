import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import dedent from 'dedent';

import { TransformCacheCollection } from '../cache';
import { transform } from '../transform';
import type { PluginOptions } from '../types';
import { EventEmitter } from '../utils/EventEmitter';

const processorFile = join(__dirname, '__fixtures__', 'test-css-processor.js');

const PREEVAL_EXPORT = 'preevalStyleValue';

const preevalModuleSource = dedent`
  exports.${PREEVAL_EXPORT} = (shape, options) => {
    if (shape === null || typeof shape !== 'object') {
      throw new Error('fixture-preeval: shape must be an object');
    }

    const tone = options && typeof options.tone === 'string' ? options.tone : 'base';
    if (tone === 'broken') {
      return { onResolve: () => tone };
    }

    return {
      __wyw_meta: { className: 'fx-' + tone, extends: null },
      className: 'fx-' + tone,
      tokens: Object.fromEntries(
        Object.keys(shape).map((key) => [key, 'var(--fx-' + tone + '-' + key + ')'])
      ),
    };
  };
`;

const preevalCallProcessorSource = (packageName: string) => dedent`
  const { createRequire } = require('module');
  const workspaceRequire = createRequire(${JSON.stringify(processorFile)});
  const { BaseProcessor } = workspaceRequire('@wyw-in-js/processor-utils');

  class PreevalCallFixtureProcessor extends BaseProcessor {
    constructor(params, ...args) {
      super([params[0]], ...args);
      const callParam = params.find((param) => param[0] === 'call');
      this.expressions = callParam ? callParam.slice(1) : [];
      this.dependencies.push(
        ...this.expressions.filter((expression) => expression.ex.type === 'Identifier')
      );
    }

    get asSelector() {
      return \`.\${this.className}\`;
    }

    get value() {
      return this.astService.callExpression(
        this.astService.identifier('__fixturePreevalStyleValue'),
        this.expressions.map((expression) => expression.ex)
      );
    }

    build() {}

    doEvaltimeReplacement() {
      this.replacer(
        () =>
          this.astService.callExpression(
            this.astService.addNamedImport(
              ${JSON.stringify(PREEVAL_EXPORT)},
              '${packageName}/dist/preeval-fixture.cjs',
              ${JSON.stringify(PREEVAL_EXPORT)}
            ),
            this.expressions.map((expression) =>
              // Lazy values are hoisted thunks and must be called; const
              // expressions are inlined as-is (ValueType.CONST === 2).
              expression.kind === 2
                ? expression.ex
                : this.astService.callExpression(expression.ex, [])
            )
          ),
        false
      );
    }

    doRuntimeReplacement() {
      this.replacer(this.astService.stringLiteral(this.className), false);
    }
  }

  module.exports = { default: PreevalCallFixtureProcessor };
`;

let packageId = 0;

const writePreevalProcessorPackage = (root: string): string => {
  packageId += 1;
  const packageName = `preeval-call-fixture-${process.pid}-${packageId}`;
  const packageRoot = join(root, 'node_modules', packageName);
  const distRoot = join(packageRoot, 'dist');

  mkdirSync(distRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        main: './index.js',
        'wyw-in-js': {
          tags: {
            fxStyle: './dist/fxStyle.processor.json',
          },
        },
      },
      null,
      2
    )
  );
  writeFileSync(join(packageRoot, 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(distRoot, 'fxStyle-processor.js'),
    preevalCallProcessorSource(packageName)
  );
  writeFileSync(join(distRoot, 'preeval-fixture.cjs'), preevalModuleSource);
  writeFileSync(
    join(distRoot, 'fxStyle.processor.json'),
    JSON.stringify(
      {
        version: 1,
        name: packageName,
        implementation: './fxStyle-processor.js',
        tags: ['fxStyle'],
        semantics: {
          kind: 'preeval-call',
          module: './preeval-fixture.cjs',
          export: PREEVAL_EXPORT,
        },
      },
      null,
      2
    )
  );

  return packageName;
};

const createPerfEventRecorder = () => {
  const counts = new Map<string, number>();
  const eventEmitter = new EventEmitter(
    (labels, type) => {
      if (type !== 'start' || typeof labels.method !== 'string') {
        return;
      }

      counts.set(labels.method, (counts.get(labels.method) ?? 0) + 1);
    },
    () => 0,
    () => {}
  );

  return { counts, eventEmitter };
};

const runTransform = async (
  root: string,
  entryFile: string,
  eventEmitter?: EventEmitter,
  pluginOptions: Partial<PluginOptions> = {}
) =>
  transform(
    {
      cache: new TransformCacheCollection(),
      eventEmitter,
      options: {
        filename: entryFile,
        root,
        pluginOptions: {
          configFile: false,
          tagResolver: (source, tag) => {
            if (source === 'test-css-processor' && tag === 'css') {
              return processorFile;
            }

            return null;
          },
          ...pluginOptions,
        } as Partial<PluginOptions>,
      },
    },
    readFileSync(entryFile, 'utf8'),
    async (what: string, importer: string) => {
      if (what === 'test-css-processor') {
        return processorFile;
      }

      if (what.startsWith('.')) {
        return resolve(dirname(importer), what);
      }

      const packageSubpath = join(root, 'node_modules', what);
      if (what.includes('/') && existsSync(packageSubpath)) {
        return packageSubpath;
      }

      const packageMain = join(root, 'node_modules', what, 'index.js');
      return existsSync(packageMain) ? packageMain : null;
    }
  );

describe('preeval-call manifest semantics', () => {
  it('computes same-file values through the manifest preeval module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-preeval-call-'));
    const packageName = writePreevalProcessorPackage(root);
    const entryFile = join(root, 'entry.js');
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { fxStyle } from '${packageName}';
        import { css } from 'test-css-processor';

        const sheet = fxStyle({ color: null, gap: null }, { tone: 'brand' });

        export const className = css\`
          color: ${'${sheet.tokens.color}'};
          gap: ${'${sheet.tokens.gap}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, perf.eventEmitter);

      expect(result.cssText).toContain('color:var(--fx-brand-color)');
      expect(result.cssText).toContain('gap:var(--fx-brand-gap)');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('computes cross-file exported values without evaluating the module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-preeval-call-'));
    const packageName = writePreevalProcessorPackage(root);
    const entryFile = join(root, 'entry.js');
    const sheetFile = join(root, 'sheet.js');
    const perf = createPerfEventRecorder();

    writeFileSync(
      sheetFile,
      dedent`
        import { fxStyle } from '${packageName}';

        export const sheet = fxStyle({ accent: null }, { tone: 'shared' });
      `
    );
    writeFileSync(
      entryFile,
      dedent`
        import { css } from 'test-css-processor';
        import { sheet } from './sheet.js';

        export const className = css\`
          color: ${'${sheet.tokens.accent}'};
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, perf.eventEmitter);

      expect(result.cssText).toContain('color:var(--fx-shared-accent)');
      expect(result.code).not.toContain('./sheet.js');
      expect(result.dependencies).toContain(sheetFile);
      expect(perf.counts.get('transform:evalFile') ?? 0).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval when the preeval module throws, keeping its diagnostic', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-preeval-call-'));
    const packageName = writePreevalProcessorPackage(root);
    const entryFile = join(root, 'entry.js');
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { fxStyle } from '${packageName}';
        import { css } from 'test-css-processor';

        const sheet = fxStyle(42, { tone: 'brand' });

        export const className = css\`
          color: ${'${sheet.tokens ? sheet.tokens.color : "red"}'};
        \`;
      `
    );

    try {
      await expect(
        runTransform(root, entryFile, perf.eventEmitter)
      ).rejects.toThrow('fixture-preeval: shape must be an object');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to eval for non-serializable preeval results', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wyw-preeval-call-'));
    const packageName = writePreevalProcessorPackage(root);
    const entryFile = join(root, 'entry.js');
    const perf = createPerfEventRecorder();

    writeFileSync(
      entryFile,
      dedent`
        import { fxStyle } from '${packageName}';
        import { css } from 'test-css-processor';

        const sheet = fxStyle({ color: null }, { tone: 'broken' });

        export const className = css\`
          content: "${'${typeof sheet.onResolve}'}";
        \`;
      `
    );

    try {
      const result = await runTransform(root, entryFile, perf.eventEmitter);

      expect(result.cssText).toContain('content:"function"');
      expect(perf.counts.get('transform:evalFile') ?? 0).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
