use crate::module_source::ModuleSource;
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
    source: ModuleSource<'a>,
  },

  ReexportAll {
    source: ModuleSource<'a>,
  },

  ReexportNamespace {
    exported: Atom<'a>,
    source: ModuleSource<'a>,
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

  pub fn add_reexport(&mut self, orig: &Atom<'a>, exported: &Atom<'a>, source: &ModuleSource<'a>) {
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
    self.add_reexport(orig, exported, &ModuleSource::Unresolved(source.clone()));
  }

  pub fn add_reexport_all(&mut self, source: &ModuleSource<'a>) {
    self.add(Export::ReexportAll {
      source: source.as_resolved(self.allocator, self.resolver, self.directory),
    });
  }

  pub fn add_unresolved_reexport_all(&mut self, source: &Atom<'a>) {
    self.add_reexport_all(&ModuleSource::Unresolved(source.clone()));
  }

  pub fn add_reexport_namespace(&mut self, exported: &Atom<'a>, source: &ModuleSource<'a>) {
    self.add(Export::ReexportNamespace {
      exported: exported.clone(),
      source: source.as_resolved(self.allocator, self.resolver, self.directory),
    });
  }

  pub fn add_unresolved_reexport_namespace(&mut self, exported: &Atom<'a>, source: &Atom<'a>) {
    self.add_reexport_namespace(exported, &ModuleSource::Unresolved(source.clone()));
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

#[cfg(test)]
mod tests {
  use crate::default_resolver::create_resolver;

  use super::*;
  use oxc::allocator::Allocator;
  use oxc::span::Atom;
  use std::fs::File;
  use tempfile::tempdir;

  #[test]
  fn test_resolved_reexports() {
    let dir = tempdir().unwrap();
    let dir_path = dir.path().to_path_buf();

    let allocator = Allocator::default();
    let resolver = create_resolver(&dir_path);

    let mut exports = Exports::new(&allocator, &resolver, &dir_path);

    let utils_source = ModuleSource::Unresolved(Atom::from("./utils"));
    let components_source = ModuleSource::Unresolved(Atom::from("./components"));

    let utils_path = dir_path.join("utils.ts");
    let components_path = dir_path.join("components.ts");

    File::create(utils_path.clone()).unwrap();
    File::create(components_path.clone()).unwrap();

    // "export { doSome } from './utils'"
    exports.add_reexport(&Atom::from("doSome"), &Atom::from("doSome"), &utils_source);
    // "export * from './components'"
    exports.add_reexport_all(&components_source);

    assert_eq!(exports.list.len(), 2);
    assert_eq!(
      exports.list[0],
      Export::Reexport {
        orig: Atom::from("doSome"),
        exported: Atom::from("doSome"),
        source: ModuleSource::Resolved(
          Atom::from("./utils"),
          &utils_path.canonicalize().unwrap().as_path()
        ),
      }
    );
    assert_eq!(
      exports.list[1],
      Export::ReexportAll {
        source: ModuleSource::Resolved(
          Atom::from("./components"),
          &components_path.canonicalize().unwrap().as_path()
        ),
      }
    );
  }
}
