use crate::module_source::ModuleSource;
use oxc::allocator::Allocator;
use oxc::span::Atom;
use oxc_resolver::Resolver;
use std::fmt::Debug;
use std::path::Path;
use wyw_traverse::local_identifier::LocalIdentifier;
use wyw_traverse::symbol::Symbol;

#[derive(Clone, PartialEq)]
pub enum Import<'a> {
  Default {
    source: ModuleSource<'a>,
    local: LocalIdentifier<'a>,
  },

  Named {
    source: ModuleSource<'a>,
    imported: Atom<'a>,
    local: LocalIdentifier<'a>,
  },

  Namespace {
    source: ModuleSource<'a>,
    local: &'a Symbol,
  },

  SideEffect {
    source: ModuleSource<'a>,
  },
}

impl<'a> Debug for Import<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      _named @ Self::Named {
        source,
        imported,
        local,
      } => f
        .debug_struct("Named")
        .field("source", source)
        .field("imported", imported)
        .field("local", local)
        .finish(),
      Self::Default { source, local } => f
        .debug_struct("Default")
        .field("source", source)
        .field("local", local)
        .finish(),
      Self::Namespace { source, local } => f
        .debug_struct("Namespace")
        .field("source", source)
        .field("local", local)
        .finish(),
      Self::SideEffect { source } => f
        .debug_struct("SideEffect")
        .field("source", source)
        .finish(),
    }
  }
}

impl<'a> Import<'a> {
  pub fn local(&self) -> Option<LocalIdentifier<'a>> {
    match self {
      Self::Default { local, .. } => Some(local.clone()),
      Self::Named { local, .. } => Some(local.clone()),
      Self::Namespace { local, .. } => Some(LocalIdentifier::Identifier(<&Symbol>::clone(local))),
      Self::SideEffect { .. } => None,
    }
  }

  // TODO Should be implemented differently
  // pub fn processor(&self) -> Option<&PathBuf> {
  //   match self {
  //     Self::Named {
  //       source, imported, ..
  //     } => {
  //       if let ImportSource::Resolved(_, WywConfig::Resolved { tags }) = source {
  //         if let Some(tag) = tags.iter().find(|tag| tag.name == imported.as_str()) {
  //           return Some(&tag.processor);
  //         }
  //       }

  //       None
  //     }
  //     _ => None,
  //   }
  // }

  pub fn source(&self) -> &ModuleSource<'a> {
    match self {
      Self::Default { source, .. }
      | Self::Named { source, .. }
      | Self::Namespace { source, .. }
      | Self::SideEffect { source } => source,
    }
  }

  fn order(&self) -> usize {
    match self {
      Self::Default { .. } => 0,
      Self::Named { .. } => 1,
      Self::Namespace { .. } => 2,
      Self::SideEffect { .. } => 3,
    }
  }

  pub fn set_source(&mut self, source: ModuleSource<'a>) -> &mut Self {
    *self = match self {
      Self::Default { local, .. } => Self::Default {
        source,
        local: local.clone(),
      },
      Self::Named {
        imported, local, ..
      } => Self::Named {
        source,
        imported: imported.clone(),
        local: local.clone(),
      },
      Self::Namespace { local, .. } => Self::Namespace { source, local },
      Self::SideEffect { .. } => Self::SideEffect { source },
    };

    self
  }

  // pub fn set_processor(&mut self, processor: PathBuf) {
  //   if let Self::Named { processor: p, .. } = self {
  //     *p = Processor::Resolved(processor);
  //   } else {
  //     todo!("set_processor for {:?}", self);
  //   }
  // }
}

impl Ord for Import<'_> {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    match (self, other) {
      (a, b) if a.order() != b.order() => a.order().cmp(&b.order()),
      (a, b) if a.source() != b.source() => a.source().cmp(b.source()),
      (Self::Named { imported: a, .. }, Self::Named { imported: b, .. }) => a.cmp(b),
      (_, _) => std::cmp::Ordering::Equal,
    }
  }
}

impl<'a> PartialOrd for Import<'a> {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    Some(self.cmp(other))
  }
}

impl Eq for Import<'_> {}

#[derive(Clone)]
pub struct Imports<'a> {
  allocator: &'a Allocator,
  directory: &'a Path,
  pub list: Vec<Import<'a>>,
  resolver: &'a Resolver,
}

impl<'a> Debug for Imports<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_list().entries(self.list.iter()).finish()
  }
}

impl<'a> Imports<'a> {
  pub fn new(allocator: &'a Allocator, resolver: &'a Resolver, directory: &'a Path) -> Self {
    Self {
      allocator,
      directory,
      list: Vec::new(),
      resolver,
    }
  }

