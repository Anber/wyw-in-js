// @ts-check

/**
 * @type {import('@jest/types').Config.InitialOptions}
 */
module.exports = {
  displayName: 'transform',
  preset: '@wyw-in-js/jest-preset',
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        isolatedModules: true,
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!happy-dom)'],
  moduleNameMapper: {
    '^happy-dom$': '<rootDir>/src/__mocks__/happy-dom.ts',
  },
};
