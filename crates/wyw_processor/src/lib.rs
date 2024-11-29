pub trait Processor {
  fn id(&self) -> &str;

  fn transform(&self) -> String;
}
