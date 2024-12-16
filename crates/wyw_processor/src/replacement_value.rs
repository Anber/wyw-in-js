use oxc::span::Span;

#[derive(Debug, PartialEq)]
pub enum ReplacementValue {
  Del,
  Span(Span),
  Str(String),
  Undefined,
}

impl ReplacementValue {
  pub fn from_string(s: &str) -> Self {
    if s == "undefined" {
      Self::Undefined
    } else {
      Self::Str(s.to_string())
    }
  }
}
