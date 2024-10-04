use crate::meta::local_identifier::LocalIdentifier;
use crate::meta::symbol::Symbol;
use oxc::ast::ast::*;
use oxc::span::{Atom, GetSpan, Span};
use oxc_traverse::{Ancestor, TraverseCtx};
use std::borrow::Cow;
use std::fmt::Debug;
use std::path::Path;

#[derive(Debug)]
pub enum ConstValue<'a> {
  BigInt(Span, Atom<'a>),
  Boolean(Span, bool),
  Null(Span),
  Number(Span, f64),
  String(Span, Atom<'a>),
  Undefined(Span),
}

pub enum ExpressionValue<'a> {
  ConstValue(ConstValue<'a>),
  Function(Span),
  Ident(Span, Atom<'a>),
  Source(Span),
  TemplateValue {
    cooked: Option<Atom<'a>>,
    raw: Atom<'a>,
    span: Span,
  },
}

impl<'a> Debug for ExpressionValue<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      ExpressionValue::ConstValue(value) => write!(f, "{:?}", value),
      ExpressionValue::Function(span) => write!(f, "Function({:?})", span),
      ExpressionValue::Ident(span, ident) => {
        write!(f, "Ident({:?}..{:?}, {:?})", span.start, span.end, ident)
      }
      ExpressionValue::Source(span) => write!(f, "Source({:?}..{:?})", span.start, span.end),
      ExpressionValue::TemplateValue { span, raw, .. } => {
        write!(
          f,
          "TemplateValue({:?}..{:?}, {:?})",
          span.start, span.end, raw
        )
      }
    }
  }
}

pub enum Param<'a> {
  Callee(Span, LocalIdentifier<'a>),
  Call(Span, Vec<Span>),
  Member(Span, Atom<'a>),
  Template(Span, Vec<ExpressionValue<'a>>),
}

impl<'a> Debug for Param<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Param::Callee(span, ident) => {
        write!(f, "Callee({:?}..{:?}, {:?})", span.start, span.end, ident)
      }
      Param::Call(span, args) => write!(f, "Call({:?}..{:?}, {:?}))", span.start, span.end, args),
      Param::Member(span, prop) => {
        write!(f, "Member({:?}..{:?}, {:?}))", span.start, span.end, prop)
      }
      Param::Template(span, exprs) => write!(
        f,
        "Template({:?}..{:?}, {:?}))",
        span.start, span.end, exprs
      ),
    }
  }
}

pub struct ProcessorParams<'a> {
  pub idx: usize,
  pub display_name: Cow<'a, str>,
  pub params: Vec<Param<'a>>,
}

impl<'a> Debug for ProcessorParams<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ProcessorParams")
      .field("idx", &self.idx)
      .field("display_name", &self.display_name)
      .field("params", &self.params)
      .finish()
  }
}

fn find_display_name<'a, 't>(
  decl_node: Option<Ancestor<'a, 't>>,
  declaring_symbol: Option<Symbol<'a>>,
  idx: usize,
  file_name: &'a Path,
) -> Cow<'a, str> {
  let mut display_name = None;

  match decl_node {
    Some(Ancestor::ObjectPropertyValue(obj)) => {
      display_name = obj.key().name();
    }

    Some(Ancestor::VariableDeclaratorInit(_)) => {
      if declaring_symbol.is_some() {
        display_name = Some(Cow::Borrowed(declaring_symbol.unwrap().name));
      }
    }

    Some(Ancestor::JSXAttributeValue(attr)) => {
      display_name = Some(Cow::Borrowed(attr.name().get_identifier().name.as_str()));
    }

    _ => {}
  }

  if display_name.is_none() {
    let mut name = file_name.file_stem().unwrap().to_str().unwrap_or("unknown");
    if name == "index" {
      name = file_name
        .parent()
        .map(|p| p.file_stem().unwrap().to_str().unwrap_or("unknown"))
        .unwrap()
    }

    display_name = Some(Cow::Owned(format!("{}{}", name, idx)));
  }

  display_name.expect("Couldn't determine a name for the component. Ensure that it's either:\n- Assigned to a variable\n- Is an object property\n- Is a prop in a JSX element\n")
}

