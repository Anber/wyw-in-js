const { BaseProcessor, validateParams } = require('@wyw-in-js/processor-utils');

class RuntimeDependencyCallProcessor extends BaseProcessor {
  constructor(params, ...args) {
    validateParams(
      params,
      ['callee', 'call'],
      'Invalid runtime dependency call processor usage'
    );
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
    const argumentName = this.argument?.ex?.name;
    const argument = argumentName
      ? this.astService.callExpression(this.astService.identifier(argumentName), [])
      : this.astService.nullLiteral();

    this.replacer(
      this.astService.callExpression(this.astService.identifier('__callRuntime'), [
        argument,
      ]),
      true
    );
  }

  toString() {
    return `${super.toString()}(…)`;
  }
}

module.exports = { default: RuntimeDependencyCallProcessor };
