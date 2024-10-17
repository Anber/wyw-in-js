use crate::import::Source;
use oxc::allocator::Allocator;
use oxc::span::{Atom, Span};
use oxc_resolver::Resolver;
use std::fmt::Debug;
use std::path::Path;

#[derive(Clone, Debug, PartialEq)]
pub enum ExportedValue<'a> {
  BigIntLiteral(Atom<'a>),
  BooleanLiteral(bool),
  Identifier(Atom<'a>),
  NullLiteral,
  NumericLiteral(f64),
  Span(Span),
  StringLiteral(Atom<'a>),
  Void0,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Export<'a> {
  #[default]
  Default, // TODO: handle value

  Named {
    local: ExportedValue<'a>,
    exported: Atom<'a>,
  },

  Reexport {
    orig: Atom<'a>,
    exported: Atom<'a>,
    source: Source<'a>,
  },

  ReexportAll {
    source: Source<'a>,
  },

  ReexportNamespace {
    exported: Atom<'a>,
    source: Source<'a>,
  },
}

impl<'a> Export<'a> {
  fn order(&self) -> usize {
    match self {
      Self::Default => 0,
      Self::Named { .. } => 1,
      Self::Reexport { .. } => 2,
      Self::ReexportAll { .. } => 3,
      Self::ReexportNamespace { .. } => 4,
    }
  }
}

impl Ord for Export<'_> {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    match (self, other) {
      (a, b) if a.order() != b.order() => a.order().cmp(&b.order()),
      (Self::Named { exported: a, .. }, Self::Named { exported: b, .. }) => a.cmp(b),
      (
        Self::Reexport {
          exported: a_name,
          source: a_source,
          ..
        },
        Self::Reexport {
          exported: b_name,
          source: b_source,
          ..
        },
      ) => {
        if a_source != b_source {
          a_source.cmp(b_source)
        } else {
          a_name.cmp(b_name)
        }
      }
      (Self::ReexportAll { source: a }, Self::ReexportAll { source: b }) => a.cmp(b),
      (_, _) => std::cmp::Ordering::Equal,
    }
  }
}

impl<'a> PartialOrd for Export<'a> {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    Some(self.cmp(other))
  }
}

impl Eq for Export<'_> {}

#[derive(Clone)]
pub struct Exports<'a> {
  allocator: &'a Allocator,
  directory: &'a Path,
  pub es_module: bool,
  pub list: Vec<Export<'a>>,
  resolver: &'a Resolver,
}

impl<'a> Debug for Exports<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_list().entries(self.list.iter()).finish()
  }
}

impl<'a> Exports<'a> {
  pub fn new(allocator: &'a Allocator, resolver: &'a Resolver, directory: &'a Path) -> Self {
    Self {
      allocator,
      directory,
      es_module: false,
      list: Vec::new(),
      resolver,
    }
  }

  pub fn add(&mut self, export: Export<'a>) {
    if let Export::Named { exported, .. } = &export {
      if exported == "__esModule" {
        self.mark_as_es_module();

        return;
      }
    }

    self.list.push(export);
  }

  pub fn add_default(&mut self) {
    self.add(Export::Default);
  }

  pub fn add_named(&mut self, local: ExportedValue<'a>, exported: &Atom<'a>) {
    self.add(Export::Named {
      local,
      exported: exported.clone(),
    });
  }

  pub fn add_reexport(&mut self, orig: &Atom<'a>, exported: &Atom<'a>, source: &Source<'a>) {
    self.add(Export::Reexport {
      orig: orig.clone(),
      exported: exported.clone(),
      source: source.as_resolved(self.allocator, self.resolver, self.directory),
    });
  }

  pub fn add_unresolved_reexport(
    &mut self,
    orig: &Atom<'a>,
    exported: &Atom<'a>,
    source: &Atom<'a>,
  ) {
    self.add_reexport(orig, exported, &Source::Unresolved(source.clone()));
  }

  pub fn add_reexport_all(&mut self, source: &Source<'a>) {
    self.add(Export::ReexportAll {
      source: source.as_resolved(self.allocator, self.resolver, self.directory),
    });
  }

  pub fn add_unresolved_reexport_all(&mut self, source: &Atom<'a>) {
    self.add_reexport_all(&Source::Unresolved(source.clone()));
  }

  pub fn add_reexport_namespace(&mut self, exported: &Atom<'a>, source: &Source<'a>) {
    self.add(Export::ReexportNamespace {
      exported: exported.clone(),
      source: source.as_resolved(self.allocator, self.resolver, self.directory),
    });
  }

  pub fn add_unresolved_reexport_namespace(&mut self, exported: &Atom<'a>, source: &Atom<'a>) {
    self.add_reexport_namespace(exported, &Source::Unresolved(source.clone()));
  }

  pub fn mark_as_es_module(&mut self) {
    self.es_module = true;
  }
}

impl<'a> IntoIterator for Exports<'a> {
  type Item = Export<'a>;
  type IntoIter = std::vec::IntoIter<Export<'a>>;

  fn into_iter(self) -> Self::IntoIter {
    self.list.into_iter()
  }
}

#[derive(Clone, Debug, Default)]
pub struct ExportArea<'a> {
  pub export: Export<'a>,
  pub span: Span,
}
