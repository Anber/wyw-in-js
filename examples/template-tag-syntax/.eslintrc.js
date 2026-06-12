module.exports = {
  extends: ['@wyw-in-js/eslint-config/library'],
  overrides: [
    {
      files: ['src/__tests__/applyProcessors.test.ts'],
      rules: {
        'import/no-relative-packages': 0,
      },
    },
  ],
};
