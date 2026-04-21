import { spawnSync } from 'child_process';

type ResolveFilenameParent = {
  filename: string;
  id: string;
  paths: string[];
};

type ResolveFilenameModuleImplementation = {
  _resolveFilename: (
    id: string,
    options: ResolveFilenameParent,
    isMain?: boolean,
    resolveOptions?: { conditions?: Set<string> }
  ) => string;
};

type NodeConditionalResolveResult = {
  error?: { code?: string; message: string };
  resolved?: string;
};

const NODE_CONDITIONAL_RESOLVE_SCRIPT = String.raw`
const fs = require('node:fs');
const Module = require('node:module');

const input = JSON.parse(fs.readFileSync(0, 'utf8'));

try {
  const resolved = Module._resolveFilename(
    input.id,
    input.parent,
    false,
    input.conditions ? { conditions: new Set(input.conditions) } : undefined
  );
  fs.writeFileSync(1, JSON.stringify({ resolved }));
} catch (error) {
  fs.writeFileSync(
    1,
    JSON.stringify({
      error: {
        code:
          error && typeof error === 'object' && 'code' in error
            ? error.code
            : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
    })
  );
  process.exitCode = 1;
}
`;

const isBunRuntime = () => process.execPath.includes('bun');

const resolveWithNodeProcess = (
  id: string,
  parent: ResolveFilenameParent,
  conditions: Set<string>
): string => {
  const nodeBinary = process.env.WYW_NODE_BINARY || 'node';
  const result = spawnSync(
    nodeBinary,
    ['-e', NODE_CONDITIONAL_RESOLVE_SCRIPT],
    {
      encoding: 'utf8',
      input: JSON.stringify({
        conditions: [...conditions],
        id,
        parent,
      }),
      maxBuffer: 1024 * 1024,
    }
  );

  if (result.error) {
    throw result.error;
  }

  let parsed: NodeConditionalResolveResult | null = null;
  const stdout = result.stdout.trim();
  if (stdout) {
    try {
      parsed = JSON.parse(stdout) as NodeConditionalResolveResult;
    } catch {
      throw new Error(
        [
          '[wyw-in-js] Failed to parse Node resolver fallback output.',
          `stdout: ${stdout}`,
          result.stderr ? `stderr: ${result.stderr.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
  }

  if (parsed?.error) {
    const error = new Error(parsed.error.message) as NodeJS.ErrnoException;
    error.code = parsed.error.code;
    throw error;
  }

  if (result.status !== 0 || !parsed?.resolved) {
    throw new Error(
      [
        '[wyw-in-js] Node resolver fallback failed.',
        `status: ${result.status ?? 'null'}`,
        result.stderr ? `stderr: ${result.stderr.trim()}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return parsed.resolved;
};

export const resolveFilenameWithConditions = (
  moduleImpl: ResolveFilenameModuleImplementation,
  id: string,
  parent: ResolveFilenameParent,
  conditions?: Set<string>
): string => {
  const resolveOptions = conditions ? { conditions } : undefined;
  if (!conditions || !isBunRuntime()) {
    return moduleImpl._resolveFilename(id, parent, false, resolveOptions);
  }

  // Bun crashes on macOS/Silicon in this exact path:
  //   Module._resolveFilename(specifier, parent, false, { conditions })
  // We reproduced it both with a tiny standalone script and through the
  // `EvalBroker > passes conditionNames to node fallback resolution` test,
  // including on Bun 1.3.13. Keep this fallback narrow: only conditioned
  // resolution under Bun goes through a short-lived Node subprocess.
  //
  // Cleanup criteria:
  // 1. Bun passes the minimal local `_resolveFilename(..., { conditions })`
  //    repro on macOS without segfaulting.
  // 2. The conditionNames runner path passes without this fallback.
  //
  // As of 2026-04-20 we did not find an exact open upstream Bun issue for this
  // `_resolveFilename(..., { conditions })` crash, so keep the comment factual
  // and the workaround self-contained.
  return resolveWithNodeProcess(id, parent, conditions);
};
