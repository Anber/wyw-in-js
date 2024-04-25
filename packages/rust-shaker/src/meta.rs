pub mod export;
pub mod file;
pub mod ident_usages;
pub mod import;

use crate::declaration_context::DeclarationContext;
use crate::meta::export::ExportArea;
use crate::meta::file::Meta;
use crate::meta::ident_usages::IdentUsage;
use oxc::span::{Atom, Span};
use std::collections::HashMap;
use std::path::Path;

pub struct MetaCollector<'a> {
  pub data: Meta<'a>,
  pub declaration_context: DeclarationContext<'a>,
  pub export_areas: Vec<ExportArea<'a>>,
  pub file_name: &'a Path,
  pub identifier_usages: HashMap<Atom<'a>, Vec<IdentUsage<'a>>>,
  pub ignored_spans: Vec<Span>,
}

impl MetaCollector<'_> {
  pub fn new(file_name: &Path) -> MetaCollector {
    MetaCollector {
      data: Default::default(),
      declaration_context: DeclarationContext::None,
      identifier_usages: Default::default(),
      ignored_spans: Default::default(),
      export_areas: Default::default(),
      file_name,
    }
  }
}
