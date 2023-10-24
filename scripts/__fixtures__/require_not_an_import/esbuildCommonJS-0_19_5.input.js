const notModule = (() => {
  const require2 = () => ({});
  const { dep } = require2('unknown-package');
  return result;
})();
console.log(notModule);
