const {
  TaggedTemplateProcessor,
  validateParams,
} = require('@wyw-in-js/processor-utils');
const { ValueType } = require('@wyw-in-js/shared');

class RuntimeStyledProcessor extends TaggedTemplateProcessor {
  constructor(params, ...args) {
    validateParams(params, ['callee', '*', '...'], RuntimeStyledProcessor.SKIP);
    validateParams(
      params,
      ['callee', ['call', 'member'], ['template', 'call']],
      'Invalid styled processor usage'
    );

    const [tag, tagOp, template] = params;
    if (template[0] === 'call') {
      throw RuntimeStyledProcessor.SKIP;
    }

    super([tag, template], ...args);

    if (tagOp[0] === 'member') {
      [, this.component] = tagOp;
      return;
    }

    const value = tagOp[1];
    if (value.kind === ValueType.FUNCTION) {
      this.component = 'FunctionalComponent';
      return;
    }

    if (value.kind === ValueType.CONST && typeof value.value === 'string') {
      this.component = value.value;
      return;
    }

    this.component = {
      node: value.ex,
      source: value.source,
    };
    this.dependencies.push(value);
  }

  get asSelector() {
    return `.${this.className}`;
  }

  get value() {
    const t = this.astService;

    return t.objectExpression([
      t.objectProperty(
        t.stringLiteral('__wyw_meta'),
        t.objectExpression([
          t.objectProperty(
            t.stringLiteral('className'),
            t.stringLiteral(this.className)
          ),
          t.objectProperty(t.stringLiteral('extends'), t.nullLiteral()),
        ])
      ),
    ]);
  }

  get tagExpressionArgument() {
    const t = this.astService;
    if (typeof this.component === 'string') {
      if (this.component === 'FunctionalComponent') {
        return t.arrowFunctionExpression([], t.blockStatement([]));
      }

      return t.stringLiteral(this.component);
    }

    return t.callExpression(t.identifier(this.component.node.name), []);
  }

  doEvaltimeReplacement() {
    this.replacer(this.value, false);
  }

  doRuntimeReplacement() {
    const t = this.astService;
    this.replacer(
      t.callExpression(t.callExpression(this.callee, [this.tagExpressionArgument]), [
        t.objectExpression([
          t.objectProperty(t.identifier('class'), t.stringLiteral(this.className)),
        ]),
      ]),
      true
    );
  }

  extractRules(_valueCache, cssText, loc) {
    return {
      [`.${this.className}`]: {
        cssText,
        className: this.className,
        displayName: this.displayName,
        start: loc?.start ?? null,
      },
    };
  }
}

module.exports = { default: RuntimeStyledProcessor };
