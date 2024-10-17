use wyw_processor::params::{Param, ProcessorParams};
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
      [Param::Callee(callee_span, _), Param::Template(_, template)] => {
        return PostProcessResult::Replace(
          callee_span.clone(),
          ReplacementValue::Str(format!(r#""{}""#, class_name)),
        );
      }
      _ => {}
    }

    PostProcessResult::Ok
  }
}

processor!(CustomProcessor {});
