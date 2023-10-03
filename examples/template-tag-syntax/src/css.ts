import type { WYWEvalMeta } from '@wyw-in-js/shared';

import type { CSSProperties } from './CSSProperties';

type CSS = (
  strings: TemplateStringsArray,
  ...exprs: Array<string | number | CSSProperties | WYWEvalMeta>
) => string;

let idx = 0;

export const css: CSS = (): string => {
  if (process.env.NODE_ENV === 'test') {
    // eslint-disable-next-line no-plusplus
    return `mocked-css-${idx++}`;
  }

  throw new Error(
    'Using the "css" tag in runtime is not supported. Make sure you have set up a loader correctly.'
  );
};
