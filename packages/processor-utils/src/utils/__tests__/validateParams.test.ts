import type { Params } from '../..';
import { isValidParams, validateParams } from '../..';

describe('params validator', () => {
  it('should be defined', () => {
    expect(isValidParams).toBeDefined();
    expect(validateParams).toBeDefined();
  });

  it('should match', () => {
    const params: Params = [['call'], ['member', 'c'], ['template', []]];
    expect(isValidParams(params, ['call', 'member', 'template'])).toBe(true);
  });

  it('should match wildcard', () => {
    const params: Params = [['call'], ['member', 'c'], ['template', []]];
    expect(isValidParams(params, ['call', '*', 'template'])).toBe(true);
  });

  it('should match spread', () => {
    const params: Params = [['call'], ['member', 'c'], ['template', []]];
    expect(isValidParams(params, ['call', '...'])).toBe(true);
  });

  it('should match array', () => {
    const params: Params = [['call'], ['member', 'c'], ['template', []]];
    expect(
      isValidParams(params, ['call', ['member', 'template'], 'template'])
    ).toBe(true);
  });

  it('should not match', () => {
    const params: Params = [['call'], ['member', 'c'], ['template', []]];
    expect(isValidParams(params, ['call'])).toBe(false);
    expect(isValidParams(params, ['call', 'member'])).toBe(false);
    expect(isValidParams(params, ['call', 'member', 'call'])).toBe(false);
    expect(isValidParams(params, ['call', 'member', ['call', 'member']])).toBe(
      false
    );
  });

  it('should narrow types', () => {
    const params: Params = [['call'], ['member', 'c'], ['template', []]];
    validateParams(params, ['call', 'member', 'template'], '');
    const a: readonly ['call', ...unknown[]] = params[0];
    const b: readonly ['member', string] = params[1];
    const c: readonly ['template', unknown[]] = params[2];
    expect(a[0]).toBe('call');
    expect(b[0]).toBe('member');
    expect(c[0]).toBe('template');
  });

  it('should throw', () => {
    const params: Params = [['call']];
    expect(() => validateParams(params, ['member'], 'Should be call')).toThrow(
      'Should be call'
    );
  });
});
