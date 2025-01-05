use std::fmt::Debug;

pub mod params;
pub mod replacement_value;

pub trait Processor: Debug {
  fn id(&self) -> &str;

  fn transform(&self) -> String;
}

#[derive(Debug)]
pub struct ProcessorTarget<'a> {
  pub specifier: String,
  pub source: String,
  pub processor: &'a dyn Processor,
}

#[derive(Debug)]
pub struct Processors<'a> {
  targets: Vec<ProcessorTarget<'a>>,
}

impl<'a> Processors<'a> {
  pub fn new(targets: Vec<ProcessorTarget<'a>>) -> Self {
    Self { targets: targets }
  }

  pub fn get(&self, specifier: &str, source: &str) -> Option<&'a dyn Processor> {
    self
      .targets
      .iter()
      .find(|p| p.specifier == specifier && p.source == source)
      .map(|p| p.processor)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_get() {
    #[derive(Debug)]
    struct MockProcessor;

    impl Processor for MockProcessor {
      fn id(&self) -> &str {
        "mock"
      }

      fn transform(&self) -> String {
        "mock".to_string()
      }
    }

    let targets = vec![ProcessorTarget {
      specifier: "styles".to_string(),
      source: "@wyw/sample-processor".to_string(),
      processor: &MockProcessor,
    }];
    let processors = Processors::new(targets);

    assert!(processors.get("styles", "@wyw/sample-processor").is_some());
    assert!(processors.get("css", "@wyw/sample-processor").is_none());
  }
}