impl<'a> ProcessorParams<'a> {
  fn new(idx: usize, display_name: Cow<'a, str>) -> Self {
    Self {
      idx,
      display_name,
      params: Vec::new(),
    }
  }

  fn find_display_name(
    ctx: &TraverseCtx<'a>,
    declaring_symbol: Option<Symbol<'a>>,
    idx: usize,
    file_name: &'a Path,
  ) -> Cow<'a, str> {
    let decl_node = ctx.ancestors().find(|n| {
      matches!(
        n,
        Ancestor::ObjectPropertyValue(_)
          | Ancestor::VariableDeclaratorInit(_)
          | Ancestor::JSXAttributeValue(_)
      )
    });

    find_display_name(decl_node, declaring_symbol, idx, file_name)
  }

  pub fn is_empty(&self) -> bool {
    self.params.is_empty()
      || self.params.len() == 1 && matches!(self.params[0], Param::Callee(_, _))
  }

  pub fn from_ident(
    ctx: &TraverseCtx<'a>,
    span: &Span,
    symbol_id: &'a Symbol<'a>,
    declaring_symbol: Option<Symbol<'a>>,
    idx: usize,
    file_name: &'a Path,
  ) -> (Span, oxc::allocator::Box<'a, Self>) {
    let mut result = ctx.alloc(Self::new(
      idx,
      Self::find_display_name(ctx, declaring_symbol, idx, file_name),
    ));
    let mut span = span;
    result
      .params
      .push(Param::Callee(*span, LocalIdentifier::Identifier(symbol_id)));

    for next in ctx.ancestors() {
      match &next {
        Ancestor::CallExpressionCallee(expr) => {
          span = expr.span();
          result.params.push(Param::Call(*span, Vec::new()));
        }
        Ancestor::StaticMemberExpressionObject(expr) => {
          span = expr.span();
          result
            .params
            .push(Param::Member(*span, expr.property().name.clone()));
        }
        Ancestor::TaggedTemplateExpressionTag(expr) => {
          let mut expressions = Vec::new();
          let literal = expr.quasi();
          // Let's iterate over the quasis and expressions.
          for i in 0..literal.quasis.len() {
            let quasi = &literal.quasis[i];
            expressions.push(ExpressionValue::TemplateValue {
              span: quasi.span,
              raw: quasi.value.raw.clone(),
              cooked: quasi.value.cooked.clone(),
            });

            if i >= literal.expressions.len() {
              continue;
            }

            let expression = &literal.expressions[i];
            let expr = match expression {
              Expression::Identifier(ident) => {
                if ident.name == "undefined" {
                  ExpressionValue::ConstValue(ConstValue::Undefined(ident.span))
                } else {
                  ExpressionValue::Ident(ident.span, ident.name.clone())
                }
              }
              Expression::ArrowFunctionExpression(fn_expr) => {
                ExpressionValue::Function(fn_expr.span())
              }
              Expression::FunctionExpression(fn_expr) => ExpressionValue::Function(fn_expr.span()),
              Expression::StringLiteral(literal) => ExpressionValue::ConstValue(
                ConstValue::String(literal.span(), literal.value.clone()),
              ),
              Expression::NumericLiteral(literal) => {
                ExpressionValue::ConstValue(ConstValue::Number(literal.span(), literal.value))
              }
              Expression::BigIntLiteral(literal) => {
                ExpressionValue::ConstValue(ConstValue::BigInt(literal.span(), literal.raw.clone()))
              }
              Expression::BooleanLiteral(literal) => {
                ExpressionValue::ConstValue(ConstValue::Boolean(literal.span(), literal.value))
              }
              Expression::NullLiteral(literal) => {
                ExpressionValue::ConstValue(ConstValue::Null(literal.span()))
              }
              _ => ExpressionValue::Source(expression.span()),
            };

            expressions.push(expr);
          }

          span = expr.span();
          result.params.push(Param::Template(*span, expressions));
        }
        _ => {
          return (*span, result);
        }
      }
    }

    (*span, result)
  }
}

