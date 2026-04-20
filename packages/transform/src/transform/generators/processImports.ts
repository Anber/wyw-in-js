/* eslint-disable no-continue */
import type {
  IProcessImportsAction,
  Services,
  SyncScenarioForAction,
} from '../types';

import { toImportKey } from '../../utils/importOverrides';

const warnedSlowImportsByServices = new WeakMap<Services, Set<string>>();

function emitWarning(services: Services, message: string) {
  if (services.emitWarning) {
    services.emitWarning(message);
    return;
  }

  // eslint-disable-next-line no-console
  console.warn(message);
}

function getWarnedSlowImports(services: Services): Set<string> {
  const cached = warnedSlowImportsByServices.get(services);
  if (cached) return cached;

  const created = new Set<string>();
  warnedSlowImportsByServices.set(services, created);
  return created;
}

function isWarningEnabled(value: string | undefined): boolean {
  return Boolean(value) && value !== '0' && value !== 'false';
}

/**
 * Creates new entrypoints and emits processEntrypoint for each resolved import
 */
export function* processImports(
  this: IProcessImportsAction
): SyncScenarioForAction<IProcessImportsAction> {
  const slowImportWarningsEnabled = isWarningEnabled(
    process.env.WYW_WARN_SLOW_IMPORTS
  );
  const slowImportThresholdMs = (() => {
    const raw = process.env.WYW_WARN_SLOW_IMPORTS_MS;
    if (!raw) return 50;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 50;
    return parsed;
  })();

  const warnedSlowImports = slowImportWarningsEnabled
    ? getWarnedSlowImports(this.services)
    : null;

  const { root } = this.services.options;

  for (const dependency of this.data.resolved) {
    const { resolved, only } = dependency;
    if (!resolved) {
      continue;
    }

    this.entrypoint.addDependency(dependency);

    const nextEntrypoint = this.entrypoint.createChild(resolved, only);
    if (nextEntrypoint === 'loop' || nextEntrypoint.ignored) {
      continue;
    }

    const startedAt = slowImportWarningsEnabled ? performance.now() : 0;
    yield* this.getNext('processEntrypoint', nextEntrypoint, undefined, null);

    if (
      slowImportWarningsEnabled &&
      warnedSlowImports &&
      slowImportThresholdMs > 0
    ) {
      const durationMs = performance.now() - startedAt;
      if (durationMs >= slowImportThresholdMs) {
        const { key: importKey } = toImportKey({
          source: dependency.source,
          resolved,
          root,
        });
        const dedupeKey = `${this.entrypoint.name}::${importKey}`;

        if (!warnedSlowImports.has(dedupeKey)) {
          warnedSlowImports.add(dedupeKey);

          const warning = [
            `[wyw-in-js] Slow import during prepare stage`,
            ``,
            `file: ${this.entrypoint.name}`,
            `import: ${dependency.source}`,
            `resolved: ${resolved}`,
            `duration: ${durationMs.toFixed(1)}ms`,
            ``,
            `tip: if this import is runtime-only or heavy, mock it during evaluation via importOverrides:`,
            `  importOverrides: {`,
            `    '${importKey}': { mock: './path/to/mock' },`,
            `  }`,
            ``,
            `note: importOverrides affects only build-time evaluation (it does not change your bundler runtime behavior)`,
            ``,
            `note: configure threshold with WYW_WARN_SLOW_IMPORTS_MS (current: ${slowImportThresholdMs}ms)`,
          ].join('\n');

          emitWarning(this.services, warning);
        }
      }
    }
  }
}
