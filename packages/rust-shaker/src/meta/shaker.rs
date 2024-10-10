use crate::meta::replacements::Replacements;
use oxc::allocator::CloneIn;
use oxc::ast::ast::*;
use oxc::span::{GetSpan, Span};
use oxc_traverse::TraverseCtx;
use shaker_macro::shaker_from_cfg;

pub struct Shaker<'a> {
  for_delete: Replacements,
  for_replace: Vec<(Span, Expression<'a>)>,
}

impl<'a> Shaker<'a> {
  pub fn new(for_delete: Vec<Span>) -> Self {
    Self {
      for_delete: Replacements::from_spans(for_delete),
      for_replace: vec![],
    }
  }

  fn is_for_delete(&self, span: Span) -> bool {
    self.for_delete.has(span)
  }

  fn mark_for_delete(&mut self, span: Span) {
    self.for_delete.add_deletion(span);
  }

  fn mark_for_replace(&mut self, span: Span, replacement: Expression<'a>) {
    self.for_replace.push((span, replacement));
  }

  fn replace_with_undefined(&mut self, span: Span, ctx: &TraverseCtx<'a>) {
    self.mark_for_replace(
      span,
      ctx.ast.expression_identifier_reference(span, "undefined"),
    );
  }

  fn get_replacement(&self, span: Span) -> Option<&Expression<'a>> {
    self
      .for_replace
      .iter()
      .find_map(|(s, expr)| if s == &span { Some(expr) } else { None })
  }
}

