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

#[cfg(test)]
mod tests {
  use super::*;
  use oxc::allocator::Allocator;
  use oxc::ast::ast::{BindingIdentifier, NumericLiteral};
  use oxc::parser::{ParseOptions, Parser};
  use oxc::span::SourceType;
  use oxc_semantic::SymbolTable;

  #[test]
  fn test_walk() {
    struct TraverseImpl {
      name: String,
      value: f64,
    }

    impl Default for TraverseImpl {
      fn default() -> Self {
        Self {
          name: "none".to_string(),
          value: 0.0,
        }
      }
    }

    impl<'a> TraverseHooks<'a> for TraverseImpl {
      fn enter_binding_identifier(
        &mut self,
        node: &'a BindingIdentifier<'a>,
        _: &mut TraverseCtx<'a>,
      ) -> EnterAction {
        self.name = node.name.to_string();
        EnterAction::Continue
      }

      fn enter_numeric_literal(
        &mut self,
        node: &'a NumericLiteral<'a>,
        _: &mut TraverseCtx<'a>,
      ) -> EnterAction {
        self.value = node.value;
        EnterAction::Continue
      }
    }

    let allocator = Allocator::default();
    let source_text = "export const foo = 42;";
    let source_type = SourceType::ts();

    let ret = Parser::new(&allocator, source_text, source_type)
      .with_options(ParseOptions {
        parse_regular_expression: true,
        ..ParseOptions::default()
      })
      .parse();
    let symbols = SymbolTable::default();
    let mut hooks = TraverseImpl::default();

    walk(&mut hooks, &ret.program, &symbols);

    assert_eq!(hooks.name, "foo");
    assert_eq!(hooks.value, 42.0);
  }
}
