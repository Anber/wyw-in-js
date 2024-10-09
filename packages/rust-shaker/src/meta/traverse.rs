use crate::meta::spans::Spans;
use fast_traverse::{TraverseCtx, TraverseHooks};
use oxc::ast::ast::*;
use oxc::span::GetSpan;

struct Shaker<'a> {
  for_delete: Spans,
  for_replace: Vec<(Span, String)>,
  source_text: &'a String,
}

impl<'a> Shaker<'a> {
  pub fn new(source_text: &'a String, for_delete: Vec<Span>) -> Self {
    Self {
      for_delete: Spans::new(for_delete),
      for_replace: vec![],
      source_text,
    }
  }

  fn is_for_delete(&self, span: Span) -> bool {
    self.for_delete.has(span)
  }

  fn mark_for_delete(&mut self, span: Span) {
    self.for_delete.add(span);
  }

  fn mark_for_replace(&mut self, span: Span, replacement: Expression<'a>) {
    // self.for_replace.push((span, replacement));
  }

  fn replace_with_undefined(&mut self, span: Span, ctx: &TraverseCtx<'a>) {
    // self.mark_for_replace(
    //   span,
    //   ctx.ast.expression_identifier_reference(span, "undefined"),
    // );
  }
}

impl<'a> TraverseHooks<'a> for Shaker<'a> {
  // fn exit_export_specifier(&mut self, node: &ExportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {
  //   if self.is_for_delete(node.local.span()) {
  //     self.mark_for_delete(node.span);
  //   }
  // }

  fn exit_program(&mut self, node: &Program<'a>, ctx: &mut TraverseCtx<'a>) {
    // node.body.retain(|stmt| !self.is_for_delete(stmt.span()));
  }

  fn exit_logical_expression(&mut self, node: &LogicalExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    // match &node.operator {
    //   LogicalOperator::And => {
    //     if self.is_for_delete(node.left.span()) || self.is_for_delete(node.right.span()) {
    //       self.replace_with_undefined(node.span(), ctx);
    //     }
    //   }
    //
    //   LogicalOperator::Or | LogicalOperator::Coalesce => {
    //     if self.is_for_delete(node.left.span()) && self.is_for_delete(node.right.span()) {
    //       self.replace_with_undefined(node.span(), ctx);
    //     } else if self.is_for_delete(node.left.span()) {
    //       self.mark_for_replace(node.span(), node.right.clone_in(ctx.ast.allocator));
    //     } else if self.is_for_delete(node.right.span()) {
    //       self.mark_for_replace(node.span(), node.left.clone_in(ctx.ast.allocator));
    //     }
    //   }
    // }
  }

  fn exit_array_assignment_target(
    &mut self,
    node: &ArrayAssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    // for el in node.elements.iter_mut() {
    //   if let Some(trg) = el {
    //     if self.is_for_delete(trg.span()) {
    //       *el = None;
    //     }
    //   }
    // }

    if node.elements.iter().all(|el| el.is_none()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_object_assignment_target(
    &mut self,
    node: &ObjectAssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    // node
    //   .properties
    //   .retain(|prop| !self.is_for_delete(prop.span()));

    if node.properties.is_empty() {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_sequence_expression(&mut self, node: &SequenceExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    if node.expressions.is_empty() {
      self.mark_for_delete(node.span());
      return;
    }

    // let last_expr = node.expressions.last_mut().unwrap();
    // let last_expr_span = last_expr.span();
    // if self.is_for_delete(last_expr_span) {
    //   *last_expr = ctx
    //     .ast
    //     .expression_identifier_reference(last_expr_span, "undefined");
    // }
    //
    // node
    //   .expressions
    //   .retain(|expr| expr.span() == last_expr_span || !self.is_for_delete(expr.span()));
  }

  fn exit_variable_declaration(
    &mut self,
    node: &VariableDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    // node
    //   .declarations
    //   .retain(|decl| !self.is_for_delete(decl.span()));

    if node.declarations.is_empty() {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_variable_declarator(&mut self, node: &VariableDeclarator<'a>, ctx: &mut TraverseCtx<'a>) {
    // if let Some(init) = &mut node.init {
    //   let init_span = init.span();
    //   if self.is_for_delete(init_span) {
    //     self.mark_for_delete(init_span);
    //   }
    //
    //   if let Some(replacement) = self.get_replacement(init_span) {
    //     *init = replacement.clone_in(ctx.ast.allocator);
    //   }
    // }
  }

  fn exit_debugger_statement(&mut self, node: &DebuggerStatement, _ctx: &mut TraverseCtx<'a>) {
    self.mark_for_delete(node.span());
  }

  fn exit_binding_pattern(&mut self, node: &BindingPattern<'a>, _ctx: &mut TraverseCtx<'a>) {
    // match &mut node.kind {
    //   BindingPatternKind::ObjectPattern(obj) => {
    //     obj
    //       .properties
    //       .retain(|prop| !self.is_for_delete(prop.span()));
    //
    //     if obj.properties.is_empty() {
    //       self.mark_for_delete(node.span());
    //     }
    //   }
    //
    //   BindingPatternKind::ArrayPattern(arr) => {
    //     for elem in arr.elements.iter_mut() {
    //       if let Some(bp) = elem {
    //         if self.is_for_delete(bp.span()) {
    //           *elem = None;
    //         }
    //       }
    //     }
    //
    //     if arr.elements.iter().all(|elem| elem.is_none()) {
    //       self.mark_for_delete(node.span());
    //     }
    //   }
    //
    //   BindingPatternKind::BindingIdentifier(id) => {
    //     if self.is_for_delete(id.span) {
    //       self.mark_for_delete(node.span());
    //     }
    //   }
    //
    //   BindingPatternKind::AssignmentPattern(assigment) => {
    //     if self.is_for_delete(assigment.left.span()) {
    //       self.mark_for_delete(node.span());
    //     }
    //   }
    // }
  }

  fn exit_object_pattern(&mut self, node: &ObjectPattern<'a>, ctx: &mut TraverseCtx<'a>) {
    // node
    //   .properties
    //   .retain(|prop| !self.is_for_delete(prop.span()));

    if node.properties.is_empty() {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_function(&mut self, node: &Function<'a>, _ctx: &mut TraverseCtx<'a>) {
    // if let Some(body) = &mut node.body {
    //   if body.statements.is_empty() {
    //     node.params.items.clear();
    //     node.params.rest = None;
    //   }
    // }
  }

  fn exit_function_body(&mut self, node: &FunctionBody<'a>, ctx: &mut TraverseCtx<'a>) {
    // node
    //   .statements
    //   .retain(|stmt| !self.is_for_delete(stmt.span()));
  }

  fn exit_class_body(&mut self, node: &ClassBody<'a>, ctx: &mut TraverseCtx<'a>) {
    // node
    //   .body
    //   .retain(|element| !self.is_for_delete(element.span()));
  }

  fn exit_export_named_declaration(
    &mut self,
    node: &ExportNamedDeclaration<'a>,
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
        // node
        //   .specifiers
        //   .retain(|specifier| !self.is_for_delete(specifier.span()));
      }
    }
  }

  fn exit_export_specifier(&mut self, node: &'a ExportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_for_delete(node.span) {
      if let Some(comma) = ctx.delimiter() {
        self.mark_for_delete(comma);
      }
    }
  }

  // fn exit_statements(
  //   &mut self,
  //   node: &oxc::allocator::Vec<'a, Statement<'a>>,
  //   ctx: &mut TraverseCtx<'a>,
  // ) {
  // }
}

// #[traverse]
// impl<'a> Shaker {
//   pub fn visit(&mut self, program: &Program<'a>) {
//     let mut ctx = TraverseCtx { ancestors: vec![] };
//
//     self.visit_program(program, &mut ctx);
//   }
//
//   fn visit_program(&mut self, node: &'a Program<'a>, ctx: &mut TraverseCtx<'a>) {
//     ctx.ancestors.push(AstKind::Program(node));
//
//     self.enter_program(node, ctx);
//     // if let EnterAction::Ignore = self.enter_program(node, ctx) {
//     // } else {
//     //   // node.body
//     // }
//
//     self.exit_program(node, ctx);
//
//     ctx.ancestors.pop();
//   }
// }

#[cfg(test)]
mod tests {
  use super::*;
  use fast_traverse::walk;
  use indoc::indoc;
  use itertools::Itertools;
  use oxc::allocator::Allocator;
  use oxc::parser::{ParseOptions, Parser};
  use oxc::span::SourceType;
  use regex::Regex;
  use std::path::Path;

  fn extract_spans_for_deletion(source_text: &str) -> (String, Vec<Span>) {
    // Split the source text into lines
    // For each line, check if it contains only ^ and spaces
    // If it does, extract the span and add it to the list of spans for deletion
    // If it doesn't, add the line to the new source text
    let mut lines = vec![];
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
        lines.push(line);
        last_line_len = line.len() + 1;
        pos += last_line_len;
      }
    }

    (lines.iter().join("\n"), spans_for_deletion)
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
    let mut shaker = Shaker::new(&source_text, for_delete);

    let semantic_ret = oxc_semantic::SemanticBuilder::new(&source_text)
      .build_module_record(path, program)
      .with_check_syntax_error(true)
      .with_trivias(parser_ret.trivias)
      .build(program);

    let (symbols, scopes) = semantic_ret.semantic.into_symbol_table_and_scope_tree();

    walk(&mut shaker, &program);

    let mut chunks = vec![];
    let mut last_pos: usize = 0;
    for span in shaker.for_delete.list {
      chunks.push(source_text[last_pos..(span.start as usize)].to_string());
      last_pos = span.end as usize;
    }

    chunks.push(source_text[last_pos..].to_string());

    let res = chunks.join("");
    if res == "\n" {
      "".to_string()
    } else {
      res
    }
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
        export { a, b, c };
                    ^
      "#}),
      indoc! {r#"
        export { a, c };
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        export { a, b, c };
                 ^     ^
      "#}),
      indoc! {r#"
        export { b };
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
}
