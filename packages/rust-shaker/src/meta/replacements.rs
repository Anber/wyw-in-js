use oxc::span::Span;
use std::cmp::Ordering;

#[derive(Debug, PartialEq)]
pub(crate) enum ReplacementValue {
  Del,
  Span(Span),
  Str(String),
  Undefined,
}

impl ReplacementValue {
  fn from_str(s: &str) -> Self {
    if s == "undefined" {
      Self::Undefined
    } else {
      Self::Str(s.to_string())
    }
  }
}

#[derive(Debug, PartialEq)]
pub(crate) struct Replacement {
  pub span: Span,
  pub value: ReplacementValue,
}

#[derive(Default)]
pub(crate) struct Replacements {
  pub(crate) list: Vec<Replacement>,
}

impl Replacements {
  pub fn new(init: impl IntoIterator<Item = Replacement>) -> Self {
    let mut res = Self::default();
    for span in init {
      res.add(span);
    }

    res
  }

  pub fn from_spans(init: impl IntoIterator<Item = Span>) -> Self {
    Self::new(init.into_iter().map(|span| Replacement {
      span,
      value: ReplacementValue::Del,
    }))
  }

  pub fn add(&mut self, new: Replacement) -> bool {
    // If new span covers existing spans, replace them with the new span
    let mut i = 0;
    while i < self.list.len() {
      let existing = self.list.get(i).unwrap();
      // FIXME: Simplify existing == new
      if existing.span.start == new.span.start && existing.span.end == new.span.end {
        if existing.value == new.value {
          return false;
        }

        self.list.remove(i);
      } else if existing.span.start <= new.span.start && existing.span.end >= new.span.end {
        return false;
      } else if existing.span.start >= new.span.start && existing.span.end <= new.span.end {
        self.list.remove(i);
      } else if existing.span.end > new.span.start || new.span.end < existing.span.start {
        break;
      } else {
        i += 1;
      }
    }

    // Insert the new span
    self.list.insert(i, new);
    true
  }

  pub fn apply(&self, text: &str) -> String {
    let mut chunks = vec![];
    let mut last_pos: usize = 0;
    for replacement in &self.list {
      let start = replacement.span.start as usize;
      let end = replacement.span.end as usize;
      if last_pos != start {
        chunks.push(text[last_pos..start].to_string());
      }

      match &replacement.value {
        ReplacementValue::Del => {}
        ReplacementValue::Span(span) => {
          chunks.push(text[span.start as usize..span.end as usize].to_string());
        }
        ReplacementValue::Str(s) => {
          chunks.push(s.to_string());
        }
        ReplacementValue::Undefined => {
          chunks.push("undefined".to_string());
        }
      }

      last_pos = end;
    }

    chunks.push(text[last_pos..].to_string());

    chunks.join("")
  }

  pub fn add_deletion(&mut self, span: Span) -> bool {
    self.add_replacement(span, ReplacementValue::Del)
  }

  pub fn add_replacement(&mut self, span: Span, value: ReplacementValue) -> bool {
    self.add(Replacement { span, value })
  }

  pub fn get(&self, span: Span) -> Option<&Replacement> {
    self
      .list
      .binary_search_by(|s| {
        if span.start < s.span.start {
          return Ordering::Greater;
        }

        if span.end > s.span.end {
          return Ordering::Less;
        }

        Ordering::Equal
      })
      .ok()
      .and_then(|i| self.list.get(i))
  }

  pub fn has(&self, span: Span) -> bool {
    self.get(span).is_some()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn del(start: u32, end: u32) -> Replacement {
    Replacement {
      span: Span::new(start, end),
      value: ReplacementValue::Del,
    }
  }

  fn undefined(start: u32, end: u32) -> Replacement {
    Replacement {
      span: Span::new(start, end),
      value: ReplacementValue::Undefined,
    }
  }

  #[test]
  fn test_new() {
    assert_eq!(Replacements::default().list, vec![]);

    assert_eq!(Replacements::new(vec![]).list, vec![]);

    assert_eq!(
      Replacements::new(vec![del(1, 10), del(20, 30)]).list,
      vec![del(1, 10), del(20, 30)]
    );

    assert_eq!(
      Replacements::new(vec![del(1, 10), del(20, 30), del(1, 30)]).list,
      vec![del(1, 30)]
    );

    assert_eq!(
      Replacements::new(vec![del(20, 30), del(1, 10)]).list,
      vec![del(1, 10), del(20, 30)]
    );

    assert_eq!(
      Replacements::new(vec![del(9, 10), del(15, 16), del(10, 12), del(13, 15)]).list,
      vec![del(9, 10), del(10, 12), del(13, 15), del(15, 16)]
    );

    assert_eq!(
      Replacements::new(vec![del(9, 10), del(15, 16), del(0, 2)]).list,
      vec![del(0, 2), del(9, 10), del(15, 16)]
    );
  }

  #[test]
  fn test_add_deletion() {
    let mut repl = Replacements::default();
    repl.add_deletion(Span::new(1, 10));
    repl.add_deletion(Span::new(20, 30));
    assert_eq!(repl.list, vec![del(1, 10), del(20, 30)]);

    repl.add_deletion(Span::new(1, 30));
    assert_eq!(repl.list, vec![del(1, 30)]);
  }

  #[test]
  fn test_has() {
    let repl = Replacements::new(vec![del(1, 10), del(20, 30)]);

    assert!(repl.has(Span::new(1, 10)));
    assert!(repl.has(Span::new(4, 8)));
    assert!(!repl.has(Span::new(1, 30)));
    assert!(!repl.has(Span::new(20, 31)));
  }

  #[test]
  fn test_duplicated_spans() {
    let mut repl = Replacements::default();
    assert!(repl.add_replacement(Span::new(1, 10), ReplacementValue::Del));
    assert!(!repl.add_replacement(Span::new(1, 10), ReplacementValue::Del));
    assert!(!repl.add_replacement(Span::new(3, 8), ReplacementValue::Del));
    assert_eq!(repl.list, vec![del(1, 10)]);

    // but with different value it should be added
    assert!(repl.add_replacement(Span::new(1, 10), ReplacementValue::Undefined));
    assert_eq!(repl.list, vec![undefined(1, 10)]);

    // but if existing span is wider, it should be kept
    assert!(!repl.add_replacement(Span::new(3, 8), ReplacementValue::Del));
    assert_eq!(repl.list, vec![undefined(1, 10)]);
  }

  #[test]
  fn test_apply() {
    let source = "0123456789";
    let mut repl = Replacements::default();

    repl.add_deletion(Span::new(0, 2));
    assert_eq!(repl.apply(source), "23456789");

    repl.add_replacement(Span::new(3, 4), ReplacementValue::from_str("!"));
    assert_eq!(repl.apply(source), "2!456789");

    repl.add_replacement(Span::new(5, 5), ReplacementValue::from_str("insertion"));
    assert_eq!(repl.apply(source), "2!4insertion56789");

    repl.add_replacement(Span::new(0, 2), ReplacementValue::from_str("prefix"));
    assert_eq!(repl.apply(source), "prefix2!4insertion56789");

    repl.add_replacement(Span::new(8, 10), ReplacementValue::Span(Span::new(0, 2)));
    assert_eq!(repl.apply(source), "prefix2!4insertion56701");
  }
}
