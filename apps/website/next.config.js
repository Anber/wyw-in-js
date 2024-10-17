const withNextra = require('nextra')({
  theme: 'nextra-theme-docs',
  themeConfig: './theme.config.js',
});

module.exports = withNextra({
  images: {
    unoptimized: true,
  },
  webpack: (config) => {
    return {
      ...config,
      experiments: {
        ...(config.experiments ?? {}),
        asyncWebAssembly: true,
      },
    };
  },
  experimental: { esmExternals: 'loose' },
});