#[shaker_from_cfg]
impl<'a> oxc_traverse::Traverse<'a> for Shaker<'a> {
  fn exit_program(&mut self, node: &mut Program<'a>, ctx: &mut TraverseCtx<'a>) {
    node.body.retain(|stmt| !self.is_for_delete(stmt.span()));
  }

  fn exit_logical_expression(
    &mut self,
    node: &mut LogicalExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    match &node.operator {
      LogicalOperator::And => {
        if self.is_for_delete(node.left.span()) || self.is_for_delete(node.right.span()) {
          self.replace_with_undefined(node.span(), ctx);
        }
      }

      LogicalOperator::Or | LogicalOperator::Coalesce => {
        if self.is_for_delete(node.left.span()) && self.is_for_delete(node.right.span()) {
          self.replace_with_undefined(node.span(), ctx);
        } else if self.is_for_delete(node.left.span()) {
          self.mark_for_replace(node.span(), node.right.clone_in(ctx.ast.allocator));
        } else if self.is_for_delete(node.right.span()) {
          self.mark_for_replace(node.span(), node.left.clone_in(ctx.ast.allocator));
        }
      }
    }
  }

  fn exit_array_assignment_target(
    &mut self,
    node: &mut ArrayAssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    for el in node.elements.iter_mut() {
      if let Some(trg) = el {
        if self.is_for_delete(trg.span()) {
          *el = None;
        }
      }
    }

    if node.elements.iter().all(|el| el.is_none()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_object_assignment_target(
    &mut self,
    node: &mut ObjectAssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    node
      .properties
      .retain(|prop| !self.is_for_delete(prop.span()));

    if node.properties.is_empty() {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_sequence_expression(
    &mut self,
    node: &mut SequenceExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if node.expressions.is_empty() {
      self.mark_for_delete(node.span());
      return;
    }

    let last_expr = node.expressions.last_mut().unwrap();
    let last_expr_span = last_expr.span();
    if self.is_for_delete(last_expr_span) {
      *last_expr = ctx
        .ast
        .expression_identifier_reference(last_expr_span, "undefined");
    }

    node
      .expressions
      .retain(|expr| expr.span() == last_expr_span || !self.is_for_delete(expr.span()));
  }

  fn exit_variable_declaration(
    &mut self,
    node: &mut VariableDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    node
      .declarations
      .retain(|decl| !self.is_for_delete(decl.span()));

    if node.declarations.is_empty() {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_variable_declarator(
    &mut self,
    node: &mut VariableDeclarator<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if let Some(init) = &mut node.init {
      let init_span = init.span();
      if self.is_for_delete(init_span) {
        self.mark_for_delete(init_span);
      }

      if let Some(replacement) = self.get_replacement(init_span) {
        *init = replacement.clone_in(ctx.ast.allocator);
      }
    }
  }

  fn exit_debugger_statement(&mut self, node: &mut DebuggerStatement, _ctx: &mut TraverseCtx<'a>) {
    self.mark_for_delete(node.span());
  }

  fn exit_binding_pattern(&mut self, node: &mut BindingPattern<'a>, _ctx: &mut TraverseCtx<'a>) {
    match &mut node.kind {
      BindingPatternKind::ObjectPattern(obj) => {
        obj
          .properties
          .retain(|prop| !self.is_for_delete(prop.span()));

        if obj.properties.is_empty() {
          self.mark_for_delete(node.span());
        }
      }

      BindingPatternKind::ArrayPattern(arr) => {
        for elem in arr.elements.iter_mut() {
          if let Some(bp) = elem {
            if self.is_for_delete(bp.span()) {
              *elem = None;
            }
          }
        }

        if arr.elements.iter().all(|elem| elem.is_none()) {
          self.mark_for_delete(node.span());
        }
      }

      BindingPatternKind::BindingIdentifier(id) => {
        if self.is_for_delete(id.span) {
          self.mark_for_delete(node.span());
        }
      }

      BindingPatternKind::AssignmentPattern(assigment) => {
        if self.is_for_delete(assigment.left.span()) {
          self.mark_for_delete(node.span());
        }
      }
    }
  }

  fn exit_object_pattern(&mut self, node: &mut ObjectPattern<'a>, ctx: &mut TraverseCtx<'a>) {
    node
      .properties
      .retain(|prop| !self.is_for_delete(prop.span()));

    if node.properties.is_empty() {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_function(&mut self, node: &mut Function<'a>, _ctx: &mut TraverseCtx<'a>) {
    if let Some(body) = &mut node.body {
      if body.statements.is_empty() {
        node.params.items.clear();
        node.params.rest = None;
      }
    }
  }

  fn exit_function_body(&mut self, node: &mut FunctionBody<'a>, ctx: &mut TraverseCtx<'a>) {
    node
      .statements
      .retain(|stmt| !self.is_for_delete(stmt.span()));
  }

  fn exit_class_body(&mut self, node: &mut ClassBody<'a>, ctx: &mut TraverseCtx<'a>) {
    node
      .body
      .retain(|element| !self.is_for_delete(element.span()));
  }

  fn exit_export_named_declaration(
    &mut self,
    node: &mut ExportNamedDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if !node.specifiers.is_empty() {
      if node
        .specifiers
        .iter()
        .all(|specifier| self.is_for_delete(specifier.span()))
      {
        self.mark_for_delete(node.span());
      } else {
        node
          .specifiers
          .retain(|specifier| !self.is_for_delete(specifier.span()));
      }
    }
  }

  fn exit_statements(
    &mut self,
    node: &mut oxc::allocator::Vec<'a, Statement<'a>>,
    ctx: &mut TraverseCtx<'a>,
  ) {
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use indoc::indoc;
  use oxc::allocator::Allocator;
  use oxc::parser::{ParseOptions, Parser};
  use oxc::span::SourceType;
  use oxc_codegen::Codegen;
  use oxc_traverse::traverse_mut;
  use regex::Regex;
  use std::ops::Deref;
  use std::path::Path;

  fn extract_spans_for_deletion(source_text: &str) -> (String, Vec<Span>) {
    // Split the source text into lines
    // For each line, check if it contains only ^ and spaces
    // If it does, extract the span and add it to the list of spans for deletion
    // If it doesn't, add the line to the new source text
    let mut new_source_text = String::new();
    let mut spans_for_deletion = Vec::new();
    let mut pos = 0;
    let mut last_line_len = 0;

    let marker_line_re = Regex::new(r"[\s^]+$").unwrap();
    let marker_re = Regex::new(r"\^+").unwrap();

    for line in source_text.split('\n') {
      if marker_line_re.is_match(line) {
        for marker in marker_re.find_iter(line) {
          let start = pos - last_line_len + marker.start();
          let end = pos - last_line_len + marker.end();
          spans_for_deletion.push(Span::new(start as u32, end as u32));
        }
      } else {
        new_source_text.push_str(line);
        new_source_text.push('\n');
        last_line_len = line.len() + 1;
        pos += last_line_len;
      }
    }

    (new_source_text, spans_for_deletion)
  }

  fn run(source_text: &str) -> String {
    let allocator = Allocator::default();

    let path = Path::new("test.js");
    let source_type = SourceType::from_path(path).unwrap();

    let (source_text, for_delete) = extract_spans_for_deletion(source_text);

    let parser_ret = Parser::new(&allocator, &source_text, source_type)
      .with_options(ParseOptions {
        parse_regular_expression: true,
        ..ParseOptions::default()
      })
      .parse();

    assert!(parser_ret.errors.is_empty());

    let program = allocator.alloc(parser_ret.program);
    let mut shaker = Shaker::new(for_delete);

    let semantic_ret = oxc_semantic::SemanticBuilder::new(&source_text)
      .build_module_record(path, program)
      .with_check_syntax_error(true)
      .with_trivias(parser_ret.trivias)
      .build(program);

    let (symbols, scopes) = semantic_ret.semantic.into_symbol_table_and_scope_tree();

    traverse_mut(&mut shaker, &allocator, program, symbols, scopes);

    let codegen = Codegen::new()
      .with_source_text(&source_text)
      .with_options(oxc_codegen::CodegenOptions {
        ..oxc_codegen::CodegenOptions::default()
      })
      .build(program.deref());

    codegen.source_text.replace('\t', "  ")
  }

  #[test]
  fn test_named_exports() {
    assert_eq!(
      run(indoc! {r#"
        export { to_remove, to_keep };
                 ^^^^^^^^^
      "#}),
      indoc! {r#"
        export { to_keep };
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        export { to_remove };
                 ^^^^^^^^^
      "#}),
      indoc! {r#""#}
    );

    assert_eq!(
      run(indoc! {r#"
        export { to_remove_1, to_remove_2 };
                 ^^^^^^^^^^^  ^^^^^^^^^^^
      "#}),
      indoc! {r#""#}
    );
  }

  #[test]
  fn test_variable_declaration() {
    assert_eq!(
      run(indoc! {r#"
        const a = 42;
              ^
      "#}),
      indoc! {r#""#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = 42, b = 24;
              ^
      "#}),
      indoc! {r#"
        const b = 24;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = 42, b = 24;
                      ^
      "#}),
      indoc! {r#"
        const a = 42;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = 42, b = 24;
              ^       ^
      "#}),
      indoc! {r#""#}
    );

    assert_eq!(
      run(indoc! {r#"
        const { a: b } = { a: 42 }
                   ^
      "#}),
      indoc! {r#""#}
    );

    assert_eq!(
      run(indoc! {r#"
        const { a = 1, b } = {
                ^
          a: 42,
          b: 24
        };
      "#}),
      indoc! {r#"
        const { b } = {
          a: 42,
          b: 24
        };
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const [a, b] = [42, 24];
               ^
      "#}),
      indoc! {r#"
        const [, b] = [42, 24];
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const [a, b] = [42, 24];
               ^  ^
      "#}),
      indoc! {r#""#}
    );
  }

  #[test]
  fn test_conditional_expression() {
    assert_eq!(
      run(indoc! {r#"
        const a = to_remove ? 42 : 24;
                  ^^^^^^^^^
      "#}),
      indoc! {r#"
        const a = 24;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = to_remove ? 42 : 24;
                              ^^
      "#}),
      indoc! {r#"
        const a = to_remove ? undefined : 24;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = to_remove ? 42 : 24;
                                   ^^
      "#}),
      indoc! {r#"
        const a = to_remove ? 42 : undefined;
      "#}
    );
  }

  #[test]
  fn test_logical_expression() {
    assert_eq!(
      run(indoc! {r#"
        const a1 = b && c;
                   ^
        const a2 = b && c;
                        ^
        const a3 = b && c;
                   ^    ^
      "#}),
      indoc! {r#"
        const a1 = undefined;
        const a2 = undefined;
        const a3 = undefined;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a1 = b || c;
                   ^
        const a2 = b || c;
                        ^
        const a3 = b || c;
                   ^    ^
      "#}),
      indoc! {r#"
        const a1 = c;
        const a2 = b;
        const a3 = undefined;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a1 = b ?? c;
                   ^
        const a2 = b ?? c;
                        ^
        const a3 = b ?? c;
                   ^    ^
      "#}),
      indoc! {r#"
        const a1 = c;
        const a2 = b;
        const a3 = undefined;
      "#}
    );
  }

  #[test]
  fn test_class() {
    assert_eq!(
      run(indoc! {r#"
        const a = class { get method() { return; } };
                              ^^^^^^
      "#}),
      indoc! {r#"
        const a = class {};
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = class {
          get method_1() {
              ^^^^^^^^
            return;
          }
          get method_2() {
            return;
          }
        };
      "#}),
      indoc! {r#"
        const a = class {
          get method_2() {
            return;
          }
        };
      "#}
    );
  }

  #[test]
  fn test_function() {
    // assert_eq!(
    //   run(indoc! {r#"
    //     const a = function to_remove(param) {
    //                                  ^^^^^
    //       return;
    //     };
    //   "#}),
    //   indoc! {r#"
    //     const a = function to_remove(param) {
    //       return;
    //     };
    //   "#}
    // );

    assert_eq!(
      run(indoc! {r#"
        const a = function to_remove(param) {
          return;
          ^^^^^^^
        };
      "#}),
      indoc! {r#"
        const a = function to_remove() {};
      "#}
    );
  }

  #[test]
  fn test_sequence() {
    assert_eq!(
      run(indoc! {r#"
        const a = (1, 2, 3, b);
                            ^
      "#}),
      indoc! {r#"
        const a = (1, 2, 3, undefined);
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = (1, 2, b, 3);
                         ^
      "#}),
      indoc! {r#"
        const a = (1, 2, 3);
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = (b, c, d);
                   ^  ^  ^
      "#}),
      indoc! {r#"
        const a = (undefined);
      "#}
    );
  }

  #[test]
  fn test_assigment() {
    assert_eq!(
      run(indoc! {r#"
        a = 42;
        ^
      "#}),
      indoc! {r#""#}
    );

    assert_eq!(
      run(indoc! {r#"
        a = 42, b = 24;
        ^
      "#}),
      indoc! {r#"
        b = 24;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        a = 42, b = 24;
                ^
      "#}),
      indoc! {r#"
        a = 42, undefined;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        a = 42, b = 24;
        ^       ^
      "#}),
      indoc! {r#"
        undefined;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        ({ a: b } = { a: 42 })
              ^
      "#}),
      indoc! {r#""#}
    );

    assert_eq!(
      run(indoc! {r#"
        ({ a = 1, b } = {
           ^
          a: 42,
          b: 24
        });
      "#}),
      indoc! {r#"
        ({b} = {
          a: 42,
          b: 24
        });
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        [a, b] = [42, 24];
         ^
      "#}),
      indoc! {r#"
        [, b] = [42, 24];
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        [a, b] = [42, 24];
         ^  ^
      "#}),
      indoc! {r#""#}
    );
  }
}
