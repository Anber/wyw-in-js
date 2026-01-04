import { css } from 'test-css-processor';
import { getSymbol, getSymbolAgain } from './symbol';

export const text = css`
  color: ${getSymbol() === getSymbolAgain() ? 'green' : 'red'};
`;

export const _usage = [text];
