import { css } from 'test-css-processor';
import { getSymbol } from './symbol';

export const preload = css`
  color: ${getSymbol() ? 'green' : 'red'};
`;

export const _usage = [preload];

