const {
  TaggedTemplateProcessor,
  validateParams,
} = require('@wyw-in-js/processor-utils');
const { ValueType, hasEvalMeta } = require('@wyw-in-js/shared');

class StyledProcessor extends TaggedTemplateProcessor {
  constructor(params, ...args) {
    validateParams(params, ['callee', '*', '...'], StyledProcessor.SKIP);
    validateParams(
      params,
      ['callee', ['call', 'member'], ['template', 'call']],
      'Invalid styled processor usage'
    );

    const [tag, tagOp, template] = params;
    if (template[0] === 'call') {
      throw StyledProcessor.SKIP;
    }

    super([tag, template], ...args);

    if (tagOp[0] === 'member') {
      [, this.component] = tagOp;
      return;
    }

    const value = tagOp[1];
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
    const extended =
      typeof this.component === 'string'
        ? t.nullLiteral()
        : t.callExpression(t.identifier(this.component.node.name), []);

    return t.objectExpression([
      t.objectProperty(
        t.stringLiteral('displayName'),
        t.stringLiteral(this.displayName)
      ),
      t.objectProperty(
        t.stringLiteral('__wyw_meta'),
        t.objectExpression([
          t.objectProperty(
            t.stringLiteral('className'),
            t.stringLiteral(this.className)
          ),
          t.objectProperty(t.stringLiteral('extends'), extended),
        ])
      ),
    ]);
  }

  addInterpolation(node, _precedingCss, source) {
    // Runtime-callback interpolation (props => ...). Real linaria
    // records these and emits a runtime variable lookup; the test
    // fixture just records the dependency and returns a stable id.
    this.dependencies.push({
      ex: node,
      kind: 'function',
      source,
    });
    const id = `var-${this.className}-${this.dependencies.length}`;
    return id;
  }

  doEvaltimeReplacement() {
    this.replacer(this.value, false);
  }

  doRuntimeReplacement() {
    this.replacer(
      this.astService.callExpression(this.callee, [
        this.astService.nullLiteral(),
      ]),
      true
    );
  }

  extractRules(valueCache, cssText, loc) {
    let selector = `.${this.className}`;
    let value =
      typeof this.component === 'string'
        ? null
        : valueCache.get(this.component.node.name);

    while (hasEvalMeta(value)) {
      selector += `.${value.__wyw_meta.className}`;
      value = value.__wyw_meta.extends;
    }

    return {
      [selector]: {
        cssText,
        className: this.className,
        displayName: this.displayName,
        start: loc?.start ?? null,
      },
    };
  }
}

module.exports = { default: StyledProcessor };
