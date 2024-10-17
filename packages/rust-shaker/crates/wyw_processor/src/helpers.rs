use pathdiff::diff_paths;
use regex::Regex;
use std::collections::HashMap;
use std::path::{PathBuf, MAIN_SEPARATOR};

fn normalize_path(path: &PathBuf) -> String {
  path
    .to_string_lossy()
    .chars()
    .map(|c| if c == '\\' { MAIN_SEPARATOR } else { c })
    .collect()
}

fn format_36(mut x: u32) -> String {
  let radix = 36;
  let mut result = vec![];

  loop {
    let m = x % radix;
    x = x / radix;

    // will panic if you use a bad radix (< 2 or > 36).
    result.push(std::char::from_digit(m, radix).unwrap());
    if x == 0 {
      break;
    }
  }
  result.into_iter().rev().collect()
}

fn do_hash(s: &str, seed: u32) -> u32 {
  fn uint32(s: &str, pos: usize) -> u32 {
    let bytes = s.as_bytes();
    (bytes[pos] as u32)
      | ((bytes[pos + 1] as u32) << 8)
      | ((bytes[pos + 2] as u32) << 16)
      | ((bytes[pos + 3] as u32) << 24)
  }

  fn uint16(s: &str, pos: usize) -> u32 {
    let bytes = s.as_bytes();
    (bytes[pos] as u32) | ((bytes[pos + 1] as u32) << 8)
  }

  fn umul32(n: u32, m: u32) -> u32 {
    let n = n as u64;
    let m = m as u64;
    let result = n.wrapping_mul(m) & 0xffffffff;
    result as u32
  }

  let m: u32 = 0x5bd1e995;
  let r: u32 = 24;
  let mut h = seed ^ (s.len() as u32);
  let mut length = s.len();
  let mut current_index = 0;

  while length >= 4 {
    let mut k = uint32(s, current_index);

    k = umul32(k, m);
    k ^= k >> r;
    k = umul32(k, m);

    h = umul32(h, m);
    h ^= k;

    current_index += 4;
    length -= 4;
  }

  match length {
    3 => {
      h ^= uint16(s, current_index);
      h ^= (s.as_bytes()[current_index + 2] as u32) << 16;
      h = umul32(h, m);
    }
    2 => {
      h ^= uint16(s, current_index);
      h = umul32(h, m);
    }
    1 => {
      h ^= s.as_bytes()[current_index] as u32;
      h = umul32(h, m);
    }
    _ => {}
  }

  h ^= h >> 13;
  h = umul32(h, m);
  h ^= h >> 15;

  h
}

pub fn slugify(code: &str) -> String {
  let hash = do_hash(code, 0);
  format_36(hash)
}

fn to_valid_css_identifier(s: &str) -> String {
  let re = Regex::new(r"(?i)[^-_a-z0-9\u{00A0}-\u{FFFF}]").unwrap();
  let s = re.replace_all(s, "_").to_string();
  let re = Regex::new(r"^\d").unwrap();
  re.replace(&s, "_").to_string()
}

fn build_slug(pattern: &str, args: &HashMap<&str, String>) -> String {
  let placeholder = Regex::new(r"\[(.*?)]").unwrap();

  placeholder
    .replace_all(pattern, |caps: &regex::Captures| {
      let name = &caps[1];
      if args.contains_key(name) {
        args[name].to_string()
      } else {
        String::new()
      }
    })
    .to_string()
}

pub fn get_class_name_and_slug(
  display_name: &str,
  idx: usize,
  root: Option<&PathBuf>,
  filename: Option<&PathBuf>,
  show_display_name: bool,
  class_name_slug: Option<&str>,
) -> (String, String) {
  let relative_filename_path = match (root, filename) {
    (Some(root), Some(filename)) => diff_paths(filename, root).unwrap(),
    (None, Some(filename)) => filename.clone(),
    _ => PathBuf::from("unknown"),
  };

  let slug = to_valid_css_identifier(&format!(
    "{}{}",
    display_name.chars().next().unwrap().to_lowercase(),
    slugify(&format!(
      "{}:{}",
      normalize_path(&relative_filename_path),
      idx
    ))
  ));

  let ext = relative_filename_path.extension().unwrap_or_default();
  let mut slug_vars = HashMap::new();
  slug_vars.insert("hash", slug.clone());
  slug_vars.insert("title", display_name.to_string());
  slug_vars.insert("index", idx.to_string());
  slug_vars.insert("file", normalize_path(&relative_filename_path));
  slug_vars.insert("ext", ext.to_string_lossy().to_string());
  slug_vars.insert(
    "name",
    relative_filename_path
      .file_stem()
      .unwrap()
      .to_string_lossy()
      .to_string(),
  );
  slug_vars.insert(
    "dir",
    relative_filename_path
      .parent()
      .unwrap()
      .file_name()
      .unwrap()
      .to_string_lossy()
      .to_string(),
  );

  match (class_name_slug, show_display_name) {
    (Some(class_name_slug), _) => {
      let class_name = to_valid_css_identifier(build_slug(class_name_slug, &slug_vars).as_str());
      (class_name, slug)
    }
    (None, true) => {
      let class_name = format!("{}_{}", to_valid_css_identifier(display_name), slug);
      (class_name, slug)
    }
    (None, false) => (slug.clone(), slug),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_slugify() {
    assert_eq!(slugify("hello"), "1rn7hzf");
    assert_eq!(slugify("world"), "1isa3om");
  }

  #[test]
  fn test_to_valid_css_identifier() {
    assert_eq!(to_valid_css_identifier("hello"), "hello");
    assert_eq!(to_valid_css_identifier("world"), "world");
    assert_eq!(to_valid_css_identifier("World"), "World");
    assert_eq!(to_valid_css_identifier("hello world"), "hello_world");
    assert_eq!(to_valid_css_identifier("hello-world"), "hello-world");
    assert_eq!(to_valid_css_identifier("hello_world"), "hello_world");
    assert_eq!(to_valid_css_identifier("hello@world"), "hello_world");
    assert_eq!(
      to_valid_css_identifier("hello\u{00A0}world"),
      "hello\u{a0}world"
    );
    assert_eq!(
      to_valid_css_identifier("hello\u{FFFF}world"),
      "hello\u{FFFF}world"
    );
    assert_eq!(to_valid_css_identifier("hello\u{000F}world"), "hello_world");
    assert_eq!(to_valid_css_identifier("hello💣world"), "hello_world");

    assert_eq!(to_valid_css_identifier("1hello"), "_hello");
  }

  #[test]
  fn test_build_slug() {
    let mut args = HashMap::new();
    args.insert("name", "world".to_string());
    args.insert("age", "30".to_string());
    args.insert("city", "New York".to_string());

    assert_eq!(build_slug("hello [name]", &args), "hello world");
    assert_eq!(build_slug("hello [name] [age]", &args), "hello world 30");
    assert_eq!(
      build_slug("hello [name] [age] [city]", &args),
      "hello world 30 New York"
    );
    assert_eq!(
      build_slug("hello [name] [age] [city] [country]", &args),
      "hello world 30 New York "
    );
  }
}
