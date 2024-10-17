use crate::symbol::Symbol;
use oxc::span::Atom;

#[derive(Clone, Debug, PartialEq)]
pub enum LocalIdentifier<'a> {
  Identifier(&'a Symbol),
  // Reference(ReferenceId),
  MemberExpression(&'a Symbol, Atom<'a>),
}
