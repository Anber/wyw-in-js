module.exports = {
  extends: ['@wyw-in-js/eslint-config/library'],
  overrides: [
    {
      files: ['theme.config.js'],
      parser: '@babel/eslint-parser',
      parserOptions: {
        babelOptions: {
          presets: ['@babel/preset-react'],
        },
      },
    },
  ],
};
