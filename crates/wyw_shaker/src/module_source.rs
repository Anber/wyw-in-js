use oxc::allocator::Allocator;
use oxc::span::Atom;
use oxc_resolver::{ResolveError, Resolver};
use std::fmt::Debug;
use std::path::Path;

#[derive(Clone)]
pub enum ModuleSource<'a> {
  Unresolved(Atom<'a>),
  Resolved(Atom<'a>, &'a Path),
  ResolvedWithError(Atom<'a>, ResolveError),
}

impl<'a> Debug for ModuleSource<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      ModuleSource::Unresolved(atom) => write!(f, "{:?}", atom),
      ModuleSource::Resolved(atom, path) => write!(f, "Resolved({:?}, {:?})", atom, path),
      ModuleSource::ResolvedWithError(atom, err) => {
        write!(f, "ResolvedWithError({:?}, {:?})", atom, err)
      }
    }
  }
}

impl<'a> PartialOrd for ModuleSource<'a> {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    match (self, other) {
      (ModuleSource::Unresolved(a), ModuleSource::Unresolved(b)) => Some(a.cmp(b)),
      (ModuleSource::Resolved(a, _), ModuleSource::Resolved(b, _)) => Some(a.cmp(b)),
      (ModuleSource::ResolvedWithError(a, _), ModuleSource::ResolvedWithError(b, _)) => {
        Some(a.cmp(b))
      }

      (ModuleSource::Unresolved(_), ModuleSource::Resolved(..)) => Some(std::cmp::Ordering::Less),
      (ModuleSource::Unresolved(_), ModuleSource::ResolvedWithError(..)) => {
        Some(std::cmp::Ordering::Less)
      }

      (ModuleSource::Resolved(..), ModuleSource::Unresolved(_)) => {
        Some(std::cmp::Ordering::Greater)
      }
      (ModuleSource::Resolved(..), ModuleSource::ResolvedWithError(..)) => {
        Some(std::cmp::Ordering::Greater)
      }

      (ModuleSource::ResolvedWithError(..), ModuleSource::Unresolved(_)) => {
        Some(std::cmp::Ordering::Greater)
      }
      (ModuleSource::ResolvedWithError(..), ModuleSource::Resolved(..)) => {
        Some(std::cmp::Ordering::Less)
      }
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
    match self {
      ModuleSource::Unresolved(source) => source == other,
      ModuleSource::Resolved(source, _) => source == other,
      ModuleSource::ResolvedWithError(source, _) => source == other,
    }
  }
}

impl<'a> PartialEq for ModuleSource<'a> {
  fn eq(&self, other: &Self) -> bool {
    match (self, other) {
      (ModuleSource::Unresolved(a), ModuleSource::Unresolved(b)) => a == b,
      (ModuleSource::Resolved(a, _), ModuleSource::Resolved(b, _)) => a == b,
      (ModuleSource::ResolvedWithError(a, _), ModuleSource::ResolvedWithError(b, _)) => a == b,
      _ => false,
    }
  }
}

impl<'a> Eq for ModuleSource<'a> {}

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
      ModuleSource::Unresolved(atom) => match resolver.resolve(directory, atom) {
        Ok(resolution) => {
          let resolution = allocator.alloc(resolution);
          ModuleSource::Resolved(atom.clone(), resolution.path())
        }
        Err(err) => ModuleSource::ResolvedWithError(atom.clone(), err.clone()),
      },

      ModuleSource::Resolved(_, _) | ModuleSource::ResolvedWithError(_, _) => self.clone(),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::default_resolver::create_resolver;
  use tempfile::tempdir;

  #[test]
  fn test_unresolved_equality() {
    let unresolved_a = ModuleSource::Unresolved(Atom::from("test"));
    let unresolved_b = ModuleSource::Unresolved(Atom::from("test-other"));

    assert_eq!(unresolved_a, unresolved_a);
    assert_ne!(unresolved_a, unresolved_b);

    assert_eq!(unresolved_a, *"test");
    assert_ne!(unresolved_a, *"test-other");
  }

  #[test]
  fn test_resolved_equality() {
    let resolved_a = ModuleSource::Resolved(Atom::from("test"), Path::new("path/to/test"));
    let resolved_b =
      ModuleSource::Resolved(Atom::from("test-other"), Path::new("path/to/test-other"));

    assert_eq!(resolved_a, resolved_a);
    assert_ne!(resolved_a, resolved_b);

    assert_eq!(resolved_a, *"test");
    assert_ne!(resolved_a, *"test-other");
  }

  #[test]
  fn test_resolve_error() {
    let dir = tempdir().unwrap();
    let dir_path = dir.path();

    let resolver = create_resolver(&dir_path.to_path_buf());
    let allocator = Allocator::default();
    let import_source = ModuleSource::Unresolved(Atom::from("./nonexistent"));
    let resolved = import_source.as_resolved(&allocator, &resolver, dir_path);

    assert_eq!(
      resolved,
      ModuleSource::ResolvedWithError(
        Atom::from("./nonexistent"),
        ResolveError::NotFound("".to_string())
      )
    );
  }
}
