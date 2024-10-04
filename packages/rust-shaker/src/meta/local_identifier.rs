use crate::meta::symbol::Symbol;
use oxc::span::Atom;

#[derive(Clone, Debug, PartialEq)]
pub enum LocalIdentifier<'a> {
  Identifier(&'a Symbol<'a>),
  // Reference(ReferenceId),
  MemberExpression(&'a Symbol<'a>, Atom<'a>),
}
