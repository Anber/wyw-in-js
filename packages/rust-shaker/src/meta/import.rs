use crate::meta::import::Source::{Resolved, Unresolved};
use crate::meta::local_identifier::LocalIdentifier;
use crate::meta::symbol::Symbol;
use oxc::span::Atom;
use std::fmt::Debug;
use std::path::{Path, PathBuf};

#[derive(Clone, Eq, PartialEq)]
pub enum Source<'a> {
  Unresolved(Atom<'a>),
  Resolved(&'a Path),
}

impl<'a> Debug for Source<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Unresolved(atom) => write!(f, "{:?}", atom),
      Resolved(path) => write!(f, "Resolved({:?})", path),
    }
  }
}

impl<'a> PartialOrd for Source<'a> {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    match (self, other) {
      (Unresolved(a), Unresolved(b)) => Some(a.cmp(b)),
      (Resolved(a), Resolved(b)) => Some(a.cmp(b)),
      (Unresolved(_), Resolved(_)) => Some(std::cmp::Ordering::Less),
      (Resolved(_), Unresolved(_)) => Some(std::cmp::Ordering::Greater),
    }
  }
}

impl<'a> Ord for Source<'a> {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    self.partial_cmp(other).unwrap()
  }
}

impl<'a> PartialEq<str> for Source<'a> {
  fn eq(&self, other: &str) -> bool {
    if let Unresolved(path) = self {
      return path == other;
    }

    false
  }
}

impl<'a> Source<'a> {
  pub fn as_unresolved(&self) -> Option<&Atom<'a>> {
    match self {
      Unresolved(atom) => Some(atom),
      _ => None,
    }
  }
}

#[derive(Clone, PartialEq)]
pub enum Processor {
  Resolved(PathBuf),
  Unresolved,
  None,
}

#[derive(Clone, PartialEq)]
pub enum Import<'a> {
  Default {
    source: Source<'a>,
    local: LocalIdentifier<'a>,
  },

  Named {
    source: Source<'a>,
    imported: Atom<'a>,
    local: LocalIdentifier<'a>,
    processor: Processor,
  },

  Namespace {
    source: Source<'a>,
    local: &'a Symbol<'a>,
  },

  SideEffect {
    source: Source<'a>,
  },
}

impl<'a> Debug for Import<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Self::Named {
        source,
        imported,
        local,
        processor,
      } => {
        let mut base = f.debug_struct("Named");
        let mut common_fields = base
          .field("source", source)
          .field("imported", imported)
          .field("local", local);

        if let Processor::Resolved(p) = processor {
          common_fields = common_fields.field("processor", p);
        }

        common_fields.finish()
      }
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
  pub(crate) fn local(&self) -> Option<LocalIdentifier<'a>> {
    match self {
      Self::Default { local, .. } => Some(local.clone()),
      Self::Named { local, .. } => Some(local.clone()),
      Self::Namespace { local, .. } => Some(LocalIdentifier::Identifier(<&Symbol>::clone(local))),
      Self::SideEffect { .. } => None,
    }
  }

  pub fn source(&self) -> &Source<'a> {
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

  pub fn set_resolved(&mut self, path: &'a Path) -> &mut Self {
    *self = match self {
      Self::Default { local, .. } => Self::Default {
        source: Resolved(path),
        local: local.clone(),
      },
      Self::Named {
        imported,
        local,
        processor,
        ..
      } => Self::Named {
        source: Resolved(path),
        imported: imported.clone(),
        local: local.clone(),
        processor: processor.clone(),
      },
      Self::Namespace { local, .. } => Self::Namespace {
        source: Resolved(path),
        local,
      },
      Self::SideEffect { .. } => Self::SideEffect {
        source: Resolved(path),
      },
    };

    self
  }

  pub fn set_processor(&mut self, processor: PathBuf) {
    if let Self::Named { processor: p, .. } = self {
      *p = Processor::Resolved(processor);
    } else {
      todo!("set_processor for {:?}", self);
    }
  }
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

#[derive(Clone, Default)]
pub struct Imports<'a> {
  pub list: Vec<Import<'a>>,
}

impl<'a> Debug for Imports<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_list().entries(self.list.iter()).finish()
  }
}

impl<'a> Imports<'a> {
  pub fn add(&mut self, import: Import<'a>) {
    self.list.push(import);
  }

  pub fn add_side_effect(&mut self, source: &Source<'a>) {
    self.add(Import::SideEffect {
      source: source.clone(),
    });
  }

  pub fn add_side_effect_unresolved(&mut self, source: &Atom<'a>) {
    self.add_side_effect(&Unresolved(source.clone()));
  }

  pub fn add_default(&mut self, source: &Source<'a>, local: &LocalIdentifier<'a>) {
    self.add(Import::Default {
      source: source.clone(),
      local: local.clone(),
    });
  }

  pub fn add_unresolved_default(&mut self, source: &Atom<'a>, local: &LocalIdentifier<'a>) {
    self.add_default(&Unresolved(source.clone()), local);
  }

  pub fn add_named(
    &mut self,
    source: &Source<'a>,
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
      processor: Processor::Unresolved,
    });
  }

  pub fn add_unresolved_named(
    &mut self,
    source: &Atom<'a>,
    imported: &Atom<'a>,
    local: &LocalIdentifier<'a>,
  ) {
    self.add_named(&Unresolved(source.clone()), imported, local);
  }

  pub fn add_namespace(&mut self, source: &Source<'a>, local: &'a Symbol<'a>) {
    self.add(Import::Namespace {
      source: source.clone(),
      local,
    });
  }

  pub fn add_unresolved_namespace(&mut self, source: &Atom<'a>, local: &'a Symbol<'a>) {
    self.add_namespace(&Unresolved(source.clone()), local);
  }

  pub fn find_all_by_source(&self, expected: &str) -> Vec<&Import<'a>> {
    self
      .list
      .iter()
      .filter(|import| import.source() == expected)
      .collect()
  }

  pub fn find_ns_by_source(&self, expected: &str) -> Option<&'a Symbol<'a>> {
    self.list.iter().find_map(|import| {
      if let Import::Namespace { source, local } = import {
        if source == expected {
          return Some(*local);
        }
      }

      None
    })
  }

  pub fn find_by_symbol(&mut self, symbol: &Symbol<'a>) -> Option<&mut Import<'a>> {
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