use crate::meta::references::References;
use crate::meta::replacements::{ReplacementValue, Replacements};
use fast_traverse::{walk, AnyNode};
use fast_traverse::{TraverseCtx, TraverseHooks};
use itertools::Itertools;
use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::span::GetSpan;
use oxc_semantic::Semantic;

struct Shaker<'a> {
  changed: bool,
  references: References<'a>,
  replacements: Replacements,
  source_text: &'a str,
}

impl<'a> TraverseHooks<'a> for Shaker<'a> {
  fn should_skip(&self, node: &AnyNode) -> bool {
    self.is_for_change(node)
  }
  // fn exit_export_specifier(&mut self, node: &ExportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {
  //   if self.is_for_delete(node.local.span()) {
  //     self.mark_for_delete(node.span);
  //   }
  // }

  fn exit_program(&mut self, node: &'a Program<'a>, ctx: &mut TraverseCtx<'a>) {
    self.remove_delimiters(&node.body);
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

  fn exit_conditional_expression(
    &mut self,
    node: &'a ConditionalExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_change(&node.alternate)
      && (self.is_for_change(&node.consequent) || self.is_for_change(&node.test))
    {
      self.replace_with_undefined(&node.span);
      return;
    }

    if self.is_for_change(&node.consequent) {
      self.replace_with_undefined(&node.consequent.span());
    }

    if self.is_for_change(&node.alternate) {
      self.replace_with_undefined(&node.alternate.span());
    }

    if self.is_for_change(&node.test) {
      self.replace_with_another(&node.span(), &node.alternate);
    }
  }

  fn exit_assignment_expression(
    &mut self,
    node: &'a AssignmentExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_change(&node.right) {
      todo!()
    }

    if self.is_for_change(&node.left) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_array_assignment_target(
    &mut self,
    node: &ArrayAssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_vec_opt_for_delete(&node.elements) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_object_assignment_target(
    &mut self,
    node: &'a ObjectAssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_vec_for_delete(&node.properties) {
      self.mark_for_delete(node.span());
    } else {
      self.remove_delimiters(&node.properties);
    }
  }

  fn exit_assignment_target_property_identifier(
    &mut self,
    node: &'a AssignmentTargetPropertyIdentifier<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_change(&node.binding) {
      self.mark_for_delete(node.span)
    }
  }

  fn exit_assignment_target_property_property(
    &mut self,
    node: &'a AssignmentTargetPropertyProperty<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_change(&node.name) || self.is_for_change(&node.binding) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_sequence_expression(
    &mut self,
    node: &'a SequenceExpression<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if let Some(last_expr) = node.expressions.last() {
      if self.is_for_change(last_expr) {
        self.replace_with_undefined(last_expr);
      }
    }

    self.remove_delimiters(&node.expressions);
  }

  fn exit_parenthesized_expression(
    &mut self,
    node: &'a ParenthesizedExpression<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_change(&node.expression) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_variable_declaration(
    &mut self,
    node: &VariableDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_vec_for_delete(&node.declarations) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_variable_declarator(&mut self, node: &VariableDeclarator<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_for_change(&node.id) {
      self.mark_for_delete(node.span);
      if let Some(comma) = ctx.delimiter() {
        self.mark_for_delete(comma);
      }
    }
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

  fn exit_expression_statement(
    &mut self,
    node: &'a ExpressionStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_change(&node.expression) {
      self.mark_for_delete(node.span);
    }
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

  fn exit_assignment_pattern(
    &mut self,
    node: &'a AssignmentPattern<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_change(&node.right) {
      todo!()
    }

    if self.is_for_change(&node.left) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_object_pattern(&mut self, node: &ObjectPattern<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_vec_for_delete(&node.properties) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_binding_property(&mut self, node: &'a BindingProperty<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_for_change(&node.key) {
      self.mark_for_delete(node.span);
    }

    if self.is_for_change(&node.value) {
      self.mark_for_delete(node.span);
    }

    if self.is_for_change(node) {
      if let Some(comma) = ctx.delimiter() {
        self.mark_for_delete(comma);
      }
    }
  }

  fn exit_array_pattern(&mut self, node: &'a ArrayPattern<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_vec_opt_for_delete(&node.elements) {
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
    node: &'a ExportNamedDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if !node.specifiers.is_empty() && self.is_vec_for_delete(&node.specifiers) {
      self.mark_for_delete(node.span());
    }

    self.remove_delimiters(&node.specifiers);
  }

  fn exit_export_specifier(&mut self, node: &'a ExportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {}

  // fn exit_statements(
  //   &mut self,
  //   node: &oxc::allocator::Vec<'a, Statement<'a>>,
  //   ctx: &mut TraverseCtx<'a>,
  // ) {
  // }
}

impl<'a> Shaker<'a> {
  pub fn new(source_text: &'a str, references: References<'a>, for_delete: Vec<Span>) -> Self {
    Self {
      changed: false,
      references,
      replacements: Replacements::from_spans(for_delete),
      source_text,
    }
  }

  fn is_for_change(&self, node: &impl GetSpan) -> bool {
    self.replacements.has(node.span())
  }

  fn is_for_delete(&self, node: &impl GetSpan) -> bool {
    self
      .replacements
      .get(node.span())
      .is_some_and(|v| matches!(v.value, ReplacementValue::Del))
  }

  fn is_vec_for_delete(&self, nodes: impl IntoIterator<Item = &'a (impl GetSpan + 'a)>) -> bool {
    nodes.into_iter().all(|node| self.is_for_change(node))
  }

  fn is_vec_opt_for_delete(
    &self,
    nodes: impl IntoIterator<Item = &'a Option<(impl GetSpan + 'a)>>,
  ) -> bool {
    nodes
      .into_iter()
      .all(|el| !el.as_ref().is_some_and(|v| !self.is_for_change(v)))
  }

  fn mark_for_delete(&mut self, span: Span) {
    self.changed |= self.replacements.add_deletion(span);
  }

  fn remove_delimiters<TItem: GetSpan + 'a>(&mut self, nodes: impl IntoIterator<Item = &'a TItem>) {
    let iter = nodes.into_iter();
    let tuples = iter.tuple_windows();
    let mut last_pair: Option<(&TItem, &TItem)> = None;
    for (prev, next) in tuples {
      last_pair = Some((prev, next));
      if self.is_for_delete(prev) {
        self.mark_for_delete(Span::new(prev.span().end, next.span().start));
      }
    }

    if let Some((penult, last)) = last_pair {
      if self.is_for_delete(last) {
        self.mark_for_delete(Span::new(penult.span().end, last.span().start));
      }
    }
  }

  fn replace_with_undefined(&mut self, node: &impl GetSpan) {
    self.changed |= self
      .replacements
      .add_replacement(node.span(), ReplacementValue::Undefined);
  }

  fn replace_with_another(&mut self, node: &impl GetSpan, another: &impl GetSpan) {
    self.changed |= self
      .replacements
      .add_replacement(node.span(), ReplacementValue::Span(another.span()));
  }

  pub fn shake(&mut self, program: &'a Program<'a>) {
    self.changed = false;
    walk(self, program);

    // Remove all references to deleted nodes
    let mut cloned_references = self.references.clone();
    cloned_references.apply_replacements(&self.replacements);

    let mut has_changes = false;
    let mut dead_symbols = vec![];
    for (&symbol, references) in &cloned_references.map {
      if references.is_empty() {
        dead_symbols.push(symbol);
        has_changes = true;
      }
    }

    for dead_symbol in dead_symbols {
      self.mark_for_delete(dead_symbol.decl);
    }

    if self.changed {
      self.shake(program);
    }
  }
}

