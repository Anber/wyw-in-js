use crate::meta::import::Import;
use crate::meta::local_identifier::LocalIdentifier;
use crate::meta::MetaCollector;
use oxc::ast::ast::{CallExpression, Expression};
use oxc::span::Span;
use oxc_traverse::ancestor::ClassWithoutBody;
use oxc_traverse::{Ancestor, TraverseCtx};

fn get_callee<'a>(p: &'a CallExpression<'a>) -> &'a Expression<'a> {
  match &p.callee {
    Expression::SequenceExpression(sequence) if sequence.expressions.len() == 2 => {
      if let Expression::NumericLiteral(value) = &sequence.expressions[0] {
        if value.raw == "0" {
          return &sequence.expressions[1];
        }
      }
    }
    _ => {}
  }

  &p.callee
}

impl<'a> MetaCollector<'a> {
  fn mark_as_unnecessary(&mut self, span: Span) {
    self.unnecessary_code.push(span);
  }

  fn is_jsxruntime(&self, expr: &CallExpression, ctx: &TraverseCtx<'a>) -> bool {
    let jsxruntime_source = "react/jsx-runtime";

    let runtime_imports = self.meta.imports.find_all_by_source(jsxruntime_source);
    if runtime_imports.is_empty() {
      return false;
    }

    let callee = get_callee(expr);
    if let Expression::Identifier(ident) = callee {
      let ref_id = self.get_symbol_for_ref(ident, ctx);
      if ref_id.is_none() {
        return false;
      }

      let ref_id = ref_id.unwrap();

      // FIXME: scope should be checked
      let jsx_runtime = runtime_imports.iter().find(|i| match i {
        Import::Default {
          local: LocalIdentifier::Identifier(local),
          ..
        } => local == &ref_id,
        Import::Named {
          local: LocalIdentifier::Identifier(local),
          ..
        } => local == &ref_id,
        Import::Namespace { local, .. } => local == &ref_id,
        _ => false,
      });

      return jsx_runtime.is_some();
    }

    false
  }

  fn is_unnecessary_react_call(&self, expr: &CallExpression, ctx: &TraverseCtx<'a>) -> bool {
    self.is_jsxruntime(expr, ctx)
  }

  fn mark_jsx_class_component_as_unnecessary(&mut self, node: &ClassWithoutBody) {
    let span = node.span();
    self.mark_as_unnecessary(*span);

    let replacement = match node.id() {
      Some(id) => {
        // Named class component
        let name = &id.name;
        self.alloc_atom(format!("function {name} {{ return null; }}"))
      }
      None => {
        // Anonymous class component
        self.alloc_atom("function() { return null; }".to_string())
      }
    };

    self.meta.evaltime_replacements.push((*span, replacement));
  }

  // FIXME: remove after debugging
  fn tmp_is_markup(&self, ctx: &TraverseCtx<'a>) -> bool {
    let has_declarator = ctx
      .ancestors()
      .any(|ancestor| matches!(ancestor, Ancestor::VariableDeclarationDeclarations(_)));

    let has_object_prop_value = ctx
      .ancestors()
      .any(|ancestor| matches!(ancestor, Ancestor::ObjectPropertyValue(_)));

    let offset = if let Ancestor::ParenthesizedExpressionExpression(_) = ctx.parent() {
      1
    } else {
      0
    };

    if has_declarator && has_object_prop_value {
      return true;
    }

    matches!(
      (
        ctx.ancestry.ancestor(offset),
        ctx.ancestry.ancestor(offset + 1),
        ctx.ancestry.ancestor(offset + 2),
      ),
      (
        Ancestor::VariableDeclaratorInit(_),
        Ancestor::VariableDeclarationDeclarations(_),
        Ancestor::ProgramBody(_),
      )
    )
  }

  pub fn mark_react_component_as_unnecessary(&mut self, ctx: &TraverseCtx<'a>, call_span: Span) {
    if self.is_marked_as_unnecessary(&call_span) {
      // Already marked as unnecessary
      return;
    }

    let fn_def = ctx.ancestors().position(|ancestor| {
      matches!(
        ancestor,
        Ancestor::MethodDefinitionValue(_)
          | Ancestor::ArrowFunctionExpressionBody(_)
          | Ancestor::FunctionBody(_)
      )
    });

    if fn_def.is_none() {
      if !self.tmp_is_markup(ctx) {
        dbg!("No body found");
      }

      self.mark_as_unnecessary(call_span);
      self
        .meta
        .evaltime_replacements
        .push((call_span, self.alloc_atom("null".to_string())));
      return;
    }

    let body = ctx.ancestors().nth(fn_def.unwrap()).unwrap();

    match body {
      Ancestor::ArrowFunctionExpressionBody(expr) => {
        self.mark_as_unnecessary(*expr.span());
        self
          .meta
          .evaltime_replacements
          .push((*expr.span(), self.alloc_atom("() => null".to_string())));
      }

      Ancestor::FunctionBody(expr) => {
        self.mark_as_unnecessary(*expr.span());

        let id = expr.id();
        let replacement = match id {
          Some(id) => {
            let name = &id.name;
            self.alloc_atom(format!("function {name}() {{ return null; }}"))
          }
          None => self.alloc_atom("function() { return null; }".to_string()),
        };

        self
          .meta
          .evaltime_replacements
          .push((*expr.span(), replacement));
      }

      Ancestor::MethodDefinitionValue(method) => {
        if method.key().is_specific_id("render") {
          let class = ctx
            .ancestors()
            .find(|ancestor| matches!(ancestor, Ancestor::ClassBody(_)))
            .expect("Method definition without a class");

          if let Ancestor::ClassBody(body) = class {
            self.mark_jsx_class_component_as_unnecessary(&body);
          }

          return;
        }
      }
      _ => {
        dbg!(body);
      }
    }

    if let Ancestor::FunctionBody(body) = body {
      self.mark_as_unnecessary(*body.span());
    }
  }

  pub fn is_marked_as_unnecessary(&self, span: &Span) -> bool {
    self.unnecessary_code.iter().any(|unnecessary_span| {
      unnecessary_span.start <= span.start && span.end <= unnecessary_span.end
    })
  }

  pub fn necessity_check_call(&mut self, expr: &CallExpression<'a>, ctx: &TraverseCtx<'a>) {
    let span = expr.span;
    if self.is_marked_as_unnecessary(&span) {
      // Already marked as unnecessary
      return;
    }

    if self.is_unnecessary_react_call(&expr, ctx) {
      self.mark_react_component_as_unnecessary(ctx, span);
    }
  }
}
