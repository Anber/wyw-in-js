use oxc::allocator::Allocator;
use oxc::span::Atom;
use oxc_resolver::Resolver;
use std::fmt::Debug;
use std::path::Path;

#[derive(Clone, Eq, PartialEq)]
pub enum ModuleSource<'a> {
  Unresolved(Atom<'a>),
  Resolved(&'a Path),
}

impl<'a> Debug for ModuleSource<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      ModuleSource::Unresolved(atom) => write!(f, "{:?}", atom),
      ModuleSource::Resolved(path) => write!(f, "Resolved({:?})", path),
    }
  }
}

impl<'a> PartialOrd for ModuleSource<'a> {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    match (self, other) {
      (ModuleSource::Unresolved(a), ModuleSource::Unresolved(b)) => Some(a.cmp(b)),
      (ModuleSource::Resolved(a), ModuleSource::Resolved(b)) => Some(a.cmp(b)),
      (ModuleSource::Unresolved(_), ModuleSource::Resolved(_)) => Some(std::cmp::Ordering::Less),
      (ModuleSource::Resolved(_), ModuleSource::Unresolved(_)) => Some(std::cmp::Ordering::Greater),
    }
  }
}

impl<'a> Ord for ModuleSource<'a> {
  fn cmp(&self, other: &Self) -> std::cmp::Ordering {
    self.partial_cmp(other).unwrap()
  }
}

impl<'a> PartialEq<str> for ModuleSource<'a> {
  fn eq(&self, other: &str) -> bool {
    if let ModuleSource::Unresolved(path) = self {
      return path == other;
    }

    false
  }
}

impl<'a> ModuleSource<'a> {
  pub fn as_unresolved(&self) -> Option<&Atom<'a>> {
    match self {
      ModuleSource::Unresolved(atom) => Some(atom),
      _ => None,
    }
  }

  pub fn as_resolved(
    &self,
    allocator: &'a Allocator,
    resolver: &Resolver,
    directory: &Path,
  ) -> Self {
    match self {
      ModuleSource::Unresolved(atom) => {
        if let Ok(resolution) = resolver.resolve(directory, atom) {
          let resolution = allocator.alloc(resolution);

          ModuleSource::Resolved(resolution.path())
        } else {
          // TODO: this should be handled differently
          panic!("failed to resolve {:?}", atom);
        }
      }

      ModuleSource::Resolved(_) => self.clone(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn test_import_source_equality() {
    let a = ModuleSource::Unresolved(Atom::from("test"));
    let b = ModuleSource::Unresolved(Atom::from("other-module"));

    assert_eq!(a, a);
    assert_ne!(a, b);
  }
}
