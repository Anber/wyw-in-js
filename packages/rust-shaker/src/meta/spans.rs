use oxc::span::Span;

pub(crate) struct Spans {
  // Binary tree would be more efficient
  pub(crate) list: Vec<Span>,
}

impl Spans {
  pub fn new(init: Vec<Span>) -> Self {
    let mut res = Self { list: Vec::new() };
    for span in init {
      res.add(span);
    }

    res
  }

  pub fn add(&mut self, span: Span) {
    // If new span covers existing spans, replace them with the new span
    let mut i = 0;
    while i < self.list.len() {
      let existing = &self.list[i];
      if existing.start >= span.start && existing.end <= span.end {
        self.list.remove(i);
      } else if existing.start > span.end {
        break;
      } else {
        i += 1;
      }
    }

    // Insert the new span
    self.list.insert(i, span);
  }

  pub fn has(&self, span: Span) -> bool {
    self
      .list
      .iter()
      .any(|s| s.start <= span.start && s.end >= span.end)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_new() {
    assert_eq!(Spans::new(vec![]).list, vec![]);

    assert_eq!(
      Spans::new(vec![Span::new(1, 10), Span::new(20, 30)]).list,
      vec![Span::new(1, 10), Span::new(20, 30)]
    );

    assert_eq!(
      Spans::new(vec![Span::new(1, 10), Span::new(20, 30), Span::new(1, 30)]).list,
      vec![Span::new(1, 30)]
    );

    assert_eq!(
      Spans::new(vec![Span::new(20, 30), Span::new(1, 10)]).list,
      vec![Span::new(1, 10), Span::new(20, 30)]
    );
  }

  #[test]
  fn test_add() {
    let mut spans = Spans::new(Vec::new());
    spans.add(Span::new(1, 10));
    spans.add(Span::new(20, 30));
    assert_eq!(spans.list, vec![Span::new(1, 10), Span::new(20, 30)]);

    spans.add(Span::new(1, 30));
    assert_eq!(spans.list, vec![Span::new(1, 30)]);
  }

  #[test]
  fn test_has() {
    let mut spans = Spans::new(Vec::new());
    spans.add(Span::new(1, 10));
    spans.add(Span::new(20, 30));
    assert!(spans.has(Span::new(1, 10)));
    assert!(spans.has(Span::new(4, 8)));
    assert!(!spans.has(Span::new(1, 30)));
    assert!(!spans.has(Span::new(20, 31)));
  }
}
