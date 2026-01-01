import { css } from '@wyw-in-js/template-tag-syntax';

import rawText from './sample-asset.txt?raw';
import assetUrl from './sample-asset.txt?url';

export const classA = css`
  content: "${String(rawText).trim()}";
  --asset-url: "${String(assetUrl)}";
`;
