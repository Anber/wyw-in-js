mod collect_meta;
mod declaration_context;
mod default_resolver;
mod meta;
mod processors;

use crate::collect_meta::parse_js_file_from_source;
use crate::default_resolver::create_resolver;
use crate::meta::import::Source;
use oxc::allocator::Allocator;
use oxc::span::{Atom, SourceType, Span};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::PathBuf;
use std::{env, path::Path};
use walkdir::WalkDir;

fn apply_replacements<'a>(source: &String, replacements: Vec<(Span, Atom<'a>)>) -> String {
  let mut source = source.clone();
  let mut offset: i32 = 0;
  for (span, replacement) in replacements {
    let start = span.start as i32 + offset;
    let end = span.end as i32 + offset;
    let repl_len = replacement.len() as i32;
    let source_len = end - start;
    if repl_len > source_len {
      offset += repl_len - source_len;
    } else {
      offset -= source_len - repl_len;
    }

    // if start == end {
    //   source.insert_str(start as usize, replacement.as_str());
    // } else {
    source.replace_range((start as usize)..(end as usize), replacement.as_str());
    // }
  }

  source
}

const EXTENSIONS: [&str; 5] = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

fn process_entrypoint(
  name: String,
  allocator: &Allocator,
  cache: &mut HashMap<PathBuf, bool>,
) -> usize {
  let mut count = 0;

  let mut queue = vec![Path::new(&name).to_path_buf()];
  let extensions: Vec<String> = EXTENSIONS.map(|ext| ext.to_string()).into();
  let extensions_set: HashSet<_> = extensions.iter().cloned().collect();
  let mut processed = HashSet::new();

  while !queue.is_empty() {
    let mut next_queue = vec![];

    for path in &queue {
      if cache.contains_key(path) {
        continue;
      }

      count += 1;
      println!("Processing {}", path.display());
      processed.insert(path.to_path_buf());

      let source_type = SourceType::from_path(path).unwrap();
      let file_content = std::fs::read_to_string(path).unwrap();
      let resolver = create_resolver(path);

      let result =
        parse_js_file_from_source(allocator, &resolver, path, &file_content, source_type);

      assert!(result.is_ok());

      let result = result.unwrap();

      cache.insert(path.to_path_buf(), true);

      // println!("\tReplacements: {:?}", replacements);
      println!(
        "\tSource:\n{}",
        apply_replacements(&file_content, result.evaltime_replacements.clone())
      );

      for import in &result.imports.list {
        let source = import.source();

        let resolved_path = match source {
          Source::Resolved(path) => path,
          Source::Unresolved(_) => {
            eprintln!("\t! Unresolved import: {:?}", import);
            continue;
          }
        };

        if let Some(ext) = resolved_path.extension() {
          let ext_with_dot = format!(".{}", ext.to_str().unwrap());
          if !extensions_set.contains(&ext_with_dot) {
            eprintln!(
              "\t! Resolved to {}, but it's not a JS/TS file",
              resolved_path.display()
            );
            continue;
          }

          let path_buf = resolved_path.to_path_buf();
          if !processed.contains(&path_buf) && !next_queue.contains(&path_buf) {
            next_queue.push(path_buf);
          }
        }

        // let path = resolved_path.to_str().unwrap();
        // println!("\tResolved {} to {}", source, path);
      }

      println!("\n\t{:?}\n", result);
    }

    queue = next_queue.clone();
  }

  count
}

fn main() {
  let start = std::time::Instant::now();

  let workdir = env::args()
    .nth(1)
    .map(PathBuf::from)
    .unwrap_or_else(|| env::current_dir().unwrap());

  let allocator = Allocator::default();
  let mut cache = HashMap::new();
  let mut count = 0;

  let supported_extensions: HashSet<&OsStr> = HashSet::from_iter(EXTENSIONS.iter().map(OsStr::new));

  for entry in WalkDir::new(workdir) {
    match entry {
      Ok(entry) => {
        let path = entry.path();
        if path.is_file()
          && path.extension().is_some_and(|ext| {
            let with_dot = format!(".{}", ext.to_str().unwrap());
            supported_extensions.contains(OsStr::new(&with_dot))
          })
        {
          let name = path.to_string_lossy().to_string();
          if name.ends_with(".d.ts") {
            continue;
          }

          let file_content = std::fs::read_to_string(path).unwrap();

          if !file_content.contains("from \"@linaria") {
            continue;
          }

          count += process_entrypoint(path.to_string_lossy().to_string(), &allocator, &mut cache);
        }
      }
      Err(e) => eprintln!("Error: {}", e),
    }
  }

  let duration = start.elapsed();
  println!("Processed {} files in {:?}", count, duration);
}

// BASE: Processed 2533 files in 3.7s
// Without JSX: Processed 888 files in 1.211218417s
