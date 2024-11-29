use oxc::span::Span;
use oxc_semantic::{SymbolId, SymbolTable};
use std::fmt::Debug;
use std::hash::Hash;

#[derive(Clone)]
pub struct Symbol {
  pub symbol_id: SymbolId,
  pub name: String,
  pub decl: Span,
}

impl Debug for Symbol {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "\"{}\"", self.name)
  }
}

impl Symbol {
  pub fn new(symbols: &SymbolTable, symbol_id: SymbolId, decl: Span) -> Self {
    Self {
      symbol_id,
      name: symbols.get_name(symbol_id).to_string(),
      decl,
    }
  }

  pub fn new_with_name(name: String, symbol_id: SymbolId, decl: Span) -> Self {
    Self {
      symbol_id,
      name,
      decl,
    }
  }
}

impl PartialEq for Symbol {
  fn eq(&self, other: &Self) -> bool {
    self.symbol_id == other.symbol_id
  }
}

impl Eq for Symbol {}

impl Hash for Symbol {
  fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
    self.symbol_id.hash(state);
  }
}
