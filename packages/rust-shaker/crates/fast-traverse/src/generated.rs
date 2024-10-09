// Just for debug

use oxc::span::GetSpan;
use oxc::span::Span;

// pub enum Ancestor<'a> {
//   Field(AnyNode<'a>, &'a str),
//   ListItem(AnyNode<'a>, &'a str, usize, Option<Span>),
// }
//
// pub struct TraverseCtx<'a> {
//   pub ancestors: Vec<Ancestor<'a>>,
// }
#[derive(Default)]
pub enum EnterAction {
  Ignore,
  #[default]
  Continue,
}
