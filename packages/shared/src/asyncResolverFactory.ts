export const asyncResolverFactory = <
  TResolved,
  const TResolverArgs extends readonly unknown[],
  TResolve extends (...args: TResolverArgs) => Promise<TResolved>,
>(
  onResolve: (
    resolved: TResolved,
    what: string,
    importer: string,
    stack: string[]
  ) => Promise<string | null>,
  mapper: (what: string, importer: string, stack: string[]) => TResolverArgs
) => {
  const memoizedSyncResolve = new WeakMap<
    TResolve,
    (what: string, importer: string, stack: string[]) => Promise<string | null>
  >();

  return (resolveFn: TResolve) => {
    if (!memoizedSyncResolve.has(resolveFn)) {
      const fn = (
        what: string,
        importer: string,
        stack: string[]
      ): Promise<string | null> =>
        resolveFn(...mapper(what, importer, stack)).then((resolved) =>
          onResolve(resolved, what, importer, stack)
        );

      memoizedSyncResolve.set(resolveFn, fn);
    }

    return memoizedSyncResolve.get(resolveFn)!;
  };
};
