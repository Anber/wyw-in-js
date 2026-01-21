import * as React from 'react';

export type ScrollSchedule = 'immediate' | 'raf' | 'raf-timeout';

export function useScrollIntoViewOnChange<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  deps: React.DependencyList,
  options?: {
    behavior?: ScrollBehavior;
    block?: ScrollLogicalPosition;
    enabled?: boolean;
    inline?: ScrollLogicalPosition;
    schedule?: ScrollSchedule;
  }
) {
  const enabled = options?.enabled ?? true;
  const schedule: ScrollSchedule = options?.schedule ?? 'immediate';
  const behavior: ScrollBehavior | undefined = options?.behavior ?? 'smooth';
  const block: ScrollLogicalPosition | undefined = options?.block ?? 'nearest';
  const inline: ScrollLogicalPosition | undefined = options?.inline;

  React.useEffect(() => {
    let rafId: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };

    if (!enabled) return cleanup;
    const el = ref.current;
    if (!el) return cleanup;

    const scroll = () => {
      el.scrollIntoView({ behavior, block, inline });
    };

    if (schedule === 'raf-timeout') {
      rafId = requestAnimationFrame(() => {
        scroll();
        timeoutId = setTimeout(scroll, 0);
      });
      return cleanup;
    }

    if (schedule === 'raf') {
      rafId = requestAnimationFrame(scroll);
      return cleanup;
    }

    scroll();
    return cleanup;
  }, [...deps, enabled, schedule, behavior, block, inline]);
}
