mod utils;

use itertools::Itertools;
use oxc::span::Span;
use regex::Regex;
use wasm_bindgen::prelude::*;
use wyw_shaker::shake_source;

#[wasm_bindgen]
extern "C" {}

fn extract_spans_for_deletion(source_text: String) -> (String, Vec<Span>) {
  // Split the source text into lines
  // For each line, check if it contains only ^ and spaces
  // If it does, extract the span and add it to the list of spans for deletion
  // If it doesn't, add the line to the new source text
  let mut lines = vec![];
  let mut spans_for_deletion = Vec::new();
  let mut pos = 0;
  let mut last_line_len = 0;

  let marker_line_re = Regex::new(r"[\s^]+$").unwrap();
  let marker_re = Regex::new(r"\^+").unwrap();

  for line in source_text.split('\n') {
    if marker_line_re.is_match(line) {
      for marker in marker_re.find_iter(line) {
        let start = pos - last_line_len + marker.start();
        let end = pos - last_line_len + marker.end();
        spans_for_deletion.push(Span::new(start as u32, end as u32));
      }
    } else {
      lines.push(line);
      last_line_len = line.len() + 1;
      pos += last_line_len;
    }
  }

  (lines.iter().join("\n"), spans_for_deletion)
}

#[wasm_bindgen]
pub fn shake(source_text: String) -> String {
  let (source_text, for_delete) = extract_spans_for_deletion(source_text);
  let res = shake_source(source_text, for_delete);

  if res == "\n" {
    "".to_string()
  } else {
    res
  }
}
