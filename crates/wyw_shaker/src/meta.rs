use crate::export::{Export, Exports};
use crate::import::{Import, Imports};
use oxc::allocator::Allocator;
use oxc_resolver::Resolver;
use std::fmt::Debug;
use std::path::Path;
use wyw_processor::params::ProcessorCalls;

pub struct Meta<'a> {
  pub file_name: &'a Path,

  pub cjs: bool,
  pub directory: &'a Path,
  pub imports: Imports<'a>,
  pub exports: Exports<'a>,

  pub processor_calls: ProcessorCalls<'a>,
}

impl<'a> Debug for Meta<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let mut base = f.debug_struct("Meta");

    let mut common_fields = base
      .field("cjs", &self.cjs)
      .field("es_module", &self.exports.es_module)
      .field("imports", &self.imports)
      .field("exports", &self.exports);

    if !self.processor_calls.is_empty() {
      common_fields = common_fields.field("processor_calls", &self.processor_calls);
    }

    common_fields.finish()
  }
}

impl<'a> Meta<'a> {
  pub fn apply_patch(&mut self, patch: JsFilePatch<'a>) {
    self
      .imports
      .list
      .retain(|import| !patch.imports_for_delete.contains(import));
    self
      .exports
      .list
      .retain(|export| !patch.exports_for_delete.contains(export));

    self.imports.list.extend(patch.imports.list);
    self.exports.list.extend(patch.exports.list);

    self.imports.list.sort();
    self.exports.list.sort();
  }

  pub fn new(allocator: &'a Allocator, file_name: &'a Path, resolver: &'a Resolver) -> Meta<'a> {
    let directory = file_name.parent().unwrap();

    Meta {
      cjs: true,
      directory,
      file_name,
      imports: Imports::new(allocator, resolver, directory),
      exports: Exports::new(allocator, resolver, directory),

      processor_calls: Default::default(),
    }
  }
}

pub struct JsFilePatch<'a> {
  pub imports: Imports<'a>,
  pub exports: Exports<'a>,

  pub imports_for_delete: Vec<Import<'a>>,
  pub exports_for_delete: Vec<Export<'a>>,
}

impl<'a> JsFilePatch<'a> {
  pub fn new(allocator: &'a Allocator, resolver: &'a Resolver, directory: &'a Path) -> Self {
    Self {
      imports: Imports::new(allocator, resolver, directory),
      exports: Exports::new(allocator, resolver, directory),
      imports_for_delete: Vec::new(),
      exports_for_delete: Vec::new(),
    }
  }

  pub fn delete_import(&mut self, import: &Import<'a>) {
    self.imports_for_delete.push(import.clone());
  }

  pub fn delete_export(&mut self, export: &Export<'a>) {
    self.exports_for_delete.push(export.clone());
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::default_resolver::create_resolver;
  use oxc::allocator::Allocator;

  use std::path::Path;

  #[test]
  fn test_meta_new() {
    let allocator = Allocator::default();
    let file_name = Path::new("test_file.js");
    let resolver = create_resolver(&file_name.to_path_buf());

    let meta = Meta::new(&allocator, &file_name, &resolver);

    assert_eq!(meta.file_name, file_name);

    assert!(meta.imports.list.is_empty());
    assert!(meta.exports.list.is_empty());
  }
}
