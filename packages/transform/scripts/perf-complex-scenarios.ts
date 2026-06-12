/* eslint-disable no-await-in-loop, no-bitwise, no-console, no-continue, no-plusplus */
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  EventEmitter,
  TransformCacheCollection,
  disposeEvalBroker,
  oxcShaker,
  transform,
} from '../src/index';

type ScenarioFile = {
  code: string;
  hasTemplate?: boolean;
  transform?: boolean;
};

type ScenarioProject = {
  description: string;
  entryFile: string;
  files: Record<string, ScenarioFile>;
  targetFiles: string[];
};

type ScenarioContext = {
  root: string;
  size: SizeProfile;
};

type ScenarioDefinition = {
  build: (ctx: ScenarioContext) => ScenarioProject;
  description: string;
  name: string;
};

type ScenarioRun = {
  cssBytes: number;
  cssFiles: number;
  methodCounts: Record<string, number>;
  methodTotals: Record<string, number>;
  wallMs: number;
};

type SizeProfile = {
  barrelConsumers: number;
  barrelGroups: number;
  barrelLeavesPerGroup: number;
  constants: number;
  consumers: number;
  importsPerConsumer: number;
  overlapAggregates: number;
  overlapConsumers: number;
  overlapSpan: number;
};

type SizeName = keyof typeof SIZE_PROFILES;

