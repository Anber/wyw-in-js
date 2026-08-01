type RecursiveProofSharedState<T extends object> = {
  active: T[];
  uncacheable: WeakSet<T>;
};

export type RecursiveProofState<T extends object> = {
  completed: WeakMap<T, boolean> | null;
  shared: RecursiveProofSharedState<T>;
};

export const create = <T extends object>(): RecursiveProofState<T> => ({
  completed: new WeakMap(),
  shared: {
    active: [],
    uncacheable: new WeakSet(),
  },
});

export const partial = <T extends object>(
  state: RecursiveProofState<T>
): RecursiveProofState<T> => ({
  completed: null,
  shared: state.shared,
});

export const run = <T extends object>(
  node: T,
  state: RecursiveProofState<T>,
  prove: () => boolean
): boolean => {
  const completed = state.completed?.get(node);
  if (completed !== undefined) {
    return completed;
  }

  const { active, uncacheable } = state.shared;
  if (active.includes(node)) {
    active.forEach((ancestor) => uncacheable.add(ancestor));
    return false;
  }

  active.push(node);
  try {
    const result = prove();
    if (!uncacheable.has(node)) {
      state.completed?.set(node, result);
    }
    return result;
  } finally {
    active.pop();
    uncacheable.delete(node);
  }
};