pub type ListOfProcessorParams<'a> = Vec<(Span, oxc::allocator::Box<'a, ProcessorParams<'a>>)>;

#[cfg(test)]
mod tests {
  use super::*;
  use crate::declaration_context::DeclarationContext;
  use oxc::allocator::Allocator;
  use oxc::parser::{ParseOptions, Parser};
  use oxc_traverse::{traverse_mut, TraverseCtx};
  use std::path::Path;

  struct TestVisitor<'a> {
    pub allocator: &'a Allocator,
    pub declaration_context: DeclarationContext<'a>,
    pub display_name: Option<Cow<'a, str>>,
    pub file_name: &'a Path,
  }

  impl<'a> oxc_traverse::Traverse<'a> for TestVisitor<'a> {
    fn enter_tagged_template_expression(
      &mut self,
      node: &mut TaggedTemplateExpression<'a>,
      ctx: &mut TraverseCtx<'a>,
    ) {
      self.display_name = Some(ProcessorParams::find_display_name(
        ctx,
        self.declaration_context.get_declaring_symbol(),
        0,
        self.file_name,
      ));
    }

    fn enter_variable_declarator(
      &mut self,
      node: &mut VariableDeclarator<'a>,
      ctx: &mut TraverseCtx<'a>,
    ) {
      self.declaration_context = DeclarationContext::from(self.allocator, ctx.symbols(), node);
    }

    fn exit_variable_declarator(
      &mut self,
      _node: &mut VariableDeclarator<'a>,
      _ctx: &mut TraverseCtx<'a>,
    ) {
      self.declaration_context = DeclarationContext::None;
    }
  }

  fn get_display_name(source_text: &str, path: &str) -> String {
    let allocator = Allocator::default();

    let path = Path::new(path);
    let source_type = SourceType::from_path(path).unwrap();

    let parser_ret = Parser::new(&allocator, &source_text, source_type)
      .with_options(ParseOptions {
        parse_regular_expression: true,
        ..ParseOptions::default()
      })
      .parse();

    let program = allocator.alloc(parser_ret.program);
    let mut visitor = TestVisitor {
      allocator: &allocator,
      declaration_context: DeclarationContext::None,
      display_name: None,
      file_name: path,
    };

    let semantic_ret = oxc_semantic::SemanticBuilder::new(&source_text)
      .build_module_record(path, program)
      .with_check_syntax_error(true)
      .with_trivias(parser_ret.trivias)
      .build(program);

    let (symbols, scopes) = semantic_ret.semantic.into_symbol_table_and_scope_tree();

    traverse_mut(&mut visitor, &allocator, program, symbols, scopes);

    visitor.display_name.expect("Unresolved").to_string()
  }

  #[test]
  fn test_object_property() {
    assert_eq!(
      get_display_name("const obj = { test: css`` };", "/some/lib/test.js"),
      "test"
    );
  }

  #[test]
  fn test_variable_declarator() {
    assert_eq!(
      get_display_name("const test = css``;", "/some/lib/test.js"),
      "test"
    );
  }

  #[test]
  fn test_jsx_attribute() {
    assert_eq!(
      get_display_name("<Component test={css``} />", "/some/lib/test.js"),
      "test"
    );
  }

  #[test]
  fn test_from_filename() {
    assert_eq!(get_display_name("css``;", "/some/lib/test.js"), "test0");
  }

  #[test]
  fn test_from_filename_index() {
    assert_eq!(get_display_name("css``;", "/some/lib/index.js"), "lib0");
  }
}
