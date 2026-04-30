const { BaseProcessor, validateParams } = require('@wyw-in-js/processor-utils');

class AddedImportCallProcessor extends BaseProcessor {
  constructor(params, ...args) {
    validateParams(
      params,
      ['callee', 'call'],
      'Invalid added-import call processor usage'
    );
    super([params[0]], ...args);
  }

  get asSelector() {
    return this.className;
  }

  get value() {
    return this.astService.nullLiteral();
  }

  build() {}

  doEvaltimeReplacement() {
    this.replacer(this.value, false);
  }

  doRuntimeReplacement() {
    const importedStyles = this.astService.addNamedImport(
      '__styles',
      '@griffel/react'
    );

    this.replacer(
      this.astService.callExpression(importedStyles, [this.astService.stringLiteral('x')]),
      true
    );
  }

  toString() {
    return `${super.toString()}(…)`;
  }
}

module.exports = { default: AddedImportCallProcessor };
