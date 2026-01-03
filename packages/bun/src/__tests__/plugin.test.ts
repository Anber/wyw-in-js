import wyw from '../index';

it('exports a Bun plugin factory', () => {
  const plugin = wyw();
  expect(plugin.name).toBe('wyw-in-js');
  expect(typeof plugin.setup).toBe('function');
});
