import { makeCssModuleGlobal } from '../css-modules';

describe('makeCssModuleGlobal', () => {
  it('wraps selectors in :global(...)', () => {
    expect(makeCssModuleGlobal('.a { color: red; }')).toBe(
      ':global(.a){ color: red; }'
    );
  });

  it('wraps each selector in a selector list', () => {
    expect(makeCssModuleGlobal('.a, .b{color:red}')).toBe(
      ':global(.a), :global(.b){color:red}'
    );
  });

  it('recurses into @media blocks', () => {
    expect(makeCssModuleGlobal('@media (min-width: 1px){.a{c:red}}')).toBe(
      '@media (min-width: 1px){:global(.a){c:red}}'
    );
  });

  it('keeps keyframes names untouched', () => {
    expect(makeCssModuleGlobal('@keyframes spin{from{a:0}to{a:1}}')).toBe(
      '@keyframes spin{from{a:0}to{a:1}}'
    );
  });

  it('keeps keyframes names untouched when used in animation', () => {
    expect(
      makeCssModuleGlobal(
        '.a{animation: spin 1s;}@keyframes spin{from{a:0}to{a:1}}'
      )
    ).toBe(':global(.a){animation: spin 1s;}@keyframes spin{from{a:0}to{a:1}}');
  });
});
