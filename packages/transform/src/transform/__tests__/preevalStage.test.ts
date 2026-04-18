import {
  maybeNeedsDynamicImportPlugin,
  maybeNeedsRequireFallbackPlugin,
} from '../preevalStage';

describe('preevalStage plugin guards', () => {
  it('detects dynamic import with whitespace', () => {
    expect(maybeNeedsDynamicImportPlugin("const mod = import ('./dep');")).toBe(
      true
    );
  });

  it('detects dynamic import with an inline block comment', () => {
    expect(
      maybeNeedsDynamicImportPlugin(
        "const mod = import(/* webpackChunkName: 'dep' */ './dep');"
      )
    ).toBe(true);
  });

  it('does not match static import declarations', () => {
    expect(
      maybeNeedsDynamicImportPlugin("import { value } from './dep';")
    ).toBe(false);
  });

  it('detects require calls with whitespace', () => {
    expect(maybeNeedsRequireFallbackPlugin("const dep = require ('./dep');")).toBe(
      true
    );
  });

  it('detects require calls with an inline block comment', () => {
    expect(
      maybeNeedsRequireFallbackPlugin(
        "const dep = require/* keep */('./dep');"
      )
    ).toBe(true);
  });

  it('does not match identifiers that only contain require in their name', () => {
    expect(
      maybeNeedsRequireFallbackPlugin('const requireValue = makeRequireValue();')
    ).toBe(false);
  });
});
