pub mod local_identifier;
pub mod symbol;

use oxc_semantic::SymbolTable;

wyw_macros::define_traverse!();

#[derive(Debug)]
pub enum Ancestor<'a> {
  Field(AnyNode<'a>, &'a str),
  ListItem(AnyNode<'a>, &'a str, usize),
}

impl<'a> Ancestor<'a> {
  pub fn node(&self) -> &AnyNode<'a> {
    match self {
      Self::Field(node, _) => node,
      Self::ListItem(node, _, _) => node,
    }
  }
}

pub struct TraverseCtx<'a> {
  pub ancestors: Vec<Ancestor<'a>>,
  symbols: &'a SymbolTable,
}

impl<'a> TraverseCtx<'a> {
  pub fn parent(&self) -> Option<&Ancestor<'a>> {
    if self.ancestors.is_empty() {
      None
    } else {
      Some(&self.ancestors[self.ancestors.len() - 1])
    }
  }

  pub fn symbols(&self) -> &'a SymbolTable {
    self.symbols
  }
}

#[derive(Default)]
pub enum EnterAction {
  Ignore,

  #[default]
  Continue,
}

pub fn walk<'a, Tr: TraverseHooks<'a>>(
  hooks: &mut Tr,
  program: &'a oxc::ast::ast::Program<'a>,
  symbols: &'a SymbolTable,
) {
  let mut ctx = TraverseCtx {
    ancestors: vec![],
    symbols,
  };
  let program_node = AnyNode::Program(program);
  walk_any(hooks, program_node, &mut ctx);
}