  pub fn add(&mut self, import: Import<'a>) {
    match import.source() {
      ModuleSource::Resolved(_) => {
        self.list.push(import);
      }
      unresolved @ ModuleSource::Unresolved(_) => {
        let resolved = unresolved.as_resolved(self.allocator, self.resolver, self.directory);
        let mut import = import.clone();
        import.set_source(resolved);
        self.list.push(import);
      }
    }
  }

  pub fn add_side_effect(&mut self, source: &ModuleSource<'a>) {
    self.add(Import::SideEffect {
      source: source.clone(),
    });
  }

  pub fn add_side_effect_unresolved(&mut self, source: &Atom<'a>) {
    self.add_side_effect(&ModuleSource::Unresolved(source.clone()));
  }

  pub fn add_default(&mut self, source: &ModuleSource<'a>, local: &LocalIdentifier<'a>) {
    self.add(Import::Default {
      source: source.clone(),
      local: local.clone(),
    });
  }

  pub fn add_unresolved_default(&mut self, source: &Atom<'a>, local: &LocalIdentifier<'a>) {
    self.add_default(&ModuleSource::Unresolved(source.clone()), local);
  }

  pub fn add_named(
    &mut self,
    source: &ModuleSource<'a>,
    imported: &Atom<'a>,
    local: &LocalIdentifier<'a>,
  ) {
    // FIXME: it might be a legit named import. We have to check source file to be sure.
    if imported == "default" {
      self.add(Import::Default {
        source: source.clone(),
        local: local.clone(),
      });

      return;
    }

    self.add(Import::Named {
      source: source.clone(),
      imported: imported.clone(),
      local: local.clone(),
    });
  }

  pub fn add_unresolved_named(
    &mut self,
    source: &Atom<'a>,
    imported: &Atom<'a>,
    local: &LocalIdentifier<'a>,
  ) {
    self.add_named(&ModuleSource::Unresolved(source.clone()), imported, local);
  }

  pub fn add_namespace(&mut self, source: &ModuleSource<'a>, local: &'a Symbol) {
    self.add(Import::Namespace {
      source: source.clone(),
      local,
    });
  }

  pub fn add_unresolved_namespace(&mut self, source: &Atom<'a>, local: &'a Symbol) {
    self.add_namespace(&ModuleSource::Unresolved(source.clone()), local);
  }

  pub fn find_all_by_source(&self, expected: &str) -> Vec<&Import<'a>> {
    self
      .list
      .iter()
      .filter(|import| import.source() == expected)
      .collect()
  }

  pub fn find_ns_by_source(&self, expected: &str) -> Option<&'a Symbol> {
    self.list.iter().find_map(|import| {
      if let Import::Namespace { source, local } = import {
        if source == expected {
          return Some(*local);
        }
      }

      None
    })
  }

  pub fn find_by_symbol(&mut self, symbol: &Symbol) -> Option<&mut Import<'a>> {
    self.list.iter_mut().find(|import| {
      if let Some(LocalIdentifier::Identifier(local)) = import.local() {
        return local == symbol;
      }

      false
    })
  }
}

impl<'a> IntoIterator for Imports<'a> {
  type Item = Import<'a>;
  type IntoIter = std::vec::IntoIter<Import<'a>>;

  fn into_iter(self) -> Self::IntoIter {
    self.list.into_iter()
  }
}

#[cfg(test)]
mod tests {
  use crate::default_resolver::create_resolver;

  use super::*;
  use oxc::allocator::Allocator;
  use oxc::span::Span;
  use oxc_index::Idx;
  use oxc_semantic::SymbolId;
  use std::fs::File;
  use tempfile::tempdir;

  #[test]
  fn test_import_local_accessor() {
    let binding = Symbol::new_with_name(
      "local".to_string(),
      SymbolId::from_usize(0),
      Span::new(0, 0),
    );
    let ident = LocalIdentifier::Identifier(&binding);

    let default_import = Import::Default {
      source: ModuleSource::Unresolved(Atom::from("source")),
      local: ident.clone(),
    };
    let side_effect = Import::SideEffect {
      source: ModuleSource::Unresolved(Atom::from("source")),
    };

    assert_eq!(default_import.local(), Some(ident));
    assert_eq!(side_effect.local(), None);
  }

  #[test]
  fn test_import_source_resolution() {
    let dir = tempdir().unwrap();
    let dir_path = dir.path();

    let resolver = create_resolver(&dir_path.to_path_buf());
    let module_path = dir_path.join("foo.ts");
    File::create(&module_path).unwrap();

    let allocator = Allocator::default();
    let import_source = ModuleSource::Unresolved(Atom::from("./foo"));
    let resolved = import_source.as_resolved(&allocator, &resolver, dir_path);

    assert_eq!(
      resolved,
      ModuleSource::Resolved(module_path.canonicalize().unwrap().as_path())
    );
  }
}