type CliOptions = {
  iterations: number;
  json: boolean;
  keepFixtures: boolean;
  scenarios: string[] | null;
  size: SizeName;
  warmup: number;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const processorFile = path.resolve(
  scriptDir,
  '../src/__tests__/__fixtures__/test-css-processor.js'
);
const perfCssModule = '/vendor/perf-css.js';
const ENTRY_BASENAME = '/entry.js';
const SUMMARY_METHODS = [
  'transform:preeval',
  'transform:preeval:processTemplate',
  'transform:preeval:processTemplate:imports',
  'transform:preeval:processTemplate:imports:lookup',
  'transform:preeval:processTemplate:processors',
  'transform:preeval:removeDangerousCode',
  'transform:evaluator',
  'transform:evalFile',
  'transform:emitCommonJS',
] as const;

const SIZE_PROFILES = {
  small: {
    barrelConsumers: 10,
    barrelGroups: 3,
    barrelLeavesPerGroup: 3,
    constants: 96,
    consumers: 12,
    importsPerConsumer: 6,
    overlapAggregates: 4,
    overlapConsumers: 10,
    overlapSpan: 8,
  },
  medium: {
    barrelConsumers: 24,
    barrelGroups: 5,
    barrelLeavesPerGroup: 4,
    constants: 240,
    consumers: 28,
    importsPerConsumer: 8,
    overlapAggregates: 8,
    overlapConsumers: 22,
    overlapSpan: 12,
  },
  large: {
    barrelConsumers: 48,
    barrelGroups: 8,
    barrelLeavesPerGroup: 5,
    constants: 480,
    consumers: 56,
    importsPerConsumer: 10,
    overlapAggregates: 14,
    overlapConsumers: 44,
    overlapSpan: 16,
  },
} satisfies Record<string, SizeProfile>;

function dedent(source: string) {
  return source.replace(/^\n/, '').trimEnd();
}

const round = (value: number) => Math.round(value * 10) / 10;

const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const sigma = (values: number[]) => {
  if (values.length <= 1) {
    return 0;
  }

  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;

  return Math.sqrt(variance);
};

const range = (count: number) => Array.from({ length: count }, (_, idx) => idx);

const pad = (value: number, width = 3) => String(value).padStart(width, '0');

const tokenName = (idx: number) => `TOKEN_${pad(idx)}`;

const tokenValue = (idx: number) => {
  const seed = (idx * 1103515245 + 12345) >>> 0;
  const color = (seed & 0xffffff).toString(16).padStart(6, '0');
  return `#${color}`;
};

const createConstantsModule = (count: number) =>
  `${range(count)
    .map((idx) => `export const ${tokenName(idx)} = '${tokenValue(idx)}';`)
    .join('\n')}\n`;

const selectTokens = (
  count: number,
  importsPerConsumer: number,
  consumerIdx: number,
  stride = 7
) => {
  const tokens: string[] = [];

  for (let idx = 0; idx < importsPerConsumer; idx += 1) {
    const tokenIdx = (consumerIdx * stride + idx * 5) % count;
    tokens.push(tokenName(tokenIdx));
  }

  return tokens;
};

const relativeImport = (fromFile: string, toFile: string) => {
  const relative = path
    .relative(path.dirname(fromFile), toFile)
    .replaceAll(path.sep, '/');
  return relative.startsWith('.') ? relative : `./${relative}`;
};

const createPerfCssModule = () =>
  dedent(`
  export const css = (strings, ...values) => ({ strings, values });
`);

const writeProjectFiles = (
  root: string,
  files: Record<string, ScenarioFile>
) => {
  Object.entries(files).forEach(([relativePath, file]) => {
    const absolutePath = path.join(root, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.code);
  });
};

const formatImports = (names: string[], source: string) =>
  `import { ${names.join(', ')} } from '${source}';`;

const createTemplateBody = (tokens: string[]) => {
  const refs = [...tokens];
  while (refs.length < 8) {
    refs.push(refs[refs.length - 1] ?? refs[0] ?? 'undefined');
  }
  const [a, b, c, d, e, f, g, h] = refs;
  return dedent(`
    color: \${${a}};
    background: linear-gradient(\${${b}}, \${${c}});
    border: 1px solid \${${d}};
    box-shadow: 0 0 0 2px \${${e}};
    margin: \${${f}};
    padding: \${${g}};
    outline-color: \${${h ?? a}};
  `);
};

const createStaticConsumer = (
  idx: number,
  imports: string[],
  constantsImport: string
) =>
  dedent(`
  import { css } from 'perf-css';
  ${formatImports(imports, constantsImport)}

  export const className${idx} = css\`
    ${createTemplateBody(imports)}
  \`;
`);

const createFunctionalHelpers = () => ({
  '/shared/helpers/core.js': {
    code: dedent(`
      export const joinParts = (...parts) => parts.filter(Boolean).join(' ');
      export const takeOrFallback = (value, fallback) => value || fallback;
      export const withUnit = (value, unit = 'px') => {
        if (value.endsWith(unit)) {
          return value;
        }
        return \`\${value}\${unit}\`;
      };
    `),
    transform: true,
  },
  '/shared/helpers/formatters.js': {
    code: dedent(`
      import { joinParts, takeOrFallback, withUnit } from './core.js';

      export const tone = (primary, fallback) =>
        takeOrFallback(primary, fallback).toUpperCase();

      export const spacing = (value) =>
        withUnit(String(value).replace('#', '').slice(0, 2), 'px');

      export const border = (color, width) =>
        joinParts(withUnit(String(width).replace('#', '').slice(0, 2), 'px'), 'solid', color);

      export const shadow = (color, spread) =>
        joinParts('0', '0', '0', withUnit(String(spread).replace('#', '').slice(0, 1), 'px'), color);
    `),
    transform: true,
  },
});

const createFunctionalConsumer = (
  idx: number,
  imports: string[],
  constantsImport: string
) => {
  const refs = [...imports];
  while (refs.length < 8) {
    refs.push(refs[refs.length - 1] ?? refs[0] ?? 'undefined');
  }
  const [a, b, c, d, e, f, g, h] = refs;
  return dedent(`
    import { css } from 'perf-css';
    import { border, shadow, spacing, tone } from '../shared/helpers/formatters.js';
    ${formatImports(imports, constantsImport)}

    const resolvedTone${idx} = tone(${a}, ${b});
    const resolvedBorder${idx} = border(${c}, ${d});
    const resolvedShadow${idx} = shadow(${e}, ${f});
    const resolvedSpacing${idx} = spacing(${g});

    export const className${idx} = css\`
      color: \${resolvedTone${idx}};
      border: \${resolvedBorder${idx}};
      box-shadow: \${resolvedShadow${idx}};
      margin: \${resolvedSpacing${idx}};
      padding: \${spacing(${h ?? a})};
    \`;
  `);
};

const createEntryFile = (imports: { file: string; symbol: string }[]) => {
  const importLines = imports
    .map(
      ({ file, symbol }, idx) =>
        `import { ${symbol} as value${idx} } from '${file}';`
    )
    .join('\n');
  const exportedValues = imports.map((_, idx) => `value${idx}`).join(',\n  ');

  return dedent(`
    ${importLines}

    export const classes = [
      ${exportedValues}
    ];
  `);
};

const buildStaticFanoutScenario = ({ root, size }: ScenarioContext) => {
  const files: Record<string, ScenarioFile> = {
    [perfCssModule]: {
      code: createPerfCssModule(),
      transform: false,
    },
    '/shared/constants.js': {
      code: createConstantsModule(size.constants),
      transform: true,
    },
  };
  const consumerImports: { file: string; symbol: string }[] = [];

  range(size.consumers).forEach((idx) => {
    const file = `/consumers/static-${pad(idx, 2)}.js`;
    const imports = selectTokens(size.constants, size.importsPerConsumer, idx);
    files[file] = {
      code: createStaticConsumer(idx, imports, '../shared/constants.js'),
      hasTemplate: true,
      transform: true,
    };
    consumerImports.push({
      file: relativeImport(
        path.join(root, ENTRY_BASENAME),
        path.join(root, file)
      ),
      symbol: `className${idx}`,
    });
  });

  files[ENTRY_BASENAME] = {
    code: createEntryFile(consumerImports),
    transform: true,
  };

  const targetFiles = Object.entries(files)
    .filter(([, file]) => file.transform !== false)
    .map(([relative]) => path.join(root, relative))
    .sort();

  return {
    description:
      'Many files import direct constants from one shared module and emit css tags.',
    entryFile: path.join(root, ENTRY_BASENAME),
    files,
    targetFiles,
  };
};

const buildFunctionalFanoutScenario = ({ root, size }: ScenarioContext) => {
  const files: Record<string, ScenarioFile> = {
    [perfCssModule]: {
      code: createPerfCssModule(),
      transform: false,
    },
    '/shared/constants.js': {
      code: createConstantsModule(size.constants),
      transform: true,
    },
    ...createFunctionalHelpers(),
  };
  const consumerImports: { file: string; symbol: string }[] = [];

  range(size.consumers).forEach((idx) => {
    const file = `/consumers/functional-${pad(idx, 2)}.js`;
    const imports = selectTokens(
      size.constants,
      size.importsPerConsumer,
      idx + size.consumers,
      11
    );
    files[file] = {
      code: createFunctionalConsumer(idx, imports, '../shared/constants.js'),
      hasTemplate: true,
      transform: true,
    };
    consumerImports.push({
      file: relativeImport(
        path.join(root, ENTRY_BASENAME),
        path.join(root, file)
      ),
      symbol: `className${idx}`,
    });
  });

  files[ENTRY_BASENAME] = {
    code: createEntryFile(consumerImports),
    transform: true,
  };

  const targetFiles = Object.entries(files)
    .filter(([, file]) => file.transform !== false)
    .map(([relative]) => path.join(root, relative))
    .sort();

  return {
    description:
      'The same fanout, but every consumer routes constants through helper functions before css extraction.',
    entryFile: path.join(root, ENTRY_BASENAME),
    files,
    targetFiles,
  };
};

const buildWildcardBarrelScenario = ({ root, size }: ScenarioContext) => {
  const files: Record<string, ScenarioFile> = {
    [perfCssModule]: {
      code: createPerfCssModule(),
      transform: false,
    },
  };
  const barrelExports: string[] = [];
  const imports: { file: string; symbol: string }[] = [];

  range(size.barrelGroups).forEach((groupIdx) => {
    const leafExports: string[] = [];

    range(size.barrelLeavesPerGroup).forEach((leafIdx) => {
      const file = `/barrels/source/group-${pad(groupIdx, 2)}-leaf-${pad(
        leafIdx,
        2
      )}.js`;
      const names = range(size.importsPerConsumer).map((tokenIdx) => {
        const exportName = `BARREL_${pad(groupIdx, 2)}_${pad(leafIdx, 2)}_${pad(
          tokenIdx,
          2
        )}`;
        barrelExports.push(exportName);
        return exportName;
      });

      files[file] = {
        code: `${names
          .map(
            (name, idx) =>
              `export const ${name} = '${tokenValue(
                groupIdx * 64 + leafIdx * 8 + idx
              )}';`
          )
          .join('\n')}\n`,
        transform: true,
      };
      leafExports.push(file);
    });

    const groupFile = `/barrels/groups/group-${pad(groupIdx, 2)}.js`;
    files[groupFile] = {
      code: `${leafExports
        .map(
          (file) =>
            `export * from '${relativeImport(
              path.join(root, groupFile),
              path.join(root, file)
            )}';`
        )
        .join('\n')}\n`,
      transform: true,
    };
  });

  const barrelIndexFile = '/barrels/index.js';
  files[barrelIndexFile] = {
    code: `${range(size.barrelGroups)
      .map(
        (groupIdx) => `export * from './groups/group-${pad(groupIdx, 2)}.js';`
      )
      .join('\n')}\n`,
    transform: true,
  };

  range(size.barrelConsumers).forEach((idx) => {
    const file = `/consumers/barrel-${pad(idx, 2)}.js`;
    const offset = (idx * 5) % barrelExports.length;
    const selected = range(size.importsPerConsumer).map(
      (itemIdx) => barrelExports[(offset + itemIdx) % barrelExports.length]
    );

    files[file] = {
      code: createStaticConsumer(idx, selected, '../barrels/index.js'),
      hasTemplate: true,
      transform: true,
    };
    imports.push({
      file: relativeImport(
        path.join(root, ENTRY_BASENAME),
        path.join(root, file)
      ),
      symbol: `className${idx}`,
    });
  });

  files[ENTRY_BASENAME] = {
    code: createEntryFile(imports),
    transform: true,
  };

  const targetFiles = Object.entries(files)
    .filter(([, file]) => file.transform !== false)
    .map(([relative]) => path.join(root, relative))
    .sort();

  return {
    description:
      'Deep wildcard reexport barrels feeding many css-emitting consumers through export* chains.',
    entryFile: path.join(root, ENTRY_BASENAME),
    files,
    targetFiles,
  };
};

const buildOverlapScenario = ({ root, size }: ScenarioContext) => {
  const files: Record<string, ScenarioFile> = {
    [perfCssModule]: {
      code: createPerfCssModule(),
      transform: false,
    },
    '/shared/constants.js': {
      code: createConstantsModule(size.constants),
      transform: true,
    },
  };
  const entryImports: { file: string; symbol: string }[] = [];

  range(size.overlapConsumers).forEach((idx) => {
    const file = `/widgets/widget-${pad(idx, 2)}.js`;
    const imports = selectTokens(size.constants, size.overlapSpan, idx, 3);
    files[file] = {
      code: createStaticConsumer(idx, imports, '../shared/constants.js'),
      hasTemplate: true,
      transform: true,
    };
  });

  range(size.overlapAggregates).forEach((idx) => {
    const file = `/aggregates/section-${pad(idx, 2)}.js`;
    const exports = range(
      Math.max(2, Math.floor(size.overlapConsumers / size.overlapAggregates))
    ).map((offset) => (idx * 2 + offset) % size.overlapConsumers);
    files[file] = {
      code: `${exports
        .map(
          (widgetIdx) =>
            `export { className${widgetIdx} } from '../widgets/widget-${pad(
              widgetIdx,
              2
            )}.js';`
        )
        .join('\n')}\n`,
      transform: true,
    };
    exports.forEach((widgetIdx) => {
      entryImports.push({
        file: relativeImport(
          path.join(root, ENTRY_BASENAME),
          path.join(root, file)
        ),
        symbol: `className${widgetIdx}`,
      });
    });
  });

  files[ENTRY_BASENAME] = {
    code: createEntryFile(entryImports),
    transform: true,
  };

  const targetFiles = Object.entries(files)
    .filter(([, file]) => file.transform !== false)
    .map(([relative]) => path.join(root, relative))
    .sort();

  return {
    description:
      'Overlapping subsets of one shared constants file, plus a second named-reexport layer that widens shared dependency demand.',
    entryFile: path.join(root, ENTRY_BASENAME),
    files,
    targetFiles,
  };
};

const scenarios: ScenarioDefinition[] = [
  {
    build: buildWildcardBarrelScenario,
    description: 'Wildcard barrel fanout',
    name: 'wildcard-barrel-fanout',
  },
  {
    build: buildStaticFanoutScenario,
    description: 'Direct shared constants fanout',
    name: 'shared-constants-static-fanout',
  },
  {
    build: buildFunctionalFanoutScenario,
    description: 'Shared constants fanout via helper functions',
    name: 'shared-constants-functional-fanout',
  },
  {
    build: buildOverlapScenario,
    description: 'Overlapping imports plus named reexports',
    name: 'shared-constants-overlap-reexports',
  },
];

class PerfRecorder {
  public readonly emitter = new EventEmitter(
    (labels, type) => {
      const method =
        typeof labels.method === 'string' ? (labels.method as string) : null;
      if (!method) {
        return;
      }

      if (type === 'start') {
        this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
        const stack = this.stacks.get(method) ?? [];
        stack.push(performance.now());
        this.stacks.set(method, stack);
        return;
      }

      if (type === 'finish') {
        const stack = this.stacks.get(method);
        const startedAt = stack?.pop();
        if (startedAt === undefined) {
          return;
        }

        this.totals.set(
          method,
          (this.totals.get(method) ?? 0) + (performance.now() - startedAt)
        );
      }
    },
    () => 0,
    () => {}
  );

  private readonly counts = new Map<string, number>();

  private readonly stacks = new Map<string, number[]>();

  private readonly totals = new Map<string, number>();

  public countsSnapshot() {
    return Object.fromEntries(this.counts.entries());
  }

  public snapshot() {
    return Object.fromEntries(
      Array.from(this.totals.entries()).map(([method, value]) => [
        method,
        round(value),
      ])
    );
  }
}

const resolveWithExtensions = (candidate: string) => {
  const extensions = ['', '.js', '.mjs', '.cjs'];

  for (const ext of extensions) {
    const next = ext ? `${candidate}${ext}` : candidate;
    try {
      const source = readFileSync(next, 'utf8');
      return { file: next, source };
    } catch {
      continue;
    }
  }

  for (const ext of ['', '.js', '.mjs', '.cjs']) {
    const next = path.join(candidate, `index${ext}`);
    try {
      const source = readFileSync(next, 'utf8');
      return { file: next, source };
    } catch {
      continue;
    }
  }

  return null;
};

const createResolver = (root: string) => {
  return async (what: string, importer: string) => {
    if (what === 'perf-css') {
      return path.join(root, perfCssModule);
    }

    if (what.startsWith('.')) {
      return (
        resolveWithExtensions(path.resolve(path.dirname(importer), what))
          ?.file ?? null
      );
    }

    return null;
  };
};

const createPluginOptions = () => ({
  configFile: false,
  rules: [
    {
      action: oxcShaker,
      test: () => true,
    },
  ],
  tagResolver: (source: string, tag: string) => {
    if (source === 'perf-css' && tag === 'css') {
      return processorFile;
    }

    return null;
  },
});

const runScenarioOnce = async (
  scenario: ScenarioDefinition,
  project: ScenarioProject
): Promise<ScenarioRun> => {
  const recorder = new PerfRecorder();
  const cache = new TransformCacheCollection();
  const asyncResolve = createResolver(path.dirname(project.entryFile));
  const startedAt = performance.now();
  let cssBytes = 0;
  let cssFiles = 0;

  try {
    for (const filename of project.targetFiles) {
      const source = readFileSync(filename, 'utf8');
      const result = await transform(
        {
          asyncResolveKey: `perf:${scenario.name}`,
          cache,
          eventEmitter: recorder.emitter,
          options: {
            filename,
            preprocessor: 'none',
            root: path.dirname(project.entryFile),
            pluginOptions: createPluginOptions(),
          },
        },
        source,
        asyncResolve
      );

      if (source.includes('css`')) {
        if (!result.cssText) {
          throw new Error(
            `Scenario ${scenario.name} expected CSS output for ${filename}`
          );
        }

        cssFiles += 1;
        cssBytes += result.cssText.length;
      }
    }
  } finally {
    disposeEvalBroker(cache);
  }

  return {
    cssBytes,
    cssFiles,
    methodCounts: recorder.countsSnapshot(),
    methodTotals: recorder.snapshot(),
    wallMs: round(performance.now() - startedAt),
  };
};

