const { BaseProcessor, validateParams } = require('@wyw-in-js/processor-utils');

class CallProcessor extends BaseProcessor {
  constructor(params, ...args) {
    validateParams(params, ['callee', 'call'], 'Invalid call processor usage');
    super([params[0]], ...args);
    this.argument = params[1][1];

    if (this.argument) {
      this.dependencies.push(this.argument);
    }
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
    this.replacer(
      this.astService.callExpression(this.astService.identifier('__callRuntime'), []),
      true
    );
  }

  toString() {
    return `${super.toString()}(…)`;
  }
}

module.exports = { default: CallProcessor };
