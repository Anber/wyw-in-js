use std::fmt::Debug;

pub mod params;
pub mod replacement_value;

pub trait Processor: Debug {
  fn id(&self) -> &str;

  fn transform(&self) -> String;
}

pub struct ProcessorTarget {
  pub specifier: String,
  pub source: String,
  pub processor: Box<dyn Processor>,
}
