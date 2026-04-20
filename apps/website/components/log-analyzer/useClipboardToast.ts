import * as React from 'react';

import { writeClipboardText } from './utils';

export function useClipboardToast() {
  const [message, setMessage] = React.useState<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const show = React.useCallback((nextMessage: string) => {
    setMessage(nextMessage);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setMessage(null);
      timerRef.current = null;
    }, 1400);
  }, []);

  const copyText = React.useCallback(
    async (text: string, successMessage: string) => {
      const ok = await writeClipboardText(text);
      show(ok ? successMessage : 'Copy failed');
    },
    [show]
  );

  const reset = React.useCallback(() => {
    setMessage(null);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  return { message, show, copyText, reset };
}

export type ClipboardToastState = ReturnType<typeof useClipboardToast>;
