const MANAGED_ACTION_CONTEXT = Symbol('managedActionContext');

type ManagedActionContext = {
  [MANAGED_ACTION_CONTEXT]: Map<object, () => void>;
};

const isManagedActionContext = (
  value: unknown
): value is ManagedActionContext =>
  typeof value === 'object' &&
  value !== null &&
  MANAGED_ACTION_CONTEXT in value;

export const createActionContext = (): object => ({
  [MANAGED_ACTION_CONTEXT]: new Map<object, () => void>(),
});

export const getActionContextOwners = (
  actionContext: unknown
): Map<object, () => void> | null =>
  isManagedActionContext(actionContext)
    ? actionContext[MANAGED_ACTION_CONTEXT]
    : null;

export const disposeActionContext = (actionContext: object): void => {
  const owners = getActionContextOwners(actionContext);
  if (!owners) return;

  const cleanups = [...owners.values()];
  owners.clear();
  cleanups.forEach((cleanup) => cleanup());
};
