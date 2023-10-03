const commonJSTargets = {
  browsers: '> 0.25% and supports array-includes',
  node: '12',
};

const config = {
  env: {
    legacy: {
      presets: [
        [
          '@babel/preset-env',
          {
            targets: {
              node: commonJSTargets.node,
            },
          },
        ],
      ],
    },
    test: {
      presets: [
        [
          '@babel/preset-env',
          {
            targets: {
              node: commonJSTargets.node,
            },
          },
        ],
        '@babel/preset-typescript',
      ],
    },
  },
  overrides: [
    {
      env: {
        legacy: {
          presets: [
            [
              '@babel/preset-env',
              {
                corejs: 3,
                debug: process.env.DEBUG_CORE_JS === 'true',
                // our styled component should not need to use any polyfill. We do not include core-js in dependencies. However, we leave this to detect if future changes would not introduce any need for polyfill
                exclude: ['es.array.includes', 'web.dom-collections.iterator'],
                // Even core-js doesn't remember IE11
                loose: true,
                targets: commonJSTargets.browsers,
                // this is used to test if we do not introduce core-js polyfill
                useBuiltIns: 'usage',
              },
            ],
          ],
        },
      },
      presets: ['@babel/preset-react'],
      /**
       * only react and core packages are targeted to be run in the browser
       */
      test: /[\\/]packages[\\/](?:atomic|core|react)[\\/](?!src[\\/]processors[\\/])/,
    },
    {
      presets: ['@babel/preset-react'],
      /**
       * we have to transpile JSX in tests
       */
      test: /[\\/](__tests__|__fixtures__|packages[\\/]teskit[\\/]src)[\\/]/,
    },
  ],
  plugins: ['@babel/plugin-proposal-explicit-resource-management'],
  presets: ['@babel/preset-typescript'],
};

if (process.env.NODE_ENV !== 'test') {
  config.ignore = ["**/__tests__/**"];
}

module.exports = config;
