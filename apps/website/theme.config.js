export default {
  footer: {
    component: null,
  },
  logo: <span>WyW-in-JS</span>,
  primaryHue: 210,
  primarySaturation: 100,
  project: {
    // docsRepositoryBase:
    //   'https://github.com/Anber/wyw-in-js/tree/main/apps/website',
    link: 'https://github.com/Anber/wyw-in-js',
  },
  useNextSeoProps() {
    return {
      titleTemplate: '%s – WyW-in-JS',
    };
  },
};
