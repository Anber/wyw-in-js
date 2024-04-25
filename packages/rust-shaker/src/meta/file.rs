use crate::meta::export::{Export, Exports};
use crate::meta::import::{Import, Imports};

#[derive(Clone, Debug, Default)]
pub struct Meta<'a> {
  pub imports: Imports<'a>,
  pub exports: Exports<'a>,
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
