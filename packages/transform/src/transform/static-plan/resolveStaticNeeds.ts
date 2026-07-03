import type { StaticNeed, StaticNeedRequest } from './types';

const addUnique = <T>(target: T[], value: T): void => {
  if (!target.includes(value)) {
    target.push(value);
  }
};

const getNeedOnly = (need: StaticNeed): string[] => {
  switch (need.kind) {
    case 'export':
      return [need.name];
    case 'processor-metadata':
      return [need.exportName];
    case 'eval':
      return need.only;
    default:
      throw new Error('Unsupported static need kind');
  }
};

export const planStaticNeedRequests = (
  needs: StaticNeed[]
): StaticNeedRequest[] => {
  const requests = new Map<string, StaticNeedRequest>();

  needs.forEach((need) => {
    const only = getNeedOnly(need);
    if (only.length === 0) {
      return;
    }

    const kind = need.kind === 'eval' ? 'eval' : 'dependency';
    const key = `${kind}\0${need.importer}\0${need.source}`;
    const request = requests.get(key) ?? {
      importer: need.importer,
      kind,
      only: [],
      reasons: [],
      source: need.source,
    };

    only.forEach((name) => addUnique(request.only, name));
    addUnique(request.reasons, need.reason);
    requests.set(key, request);
  });

  return [...requests.values()];
};

export type ResolveUnmetStaticNeedsInput = {
  filename: string;
  resolvedNames?: ReadonlySet<string>;
  runtimeOnlyNames?: ReadonlySet<string>;
  unresolvedNames?: readonly string[];
};

export const resolveUnmetStaticNeeds = ({
  filename,
  resolvedNames = new Set(),
  runtimeOnlyNames = new Set(),
  unresolvedNames = [],
}: ResolveUnmetStaticNeedsInput): StaticNeed[] => {
  const only = unresolvedNames.filter(
    (name, idx) =>
      unresolvedNames.indexOf(name) === idx &&
      !resolvedNames.has(name) &&
      !runtimeOnlyNames.has(name)
  );

  if (only.length === 0) {
    return [];
  }

  return [
    {
      importer: filename,
      kind: 'eval',
      only,
      reason: 'unresolved-static-value',
      source: filename,
    },
  ];
};