const parseArgs = (): CliOptions => {
  const options: CliOptions = {
    iterations: 3,
    json: false,
    keepFixtures: false,
    scenarios: null,
    size: 'medium',
    warmup: 1,
  };

  const args = process.argv.slice(2);
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];

    if (arg === '--iterations') {
      options.iterations = Number(args[++idx]);
      continue;
    }

    if (arg === '--warmup') {
      options.warmup = Number(args[++idx]);
      continue;
    }

    if (arg === '--size') {
      const value = args[++idx] as SizeName;
      if (!(value in SIZE_PROFILES)) {
        throw new Error(`Unknown size profile: ${value}`);
      }
      options.size = value;
      continue;
    }

    if (arg === '--scenario') {
      options.scenarios ??= [];
      options.scenarios.push(args[++idx]);
      continue;
    }

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--keep-fixtures') {
      options.keepFixtures = true;
      continue;
    }

    if (arg === '--list') {
      console.log(scenarios.map((scenario) => scenario.name).join('\n'));
      process.exit(0);
    }

    if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun run ./scripts/perf-complex-scenarios.ts [options]

Options:
  --iterations <n>   measured runs per scenario (default: 3)
  --warmup <n>       warmup runs per scenario (default: 1)
  --size <profile>   small | medium | large (default: medium)
  --scenario <name>  run only the named scenario (repeatable)
  --json             print JSON summary after the table
  --keep-fixtures    keep generated temp projects on disk
  --list             print available scenario names
