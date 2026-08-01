/* eslint-disable no-restricted-syntax */

export type TaggedBindingProvenance = {
  bindings: Set<string>;
  mayAliasAnyRootImport: boolean;
};

export type ProvenanceClosureNode = TaggedBindingProvenance & {
  dependencies: ReadonlySet<string>;
};

export type MutableProvenanceClosureNode = ProvenanceClosureNode & {
  dependencies: Set<string>;
};

export type ProvenanceClosureIndex = {
  pathsMayAliasAnyRootImport: (paths: Iterable<string>) => boolean;
  resolve: (seeds: Iterable<string>) => TaggedBindingProvenance;
  visitDependents: (
    binding: string,
    visited: Set<string>,
    visit: (path: string) => void
  ) => void;
};

export const createTaggedBindingProvenance = (): TaggedBindingProvenance => ({
  bindings: new Set<string>(),
  mayAliasAnyRootImport: false,
});

export const mergeTaggedBindingProvenance = (
  target: TaggedBindingProvenance,
  source: TaggedBindingProvenance
): void => {
  const mutableTarget = target;
  source.bindings.forEach((binding) => target.bindings.add(binding));
  mutableTarget.mayAliasAnyRootImport ||= source.mayAliasAnyRootImport;
};

export const createMutableProvenanceClosureNode = (
  bindings: Iterable<string> = []
): MutableProvenanceClosureNode => ({
  bindings: new Set(bindings),
  dependencies: new Set<string>(),
  mayAliasAnyRootImport: false,
});

export const mergeProvenanceClosureNode = (
  target: MutableProvenanceClosureNode,
  source: MutableProvenanceClosureNode
): void => {
  mergeTaggedBindingProvenance(target, source);
  source.dependencies.forEach((binding) => target.dependencies.add(binding));
};

export const resolveProvenanceAliases = (
  binding: string,
  aliases: ReadonlyMap<string, ReadonlySet<string>>,
  resolving = new Set<string>()
): Set<string> => {
  const mapped = aliases.get(binding);
  if (!mapped) {
    return new Set([binding]);
  }
  if (mapped.size === 0 || resolving.has(binding)) {
    return new Set();
  }

  const roots = new Set<string>();
  const nextResolving = new Set(resolving);
  nextResolving.add(binding);
  mapped.forEach((alias) => {
    resolveProvenanceAliases(alias, aliases, nextResolving).forEach((root) =>
      roots.add(root)
    );
  });
  return roots;
};

export const createNormalizedCatalogResolver = <T>(
  catalog: ReadonlyMap<string, T>,
  normalize: (path: string) => string
): ((path: string) => Set<T>) => {
  const normalizedCatalog = new Map<string, Set<T>>();
  catalog.forEach((value, path) => {
    const normalized = normalize(path);
    const candidates = normalizedCatalog.get(normalized) ?? new Set<T>();
    candidates.add(value);
    normalizedCatalog.set(normalized, candidates);
  });
  return (path) => new Set(normalizedCatalog.get(normalize(path)));
};

/** Resolves reachable cycles into one fresh, query-scoped accumulator. */
export const createProvenanceClosureIndex = (
  nodes: ReadonlyMap<string, ProvenanceClosureNode>,
  getBindingKey: (binding: string) => string = (binding) => binding
): ProvenanceClosureIndex => {
  const dependents = new Map<string, Set<string>>();
  const nodesByBinding = new Map<string, Set<string>>();
  nodes.forEach((node, path) => {
    node.dependencies.forEach((dependency) => {
      const paths = dependents.get(dependency) ?? new Set();
      paths.add(path);
      dependents.set(dependency, paths);
    });
    node.bindings.forEach((binding) => {
      const bindingKey = getBindingKey(binding);
      const paths = nodesByBinding.get(bindingKey) ?? new Set();
      paths.add(path);
      nodesByBinding.set(bindingKey, paths);
    });
  });

  const pathsAliasingAnyRootImport = new Set<string>();
  const pendingImportedPaths = [...nodes]
    .filter(([, node]) => node.mayAliasAnyRootImport)
    .map(([path]) => path);
  for (let cursor = 0; cursor < pendingImportedPaths.length; cursor += 1) {
    const path = pendingImportedPaths[cursor]!;
    if (!pathsAliasingAnyRootImport.has(path)) {
      pathsAliasingAnyRootImport.add(path);
      dependents
        .get(path)
        ?.forEach((dependent) => pendingImportedPaths.push(dependent));
    }
  }

  const resolve = (seeds: Iterable<string>): TaggedBindingProvenance => {
    const result = createTaggedBindingProvenance();
    const visited = new Set<string>();
    const pending = [...seeds];
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const key = pending[cursor]!;
      if (!visited.has(key)) {
        visited.add(key);
        const node = nodes.get(key);
        if (node) {
          node.bindings.forEach((binding) => result.bindings.add(binding));
          result.mayAliasAnyRootImport ||= node.mayAliasAnyRootImport;
          pending.push(...node.dependencies);
        }
      }
    }
    return result;
  };

  return {
    pathsMayAliasAnyRootImport: (paths) =>
      [...paths].some((path) => pathsAliasingAnyRootImport.has(path)),
    resolve,
    visitDependents: (binding, visited, visit) => {
      const pending = [...(nodesByBinding.get(getBindingKey(binding)) ?? [])];
      for (let cursor = 0; cursor < pending.length; cursor += 1) {
        const path = pending[cursor]!;
        if (!visited.has(path)) {
          visited.add(path);
          visit(path);
          dependents.get(path)?.forEach((dependent) => pending.push(dependent));
        }
      }
    },
  };
};
