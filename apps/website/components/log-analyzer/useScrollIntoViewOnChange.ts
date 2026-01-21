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
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    const scroll = () => {
      el.scrollIntoView({ behavior, block, inline });
    };

    if (schedule === 'raf-timeout') {
      requestAnimationFrame(() => {
        scroll();
        setTimeout(scroll, 0);
      });
      return;
    }

    if (schedule === 'raf') {
      requestAnimationFrame(scroll);
      return;
    }

    scroll();
  }, [...deps, enabled, schedule, behavior, block, inline]);
}
