use oxc::allocator::Allocator;
use oxc::span::Span;
use oxc_semantic::{SymbolId, SymbolTable};
use std::fmt::Debug;
use std::hash::Hash;

#[derive(Clone)]
pub struct Symbol<'a> {
  pub symbol_id: SymbolId,
  pub name: &'a str,
  pub decl: Span,
}

impl<'a> Debug for Symbol<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "\"{}\"", self.name)
  }
}

impl<'a> Symbol<'a> {
  pub fn new(
    allocator: &'a Allocator,
    symbols: &SymbolTable,
    symbol_id: SymbolId,
    decl: Span,
  ) -> &'a Self {
    let name = allocator.alloc_str(symbols.get_name(symbol_id));
    allocator.alloc(Self {
      symbol_id,
      name,
      decl,
    })
  }
}

impl<'a> PartialEq for Symbol<'a> {
  fn eq(&self, other: &Self) -> bool {
    self.symbol_id == other.symbol_id
  }
}

impl<'a> Eq for Symbol<'a> {}

impl<'a> Hash for Symbol<'a> {
  fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
    self.symbol_id.hash(state);
  }
}
