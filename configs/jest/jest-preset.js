// @ts-check

const path = require('path');
const { pathsToModuleNameMapper } = require('ts-jest');

const workspaceRoot = path.resolve(__dirname, '..', '..');

const tsConfig = require(`${workspaceRoot}/tsconfig.aliases.json`);
const tsPathAliases = pathsToModuleNameMapper(tsConfig.compilerOptions.paths, {
  prefix: `<rootDir>/${path.relative(process.cwd(), workspaceRoot)}/`,
});

/**
 * @type {import('@jest/types').Config.InitialOptions}
 */
const jestConfig = {
  cacheDirectory: '<rootDir>/node_modules/.cache/jest',
  clearMocks: true,
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: { ...tsPathAliases },
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/esm/', '/lib/', '/types/'],
};

module.exports = jestConfig;
