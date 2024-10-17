use oxc::allocator::Allocator;
use oxc::span::{Atom, Span};
use oxc_resolver::Resolver;
use std::path::{Path, PathBuf};
use wyw_shaker::export::ExportArea;
use wyw_shaker::ident_usages::IdentUsages;
use wyw_shaker::meta::Meta;

pub struct MetaCollector<'a> {
  pub allocator: &'a Allocator,
  pub meta: Meta<'a>,
  pub export_areas: Vec<ExportArea<'a>>,
  pub file_name: &'a PathBuf,
  pub root: &'a PathBuf,
  pub identifier_usages: IdentUsages<'a>,
  pub ignored_spans: Vec<Span>,

  pub resolver: &'a Resolver,

  pub source: &'a str,
}

impl<'a> MetaCollector<'a> {
  pub fn new(
    root: &'a PathBuf,
    file_name: &'a PathBuf,
    source: &'a str,
    allocator: &'a Allocator,
    resolver: &'a Resolver,
  ) -> MetaCollector<'a> {
    MetaCollector {
      allocator,
      meta: Meta::new(allocator, file_name, resolver),
      identifier_usages: Default::default(),
      ignored_spans: Default::default(),
      export_areas: Default::default(),
      file_name,
      resolver,
      root,
      source,
    }
  }

  pub(crate) fn alloc_atom(&self, str: String) -> Atom<'a> {
    self.allocator.alloc(str).as_str().into()
  }
}
