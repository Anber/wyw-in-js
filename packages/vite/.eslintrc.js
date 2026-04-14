module.exports = {
  extends: ['@wyw-in-js/eslint-config/library'],
  settings: {
    'import/resolver': {
      typescript: {
        project: './tsconfig.eslint.json',
      },
    },
  },
};
