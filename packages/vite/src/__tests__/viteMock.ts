export class MockDevEnvironment {
  moduleGraph = { getModuleById: jest.fn() };

  reloadModule = jest.fn();
}

export const createViteMock = (overrides: Record<string, unknown> = {}) => ({
  __esModule: true,
  DevEnvironment: MockDevEnvironment,
  createFilter: () => () => true,
  loadEnv: jest.fn(() => ({})),
  ...overrides,
});
