pub mod export;
pub mod file;
pub mod ident_usages;
pub mod import;
pub mod local_identifier;
pub mod processor_params;
pub mod references;
mod replacements;
mod shaker;
pub mod symbol;
mod traverse;
mod unnecessary_code;

use crate::declaration_context::DeclarationContext;
use crate::meta::export::ExportArea;
use crate::meta::file::Meta;
use crate::meta::ident_usages::IdentUsage;
use crate::meta::references::References;
use crate::meta::symbol::Symbol;
use oxc::allocator::Allocator;
use oxc::span::{Atom, Span};
use oxc_resolver::Resolver;
use std::collections::HashMap;
use std::path::Path;

pub struct MetaCollector<'a> {
  pub allocator: &'a Allocator,
  pub meta: Meta<'a>,
  pub declaration_context: DeclarationContext<'a>,
  pub export_areas: Vec<ExportArea<'a>>,
  pub file_name: &'a Path,
  pub identifier_usages: HashMap<&'a Symbol<'a>, Vec<IdentUsage<'a>>>,
  pub ignored_spans: Vec<Span>,

  pub references: References<'a>,

  pub resolver: &'a Resolver,

  pub source: &'a str,
  pub unnecessary_code: Vec<Span>,
}

impl<'a> MetaCollector<'a> {
  pub fn new(
    file_name: &'a Path,
    source: &'a str,
    allocator: &'a Allocator,
    resolver: &'a Resolver,
  ) -> MetaCollector<'a> {
    MetaCollector {
      allocator,
      meta: Meta::new(file_name),
      declaration_context: DeclarationContext::None,
      identifier_usages: Default::default(),
      ignored_spans: Default::default(),
      export_areas: Default::default(),
      file_name,

      references: Default::default(),

      resolver,

      source,
      unnecessary_code: Default::default(),
    }
  }

  pub(crate) fn alloc_atom(&self, str: String) -> Atom<'a> {
    self.allocator.alloc(str).as_str().into()
  }
}
