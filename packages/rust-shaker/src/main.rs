mod collect_meta;
mod meta;
mod processors;

use crate::collect_meta::{collect_meta, parse_js_file_from_source};
use oxc::allocator::Allocator;
use oxc::span::{Atom, SourceType, Span};
use pluginator::plugin::LoadingError;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::PathBuf;
use std::{env, path::Path};
use walkdir::WalkDir;
use wyw_processor::params::ProcessorCall;
use wyw_processor::{load_processor, PostProcessResult, ProcessResult};
use wyw_shaker::default_resolver::create_resolver;
use wyw_shaker::references::References;
use wyw_shaker::replacements::Replacements;
use wyw_shaker::{shake, ShakerOptions};

const EXTENSIONS: [&str; 5] = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

fn get_processor<'a>(
  proc_call: &ProcessorCall<'a>,
) -> Result<pluginator::LoadedPlugin<dyn wyw_processor::Processor<'a>>, LoadingError> {
  let processor = &proc_call.processor;
  unsafe {
    let processor = load_processor(processor)?;
    Ok(processor)
  }
}

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

      let (semantic, program) =
        match parse_js_file_from_source(allocator, path, &file_content, source_type) {
          Ok(res) => res,
          Err(e) => {
            eprintln!("\t! Error: {:?}", e);
            continue;
          }
        };

      let references = References::from_semantic(&semantic, allocator);

      let root = env::current_dir().unwrap();
      let meta = collect_meta(
        semantic.symbols(),
        &root,
        path,
        &file_content,
        allocator,
        &resolver,
        &program,
      );

      let mut replacements = Replacements::new(vec![]);

      for proc_call in &meta.processor_calls {
        let processor = get_processor(proc_call);
        if let Err(e) = processor {
          eprintln!("\t! Error: {:?}", e);
          continue;
        }

        let params = &proc_call.params;
        let processor = processor.unwrap();

        let proc_result = processor.process(params);

        if let ProcessResult::Err(err) = proc_result {
          eprintln!("\t! Error: {}", err);
          continue;
        }

        let post_result = processor.post_process(params);
        match post_result {
          PostProcessResult::Replace(span, replacement) => {
            replacements.add_replacement(span, replacement);
          }
          PostProcessResult::Err(err) => {
            eprintln!("\t! Error: {}", err);
            continue;
          }
          PostProcessResult::Ok => {}
        }
      }

      // let runtime_code = replacements.apply(&file_content);

      let shaken = shake(
        &program,
        &meta,
        replacements,
        &semantic,
        allocator,
        ShakerOptions {
          remove_jsx_and_hooks: false,
        },
      );
      //
      // // let result =
      // //   parse_js_file_from_source(allocator, &resolver, path, &file_content, source_type);
      //
      // cache.insert(path.to_path_buf(), true);
      //

      println!(
        "Runtime:\n{}",
        shaken, // apply_replacements(&file_content, result.evaltime_replacements.clone())
      );

      // for import in &meta.imports.list {
      //   let source = import.source();
      //
      //   let resolved_path = match source {
      //     Source::Resolved(path, _) => path,
      //     Source::Unresolved(_) => {
      //       eprintln!("\t! Unresolved import: {:?}", import);
      //       continue;
      //     }
      //   };
      //
      //   if let Some(ext) = resolved_path.extension() {
      //     let ext_with_dot = format!(".{}", ext.to_str().unwrap());
      //     if !extensions_set.contains(&ext_with_dot) {
      //       eprintln!(
      //         "\t! Resolved to {}, but it's not a JS/TS file",
      //         resolved_path.display()
      //       );
      //       continue;
      //     }
      //
      //     let path_buf = resolved_path.to_path_buf();
      //     if !processed.contains(&path_buf) && !next_queue.contains(&path_buf) {
      //       next_queue.push(path_buf);
      //     }
      //   }
      //
      //   // let path = resolved_path.to_str().unwrap();
      //   // println!("\tResolved {} to {}", source, path);
      // }
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
