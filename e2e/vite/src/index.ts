import { css } from '@wyw-in-js/template-tag-syntax';
import { classB } from '@/alias';
import { nativeBorderColor } from './native-value';

const classA = css`
  /*rtl:ignore*/
  color: red;
  background: green;
  border-color: ${nativeBorderColor};
`;

export { classA, classB };
