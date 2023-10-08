module.exports = {
  extends: ['@wyw-in-js/eslint-config/library'],
  overrides: [
    {
      files: ['*.js', '*.mjs'],
      parser: 'espree',
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  ],
  rules: {
    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: true,
      },
    ],
  },
  ignorePatterns: [
    'apps/',
    'configs/',
    'examples/',
    'node_modules/',
    'packages/',
  ],
};
