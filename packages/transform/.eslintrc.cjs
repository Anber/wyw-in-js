const path = require('node:path');

module.exports = {
  extends: ['@wyw-in-js/eslint-config/library'],
  ignorePatterns: ['src/__tests__/legacy-babel-reference/**'],
  rules: {
    '@typescript-eslint/member-ordering': 'off',
  },
  overrides: [
    {
      files: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/__tests__/**/*.ts',
        'src/**/__tests__/**/*.tsx',
      ],
      rules: {
        'import/no-extraneous-dependencies': [
          'error',
          {
            devDependencies: true,
            packageDir: [__dirname, path.resolve(__dirname, '../..')],
          },
        ],
      },
    },
  ],
};
