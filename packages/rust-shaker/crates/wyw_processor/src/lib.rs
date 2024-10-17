use crate::helpers::get_class_name_and_slug;
use crate::params::ProcessorParams;
use crate::replacement_value::ReplacementValue;
use oxc::span::Span;
use pluginator::plugin::load;
use pluginator::plugin::LoadingError;
use pluginator::LoadedPlugin;

mod helpers;
pub mod macros;
pub mod params;
pub mod replacement_value;

#[derive(Debug)]
pub enum ProcessResult {
  Ok,
  Eval(Vec<String>),
  Err(String),
}

pub enum PostProcessResult {
  Ok,
  Replace(Span, ReplacementValue),
  Err(String),
}

pub trait Processor<'a>: Sync + Send {
  fn get_name_and_slug(&self, params: &ProcessorParams<'a>) -> (String, String) {
    get_class_name_and_slug(
      &params.display_name,
      params.idx,
      Some(params.root),
      Some(params.filename),
      true,
      None,
    )
  }

  fn process(&self, params: &ProcessorParams<'a>) -> ProcessResult;

  fn post_process(&self, params: &ProcessorParams<'a>) -> PostProcessResult;
}

/// # Safety
/// This function is unsafe because it loads a shared library from the filesystem.
pub unsafe fn load_processor<'a, Path: AsRef<std::path::Path>>(
  path: Path,
) -> Result<LoadedPlugin<dyn Processor<'a>>, LoadingError> {
  unsafe { load(path) }
}
