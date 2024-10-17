use oxc::span::Span;
use wyw_processor::params::{ExpressionValue, Param, ProcessorParams};
use wyw_processor::replacement_value::ReplacementValue;
use wyw_processor::{processor, PostProcessResult, ProcessResult, Processor};

struct CustomProcessor {}

impl<'a> Processor<'a> for CustomProcessor {
  fn process(&self, params: &ProcessorParams<'a>) -> ProcessResult {
    ProcessResult::Ok
  }

  fn post_process(&self, params: &ProcessorParams<'a>) -> PostProcessResult {
    let (class_name, _) = self.get_name_and_slug(params);

    match &params.params[..] {
      [Param::Callee(_, _), Param::Call(call_span, args), Param::Template(temp_span, template)] => {
        return PostProcessResult::Replace(
          Span::new(call_span.end, temp_span.end),
          ReplacementValue::Str(format!(
            r#"({{ name: '{}', class: '{}', vars: {{}} }})"#,
            params.display_name, class_name
          )),
        );
      }
      _ => {}
    }

    PostProcessResult::Ok
  }
}

processor!(CustomProcessor {});
