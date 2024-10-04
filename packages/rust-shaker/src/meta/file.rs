use crate::meta::export::{Export, Exports};
use crate::meta::import::{Import, Imports, Source};
use crate::meta::processor_params::ListOfProcessorParams;
use oxc::allocator::Allocator;
use oxc::span::{Atom, Span};
use oxc_resolver::Resolver;
use std::fmt::Debug;
use std::path::Path;

pub struct Meta<'a> {
  file_name: &'a Path,

  pub cjs: bool,
  pub directory: &'a Path,
  pub imports: Imports<'a>,
  pub exports: Exports<'a>,

  pub evaltime_replacements: Vec<(Span, Atom<'a>)>,
  pub processor_params: ListOfProcessorParams<'a>,
}

impl<'a> Debug for Meta<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let mut base = f.debug_struct("Meta");

    let mut common_fields = base
      .field("cjs", &self.cjs)
      .field("es_module", &self.exports.es_module)
      .field("imports", &self.imports)
      .field("exports", &self.exports);

    if !self.evaltime_replacements.is_empty() {
      common_fields = common_fields.field("evaltime_replacements", &self.evaltime_replacements);
    }

    if !self.processor_params.is_empty() {
      common_fields = common_fields.field("processor_params", &self.processor_params);
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

  pub fn new(file_name: &'a Path) -> Meta<'a> {
    Meta {
      cjs: true,
      directory: file_name.parent().unwrap(),
      file_name,
      imports: Imports::default(),
      exports: Exports::default(),

      evaltime_replacements: Default::default(),
      processor_params: Default::default(),
    }
  }

  pub fn resolve_all(&mut self, resolver: &'a Resolver, allocator: &'a Allocator) {
    let imports = &mut self.imports.list.iter_mut().map(|import| match import {
      Import::Default { source, .. }
      | Import::Named { source, .. }
      | Import::Namespace { source, .. }
      | Import::SideEffect { source } => source,
    });

    let exports = &mut self
      .exports
      .list
      .iter_mut()
      .filter_map(|export| match export {
        Export::Reexport { source, .. }
        | Export::ReexportAll { source, .. }
        | Export::ReexportNamespace { source, .. } => Some(source),
        _ => None,
      });

    for source in &mut imports.chain(exports) {
      let unresolved = source.as_unresolved();
      if unresolved.is_none() {
        continue;
      }

      let resolved = resolver.resolve(self.directory, unresolved.unwrap());
      let resolved = match resolved {
        Ok(resolved) => allocator.alloc(resolved),
        Err(_) => continue,
      };

      *source = Source::Resolved(resolved.path());
    }
  }

  pub fn optimize_replacements(&mut self) {
    self
      .evaltime_replacements
      .sort_by_key(|(span, _)| span.start);
    self
      .evaltime_replacements
      .dedup_by(|(span1, _), (span2, _)| span2.end > span1.start);
  }
}

#[derive(Default)]
pub struct JsFilePatch<'a> {
  pub imports: Imports<'a>,
  pub exports: Exports<'a>,

  pub imports_for_delete: Vec<Import<'a>>,
  pub exports_for_delete: Vec<Export<'a>>,
}

impl<'a> JsFilePatch<'a> {
  pub fn delete_import(&mut self, import: &Import<'a>) {
    self.imports_for_delete.push(import.clone());
  }

  pub fn delete_export(&mut self, export: &Export<'a>) {
    self.exports_for_delete.push(export.clone());
  }
}
