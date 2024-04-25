use oxc::span::Atom;
use std::fmt::Debug;

#[derive(Clone, Debug, PartialEq)]
pub enum LocalIdentifier<'a> {
  Identifier(Atom<'a>),
  MemberExpression(Atom<'a>, Atom<'a>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Import<'a> {
  Default {
    source: Atom<'a>,
    local: LocalIdentifier<'a>,
  },

  Named {
    source: Atom<'a>,
    imported: Atom<'a>,
    local: LocalIdentifier<'a>,
  },

  Namespace {
    source: Atom<'a>,
    local: Atom<'a>,
  },

  SideEffect {
    source: Atom<'a>,
  },
}

impl<'a> Import<'a> {
  pub fn source(&self) -> &Atom<'a> {
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

  pub fn add_side_effect(&mut self, source: &Atom<'a>) {
    self.add(Import::SideEffect {
      source: source.clone(),
    });
  }

  pub fn add_default(&mut self, source: &Atom<'a>, local: &LocalIdentifier<'a>) {
    self.add(Import::Default {
      source: source.clone(),
      local: local.clone(),
    });
  }

  pub fn add_named(&mut self, source: &Atom<'a>, imported: &Atom<'a>, local: &LocalIdentifier<'a>) {
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

  pub fn add_namespace(&mut self, source: &Atom<'a>, local: &Atom<'a>) {
    self.add(Import::Namespace {
      source: source.clone(),
      local: local.clone(),
    });
  }

  pub fn find_ns_by_source(&self, expected: &str) -> Option<&Atom<'a>> {
    self.list.iter().find_map(|import| {
      if let Import::Namespace { source, local } = import {
        if source == expected {
          return Some(local);
        }
      }

      None
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