`);
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.iterations) || options.iterations < 1) {
    throw new Error('--iterations must be a positive number');
  }

  if (!Number.isFinite(options.warmup) || options.warmup < 0) {
    throw new Error('--warmup must be a non-negative number');
  }

  return options;
};

const printSummary = (
  summaries: Array<{
    description: string;
    files: number;
    name: string;
    root?: string;
    runs: ScenarioRun[];
  }>
) => {
  const header = [
    'Scenario'.padEnd(38),
    'Files'.padStart(5),
    'Wall ms'.padStart(16),
    'preeval'.padStart(10),
    'template'.padStart(10),
    'imports'.padStart(10),
    'lookup'.padStart(10),
    'procs'.padStart(10),
    'danger'.padStart(10),
    'shake'.padStart(10),
    'eval ms'.padStart(10),
    'eval #'.padStart(8),
  ].join(' ');

  console.log(header);
  console.log('-'.repeat(header.length));

  summaries.forEach((summary) => {
    const wallValues = summary.runs.map((run) => run.wallMs);
    const means = Object.fromEntries(
      SUMMARY_METHODS.map((method) => [
        method,
        round(mean(summary.runs.map((run) => run.methodTotals[method] ?? 0))),
      ])
    );
    const counts = Object.fromEntries(
      SUMMARY_METHODS.map((method) => [
        method,
        round(mean(summary.runs.map((run) => run.methodCounts[method] ?? 0))),
      ])
    );

    console.log(
      [
        summary.name.padEnd(38),
        String(summary.files).padStart(5),
        `${round(mean(wallValues)).toFixed(1)} ±${round(
          sigma(wallValues)
        ).toFixed(1)}`.padStart(16),
        `${means['transform:preeval'].toFixed(1)}`.padStart(10),
        `${means['transform:preeval:processTemplate'].toFixed(1)}`.padStart(10),
        `${means['transform:preeval:processTemplate:imports'].toFixed(
          1
        )}`.padStart(10),
        `${means['transform:preeval:processTemplate:imports:lookup'].toFixed(
          1
        )}`.padStart(10),
        `${means['transform:preeval:processTemplate:processors'].toFixed(
          1
        )}`.padStart(10),
        `${means['transform:preeval:removeDangerousCode'].toFixed(1)}`.padStart(
          10
        ),
        `${means['transform:evaluator'].toFixed(1)}`.padStart(10),
        `${means['transform:evalFile'].toFixed(1)}`.padStart(10),
        `${counts['transform:evalFile'].toFixed(1)}`.padStart(8),
      ].join(' ')
    );

    console.log(`  ${summary.description}`);
    if (summary.root) {
      console.log(`  fixture root: ${summary.root}`);
    }
  });
};

const main = async () => {
  const options = parseArgs();
  const selected = scenarios.filter((scenario) =>
    options.scenarios ? options.scenarios.includes(scenario.name) : true
  );

  if (selected.length === 0) {
    throw new Error('No scenarios selected');
  }

  const summaries: Array<{
    description: string;
    files: number;
    name: string;
    root?: string;
    runs: ScenarioRun[];
  }> = [];

  for (const scenario of selected) {
    const root = mkdtempSync(
      path.join(tmpdir(), `wyw-transform-perf-${scenario.name}-`)
    );
    const project = scenario.build({
      root,
      size: SIZE_PROFILES[options.size],
    });
    writeProjectFiles(root, project.files);

    try {
      for (let warmupIdx = 0; warmupIdx < options.warmup; warmupIdx += 1) {
        await runScenarioOnce(scenario, project);
      }

      const runs: ScenarioRun[] = [];
      for (let iteration = 0; iteration < options.iterations; iteration += 1) {
        runs.push(await runScenarioOnce(scenario, project));
      }

      summaries.push({
        description: project.description,
        files: project.targetFiles.length,
        name: scenario.name,
        root: options.keepFixtures ? root : undefined,
        runs,
      });
    } finally {
      if (!options.keepFixtures) {
        rmSync(root, { force: true, recursive: true });
      }
    }
  }

  printSummary(summaries);

  if (options.json) {
    console.log(
      JSON.stringify(
        summaries.map((summary) => ({
          description: summary.description,
          files: summary.files,
          name: summary.name,
          root: summary.root,
          runs: summary.runs,
        })),
        null,
        2
      )
    );
  }
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
