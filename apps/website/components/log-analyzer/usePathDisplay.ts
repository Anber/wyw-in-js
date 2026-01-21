import * as React from 'react';

import { trimPathPrefix } from './analyze';

export function usePathDisplay(autoPrefix: string) {
  const [pathPrefix, setPathPrefix] = React.useState('');

  React.useEffect(() => {
    setPathPrefix(autoPrefix);
  }, [autoPrefix]);

  const resetToAuto = React.useCallback(() => {
    setPathPrefix(autoPrefix);
  }, [autoPrefix]);

  const clear = React.useCallback(() => {
    setPathPrefix('');
  }, []);

  const displayPath = React.useCallback(
    (path: string) => trimPathPrefix(path, pathPrefix),
    [pathPrefix]
  );

  const reset = React.useCallback(() => {
    setPathPrefix(autoPrefix);
  }, [autoPrefix]);

  return {
    pathPrefix,
    setPathPrefix,
    resetToAuto,
    clear,
    displayPath,
    reset,
  };
}

export type PathDisplayState = ReturnType<typeof usePathDisplay>;
