function asIs(source) {
  return source;
}

function babelCommonJSWithLastCoreAndTSC(source) {
  const babel = require('@babel/core');

  const result = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: __dirname + '/source.ts',
    presets: [
      [
        '@babel/preset-env',
        {
          targets: 'ie 11',
        },
      ],
      '@babel/preset-typescript',
    ],
  });

  return result?.code ?? '';
}

babelCommonJSWithLastCoreAndTSC.deps = [
  '@babel/core:7.23.0',
  '@babel/preset-typescript:7.23.0',
];

function babelCommonJSWithOldCoreAndTSC(source) {
  const babel = require('@babel/core');

  const result = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: __dirname + '/source.ts',
    presets: [
      [
        '@babel/preset-env',
        {
          targets: 'ie 11',
        },
      ],
      '@babel/preset-typescript',
    ],
  });

  return result?.code ?? '';
}

babelCommonJSWithOldCoreAndTSC.deps = [
  '@babel/core:7.13.0',
  '@babel/preset-typescript:7.13.0',
];

function babelNode16(source) {
  const babel = require('@babel/core');
  const result = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    filename: __dirname + '/source.ts',
    presets: [
      [
        '@babel/preset-typescript',
        {
          onlyRemoveTypeImports: true,
        },
      ],
    ],
  });

  return result?.code ?? '';
}

babelNode16.deps = ['@babel/core:7.13.0', '@babel/preset-typescript:7.13.0'];

function esbuildCommonJS(source) {
  const esbuildTransformSync = require('esbuild').transformSync;
  const result = esbuildTransformSync(source, {
    format: 'cjs',
    loader: 'ts',
    sourcefile: __dirname + '/source.ts',
    target: 'es2015',
  });

  return result.code;
}

function swcCommonJSES5(source) {
  const swcTransformSync = require('@swc/core').transformSync;
  const result = swcTransformSync(source, {
    filename: __dirname + '/source.ts',
    jsc: {
      target: 'es5',
    },
    module: {
      type: 'commonjs',
    },
  });

  return result.code;
}

function swcCommonJSES2015(source) {
  const swcTransformSync = require('@swc/core').transformSync;
  const result = swcTransformSync(source, {
    filename: __dirname + '/source.ts',
    jsc: {
      target: 'es2015',
    },
    module: {
      type: 'commonjs',
    },
  });

  return result.code;
}

function typescriptCommonJS(source) {
  const ts = require('typescript');
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });

  return result.outputText;
}

function typescriptES2022(source) {
  const ts = require('typescript');
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022 },
  });

  return result.outputText;
}

export const configs = [
  {
    name: 'as-is',
    transformers: [asIs],
  },
  {
    name: '@babel/preset-env',
    transformers: [
      babelCommonJSWithLastCoreAndTSC,
      babelCommonJSWithOldCoreAndTSC,
      babelNode16,
    ],
    version: '>=7',
  },
  {
    name: '@swc/core',
    transformers: [swcCommonJSES5, swcCommonJSES2015],
    version: '>=1.2.41', // Earlier versions require @swc/core-darwin
  },
  {
    name: 'esbuild',
    transformers: [esbuildCommonJS],
    version: '>=0.8.17', // Earlier versions fail to run postinstall script
  },
  {
    name: 'typescript',
    transformers: [typescriptCommonJS, typescriptES2022],
    version: '>=2.2', // 2.1 generates broken code for destructuring assignments
  },
];