pub fn shake(
  program: &Program,
  for_delete: Vec<Span>,
  semantic: &Semantic,
  allocator: &Allocator,
) -> String {
  let references = References::from_semantic(semantic, allocator);
  let source_text = semantic.source_text();
  let mut shaker = Shaker::new(source_text, references, for_delete);

  shaker.shake(program);

  shaker.replacements.apply(source_text)
}

#[cfg(test)]
mod tests {
  use super::*;
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

    let semantic_ret = oxc_semantic::SemanticBuilder::new(&source_text)
      .build_module_record(path, program)
      .with_check_syntax_error(true)
      .with_trivias(parser_ret.trivias)
      .build(program);

    let res = shake(program, for_delete, &semantic_ret.semantic, &allocator);
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
        ({ b } = {
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
  fn test_unused_declaration() {
    assert_eq!(
      run(indoc! {r#"
        const a = 42;
        const b = 24;
        export { a, b };
                    ^
      "#}),
      indoc! {r#"
        const a = 42;
        export { a };
      "#}
    );
  }

  #[test]
  fn test_moved_reference() {
    assert_eq!(
      run(indoc! {r#"
        const a = 42;
        const b = 24;
        const c = localStorage.isDebug ? a : b;
                  ^^^^^^^^^^^^^^^^^^^^
        export { c };
      "#}),
      indoc! {r#"
        const b = 24;
        const c = b;
        export { c };
      "#}
    );
  }
}
