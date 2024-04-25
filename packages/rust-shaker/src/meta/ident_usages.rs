use crate::declaration_context::{DeclarationContext, PathPart};
use crate::meta::MetaCollector;
use oxc::span::{Atom, Span};
use oxc_traverse::{Ancestor, TraverseCtx};

#[derive(Debug)]
pub enum IdentUsage<'a> {
  MemberExpression(Span, Atom<'a>, Atom<'a>),
  ReexportAll(Span),
  Uncertain(Span),
  Unpacked(Span, Atom<'a>),
}

impl<'a> IdentUsage<'a> {
  pub fn prop(&self) -> Option<&Atom<'a>> {
    match self {
      Self::MemberExpression(_, _, prop) => Some(prop),
      Self::Unpacked(_, prop) => Some(prop),
      _ => None,
    }
  }

  pub fn span(&self) -> &Span {
    match self {
      Self::MemberExpression(span, _, _) => span,
      Self::ReexportAll(span) => span,
      Self::Uncertain(span) => span,
      Self::Unpacked(span, _) => span,
    }
  }
}

impl<'a> MetaCollector<'a> {
  fn add_usage(&mut self, usage: IdentUsage<'a>, ident_name: Atom<'a>) {
    let usages = self.identifier_usages.get_mut(&ident_name);
    match usages {
      None => {
        self.identifier_usages.insert(ident_name, vec![usage]);
      }

      Some(v) => {
        v.push(usage);
      }
    }
  }

  pub fn add_member_usage(&mut self, span: &Span, usage: Atom<'a>, ident_name: Atom<'a>) {
    let usage = IdentUsage::MemberExpression(*span, ident_name.clone(), usage);
    self.add_usage(usage, ident_name);
  }

  fn add_unpacked_usage(&mut self, span: &Span, usage: Atom<'a>, ident_name: Atom<'a>) {
    let usage = IdentUsage::Unpacked(*span, usage);
    self.add_usage(usage, ident_name);
  }

  fn mark_identifier_as_unresolvable(&mut self, span: &Span, ident_name: Atom<'a>) {
    let usage = IdentUsage::Uncertain(*span);
    self.add_usage(usage, ident_name);
  }

  fn mark_identifier_as_reexport(&mut self, span: &Span, ident_name: Atom<'a>) {
    let usage = IdentUsage::ReexportAll(*span);
    self.add_usage(usage, ident_name);
  }

  pub fn resolve_identifier_usage(
    &mut self,
    ctx: &mut TraverseCtx<'a>,
    span: &Span,
    ident_name: Atom<'a>,
  ) {
    if ctx.ancestors().any(|ancestor| ancestor.is_via_ts_type()) {
      return;
    }

    match ctx.parent() {
      Ancestor::StaticMemberExpressionObject(member_expr) => {
        self.add_member_usage(span, member_expr.property().name.clone(), ident_name);
      }

      Ancestor::ComputedMemberExpressionObject(_) => {
        self.mark_identifier_as_unresolvable(span, ident_name);
      }

      Ancestor::VariableDeclaratorInit(_node) => {
        let mut usages = vec![];
        if let DeclarationContext::List(list) = &self.declaration_context {
          if list.is_empty() {
            self.mark_identifier_as_unresolvable(span, ident_name);
            return;
          } else {
            for decl in list {
              if decl.from.is_empty() {
                self.mark_identifier_as_unresolvable(span, ident_name);
                return;
              }

              match &decl.from[0] {
                PathPart::Identifier(ident) => {
                  usages.push(ident.clone());
                }
                PathPart::Index(_) => {}
              }
            }
          }
        }

        for usage in usages {
          self.add_unpacked_usage(span, usage, ident_name.clone());
        }
      }

      Ancestor::CallExpressionArguments(call_expr) => {
        let callee = call_expr.callee();
        if self.object_is_member(callee, "keys", ctx) {
          self.mark_identifier_as_reexport(span, ident_name);
        } else {
          self.mark_identifier_as_unresolvable(span, ident_name);
        }
      }

      _ => {
        self.mark_identifier_as_unresolvable(span, ident_name);
      }
    }
  }
}
