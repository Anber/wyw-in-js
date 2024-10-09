mod generated;

use oxc::span::GetSpan;
use oxc::span::Span;
use shaker_macro::define;

pub enum Ancestor<'a> {
  Field(AnyNode<'a>, &'a str),
  ListItem(AnyNode<'a>, &'a str, usize, Option<Span>),
}

pub struct TraverseCtx<'a> {
  pub ancestors: Vec<Ancestor<'a>>,
}

impl<'a> TraverseCtx<'a> {
  pub fn parent(&self) -> Option<&Ancestor<'a>> {
    if self.ancestors.is_empty() {
      None
    } else {
      Some(&self.ancestors[self.ancestors.len() - 1])
    }
  }

  pub fn delimiter(&self) -> Option<Span> {
    if let Some(Ancestor::ListItem(_, _, _, Some(span))) = self.parent() {
      Some(*span)
    } else {
      None
    }
  }
}

#[derive(Default)]
pub enum EnterAction {
  Ignore,

  #[default]
  Continue,
}

define!();

pub fn walk<'a, Tr: TraverseHooks<'a>>(hooks: &mut Tr, program: &'a oxc::ast::ast::Program<'a>) {
  let mut ctx = TraverseCtx { ancestors: vec![] };
  let program_node = AnyNode::Program(program);
  walk_any(hooks, program_node, &mut ctx);
}
