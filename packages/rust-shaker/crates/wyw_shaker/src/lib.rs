use crate::default_resolver::create_resolver;
use crate::meta::Meta;
use crate::references::References;
use crate::replacements::Replacements;
use fast_traverse::local_identifier::LocalIdentifier;
use fast_traverse::{walk, Ancestor, AnyNode, EnterAction, TraverseCtx, TraverseHooks};
use itertools::Itertools;
use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::parser::{ParseOptions, Parser};
use oxc::span::GetSpan;
use oxc_semantic::{Semantic, SymbolTable};
use std::path::Path;
use wyw_processor::replacement_value::ReplacementValue;

pub mod declaration_context;
pub mod default_resolver;
pub mod export;
pub mod ident_usages;
pub mod import;
pub mod meta;
pub mod references;
pub mod replacements;

#[derive(Default)]
pub struct ShakerOptions {
  pub remove_jsx_and_hooks: bool,
}

struct Shaker<'a> {
  changed: bool,
  meta: &'a Meta<'a>,
  options: ShakerOptions,
  references: References<'a>,
  replacements: Replacements,
}

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

impl<'a> Shaker<'a> {
  fn is_jsxruntime(&self, expr: &CallExpression, _ctx: &TraverseCtx<'a>) -> bool {
    let jsxruntime_source = "react/jsx-runtime";

    let runtime_imports = self.meta.imports.find_all_by_source(jsxruntime_source);

    let callee = get_callee(expr);
    if let Expression::Identifier(ident) = callee {
      // FIXME: scope should be checked
      return runtime_imports
        .iter()
        .filter_map(|i| match i.local() {
          Some(LocalIdentifier::Identifier(local)) => Some(local),
          _ => None,
        })
        .any(|local| local.name == ident.name.as_str());
    }

    false
  }

  fn is_unnecessary_react_call(&self, expr: &CallExpression, ctx: &TraverseCtx<'a>) -> bool {
    self.is_jsxruntime(expr, ctx)
  }

  fn mark_jsx_class_component_as_unnecessary(&mut self, node: &Class) {
    match &node.id {
      Some(id) => {
        // Named class component
        let name = &id.name;
        // FIXME: fix references
        self.replace_with_text(
          node,
          format!("function {name}() {{ return null; }}").as_str(),
        );
      }
      None => {
        // Anonymous class component
        self.replace_with_text(node, "function() { return null; }");
      }
    };
  }

  pub fn mark_react_component_as_unnecessary(&mut self, ctx: &TraverseCtx<'a>, call_span: Span) {
    if !self.options.remove_jsx_and_hooks {
      return;
    }

    if self.is_span_for_change(call_span) {
      // Already marked as unnecessary
      return;
    }

    let mut ancestors: Vec<&Ancestor> = ctx
      .ancestors
      .iter()
      .rev()
      .skip_while(|ancestor| {
        !matches!(
          ancestor,
          Ancestor::Field(AnyNode::MethodDefinition(_), "value")
            | Ancestor::Field(AnyNode::ArrowFunctionExpression(_), "body")
            | Ancestor::Field(AnyNode::Function(_), "body")
        )
      })
      .collect();

    if ancestors.is_empty() {
      self.replace_with_text(&call_span, "null");
      return;
    }

    if matches!(
      ancestors.get(1),
      Some(Ancestor::Field(AnyNode::MethodDefinition(_), "value"))
    ) {
      ancestors = ancestors[1..].to_vec();
    }

    let fn_def = ancestors.first().unwrap();

    match fn_def {
      Ancestor::Field(AnyNode::ArrowFunctionExpression(expr), "body") => {
        self.replace_with_text(&expr.span, "() => null");
      }

      Ancestor::Field(AnyNode::Function(expr), "body") => {
        if let Some(body) = &expr.body {
          self.replace_with_text(&body.span, "{ return null; }");
        }
      }

      Ancestor::Field(AnyNode::MethodDefinition(method), "value") => {
        if method.key.is_specific_id("render") {
          let class = ctx
            .ancestors
            .iter()
            .rfind(|ancestor| matches!(ancestor, Ancestor::Field(AnyNode::Class(_), "body")))
            .expect("Method definition without a class");

          if let Ancestor::Field(AnyNode::Class(cls), "body") = class {
            self.mark_jsx_class_component_as_unnecessary(cls);
          }
        }
      }
      _ => {
        dbg!(fn_def);
      }
    }
  }

  pub fn necessity_check_call(&mut self, expr: &CallExpression<'a>, ctx: &TraverseCtx<'a>) {
    let span = expr.span;
    if self.is_span_for_change(span) {
      // Already marked as unnecessary
      return;
    }

    if self.is_unnecessary_react_call(&expr, ctx) {
      self.mark_react_component_as_unnecessary(ctx, span);
    }
  }
}

impl<'a> TraverseHooks<'a> for Shaker<'a> {
  fn should_skip(&self, node: &AnyNode) -> bool {
    self.is_for_change(node)
  }

  fn exit_program(&mut self, node: &'a Program<'a>, _ctx: &mut TraverseCtx<'a>) {
    self.remove_delimiters(&node.body);
  }

  fn exit_logical_expression(&mut self, node: &LogicalExpression<'a>, _ctx: &mut TraverseCtx<'a>) {
    match &node.operator {
      LogicalOperator::And => {
        if self.is_for_delete(&node.left) || self.is_for_delete(&node.right) {
          self.replace_with_undefined(node);
        }
      }

      LogicalOperator::Or | LogicalOperator::Coalesce => {
        if self.is_for_delete(&node.left) && self.is_for_delete(&node.right) {
          self.replace_with_undefined(node);
        } else if self.is_for_delete(&node.left) {
          self.replace_with_another(node, &node.right);
        } else if self.is_for_delete(&node.right) {
          self.replace_with_another(node, &node.left);
        }
      }
    }
  }

  fn exit_conditional_expression(
    &mut self,
    node: &'a ConditionalExpression<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(&node.alternate)
      && (self.is_for_delete(&node.consequent) || self.is_for_delete(&node.test))
    {
      self.replace_with_undefined(&node.span);
      return;
    }

    if self.is_for_delete(&node.consequent) {
      self.replace_with_undefined(&node.consequent.span());
    }

    if self.is_for_delete(&node.alternate) {
      self.replace_with_undefined(&node.alternate.span());
    }

    if self.is_for_delete(&node.test) {
      self.replace_with_another(&node.span(), &node.alternate);
    }
  }

  fn exit_assignment_expression(
    &mut self,
    node: &'a AssignmentExpression<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(&node.right) {
      todo!()
    }

    if self.is_for_delete(&node.left) {
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
    if self.is_for_delete(&node.binding) {
      self.mark_for_delete(node.span)
    }
  }

  fn exit_assignment_target_property_property(
    &mut self,
    node: &'a AssignmentTargetPropertyProperty<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(&node.name) || self.is_for_delete(&node.binding) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_sequence_expression(
    &mut self,
    node: &'a SequenceExpression<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if let Some(last_expr) = node.expressions.last() {
      if self.is_for_delete(last_expr) {
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
    if self.is_for_delete(&node.expression) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_variable_declaration(
    &mut self,
    node: &'a VariableDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_vec_for_delete(&node.declarations) {
      self.mark_for_delete(node.span());
    }

    self.remove_delimiters(&node.declarations);
  }

  fn exit_variable_declarator(
    &mut self,
    node: &VariableDeclarator<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(&node.id) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_expression_statement(
    &mut self,
    node: &'a ExpressionStatement<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(&node.expression) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_debugger_statement(&mut self, node: &DebuggerStatement, _ctx: &mut TraverseCtx<'a>) {
    self.mark_for_delete(node.span());
  }

  fn exit_assignment_pattern(
    &mut self,
    node: &'a AssignmentPattern<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(&node.right) {
      todo!()
    }

    if self.is_for_delete(&node.left) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_object_pattern(&mut self, node: &'a ObjectPattern<'a>, _ctx: &mut TraverseCtx<'a>) {
    if self.is_vec_for_delete(&node.properties) {
      self.mark_for_delete(node.span());
    }

    self.remove_delimiters(&node.properties);
  }

  fn exit_binding_property(&mut self, node: &'a BindingProperty<'a>, _ctx: &mut TraverseCtx<'a>) {
    if self.is_for_delete(&node.key) {
      self.mark_for_delete(node.span);
    }

    if self.is_for_delete(&node.value) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_array_pattern(&mut self, node: &'a ArrayPattern<'a>, _ctx: &mut TraverseCtx<'a>) {
    if self.is_vec_opt_for_delete(&node.elements) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_function(&mut self, node: &'a Function<'a>, _ctx: &mut TraverseCtx<'a>) {
    if let Some(body) = &node.body {
      if self.is_span_for_change(body.span) {
        for item in node.params.items.iter() {
          self.mark_for_delete(item.span);
        }

        let last_param = node.params.items.last();
        self.remove_delimiters(&node.params.items);

        if let Some(rest) = &node.params.rest {
          self.mark_for_delete(rest.span);

          if let Some(last_param) = last_param {
            self.mark_for_delete(Span::new(last_param.span().end, rest.span().start));
          }
        }
      }
    }
  }

  fn exit_function_body(&mut self, node: &'a FunctionBody<'a>, _ctx: &mut TraverseCtx<'a>) {
    self.remove_delimiters(&node.statements);

    if self.is_vec_for_delete(&node.statements) {
      self.replace_with_text(node, "{}");
    }
  }

  fn exit_class_body(&mut self, node: &'a ClassBody<'a>, _ctx: &mut TraverseCtx<'a>) {
    self.remove_delimiters(&node.body);

    if self.is_vec_for_delete(&node.body) {
      self.replace_with_text(node, "{}");
    }
  }

  fn exit_method_definition(&mut self, node: &'a MethodDefinition<'a>, _ctx: &mut TraverseCtx<'a>) {
    if self.is_for_delete(&node.key) {
      self.mark_for_delete(node.span);
    }

    if self.is_span_for_delete(node.value.span) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_ts_interface_declaration(
    &mut self,
    node: &'a TSInterfaceDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    self.mark_for_delete(node.span());
  }

  fn exit_export_named_declaration(
    &mut self,
    node: &'a ExportNamedDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if !node.specifiers.is_empty() && self.is_vec_for_delete(&node.specifiers) {
      self.mark_for_delete(node.span());
    }

    if let Some(declaration) = &node.declaration {
      if self.is_for_delete(declaration) {
        self.mark_for_delete(node.span());
      }
    }

    self.remove_delimiters(&node.specifiers);
  }

  fn exit_import_declaration(
    &mut self,
    node: &'a ImportDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if let Some(specifiers) = &node.specifiers {
      if !specifiers.is_empty() && self.is_vec_for_delete(specifiers) {
        self.mark_for_delete(node.span());
      }

      self.remove_delimiters(specifiers);
    }
  }

  fn enter_jsx_element(&mut self, node: &JSXElement<'a>, ctx: &mut TraverseCtx<'a>) -> EnterAction {
    self.mark_react_component_as_unnecessary(ctx, node.span);

    EnterAction::Ignore
  }

  fn enter_jsx_fragment(
    &mut self,
    node: &JSXFragment<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) -> EnterAction {
    self.mark_react_component_as_unnecessary(ctx, node.span);

    EnterAction::Ignore
  }
}

impl<'a> Shaker<'a> {
  pub fn new(
    meta: &'a Meta<'a>,
    references: References<'a>,
    replacements: Replacements,
    options: ShakerOptions,
  ) -> Self {
    Self {
      changed: false,
      meta,
      references,
      replacements,
      options,
    }
  }

  fn is_span_for_change(&self, span: Span) -> bool {
    self.replacements.has(span)
  }

  fn is_for_change(&self, node: &impl GetSpan) -> bool {
    self.is_span_for_change(node.span())
  }

  fn is_span_for_delete(&self, span: Span) -> bool {
    self
      .replacements
      .get(span)
      .is_some_and(|v| matches!(v.value, ReplacementValue::Del))
  }

  fn is_for_delete(&self, node: &impl GetSpan) -> bool {
    self.is_span_for_delete(node.span())
  }

  fn is_vec_for_delete(&self, nodes: impl IntoIterator<Item = &'a (impl GetSpan + 'a)>) -> bool {
    nodes.into_iter().all(|node| self.is_for_delete(node))
  }

  fn is_vec_opt_for_delete(
    &self,
    nodes: impl IntoIterator<Item = &'a Option<(impl GetSpan + 'a)>>,
  ) -> bool {
    nodes
      .into_iter()
      .all(|el| !el.as_ref().is_some_and(|v| !self.is_for_delete(v)))
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

  fn replace_with_text(&mut self, node: &impl GetSpan, text: &str) {
    self.changed |= self
      .replacements
      .add_replacement(node.span(), ReplacementValue::Str(text.to_string()));
  }

  fn replace_with_another(&mut self, node: &impl GetSpan, another: &impl GetSpan) {
    self.changed |= self
      .replacements
      .add_replacement(node.span(), ReplacementValue::Span(another.span()));
  }

  pub fn shake(&mut self, program: &'a Program<'a>, symbols: &'a SymbolTable) {
    self.changed = false;
    walk(self, program, symbols);

    // Remove all references to deleted nodes
    let mut cloned_references = self.references.clone();
    cloned_references.apply_replacements(&self.replacements);

    let mut dead_symbols = vec![];
    for (&symbol, references) in &cloned_references.map {
      if references.is_empty() {
        dead_symbols.push(symbol);
      }
    }

    for dead_symbol in dead_symbols {
      self.mark_for_delete(dead_symbol.decl);
    }

    if self.changed {
      self.shake(program, symbols);
    }
  }
}

pub fn shake(
  program: &Program,
  meta: &Meta,
  replacements: Replacements,
  semantic: &Semantic,
  allocator: &Allocator,
  options: ShakerOptions,
) -> String {
  let references = References::from_semantic(semantic, allocator);
  let mut shaker = Shaker::new(meta, references, replacements, options);

  shaker.shake(program, semantic.symbols());

  shaker.replacements.apply(semantic.source_text())
}

pub fn shake_source(
  source_text: String,
  replacements: Replacements,
  options: ShakerOptions,
) -> String {
  let allocator = Allocator::default();

  let path = Path::new("test.js");
  let source_type = SourceType::from_path(path).unwrap();

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

  let resolver = create_resolver(path);

  let meta = Meta::new(&allocator, path, &resolver);
  let res = shake(
    program,
    &meta,
    replacements,
    &semantic_ret.semantic,
    &allocator,
    options,
  );
  if res == "\n" {
    "".to_string()
  } else {
    res
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use indoc::indoc;
  use itertools::Itertools;
  use regex::Regex;

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
    let (source_text, for_delete) = extract_spans_for_deletion(source_text);
    shake_source(
      source_text,
      Replacements::from_spans(for_delete),
      ShakerOptions {
        remove_jsx_and_hooks: true,
      },
    )
  }

  fn keep_jsx(source_text: &str) -> String {
    let (source_text, for_delete) = extract_spans_for_deletion(source_text);
    shake_source(
      source_text,
      Replacements::from_spans(for_delete),
      ShakerOptions {
        remove_jsx_and_hooks: false,
      },
    )
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
  fn test_imports() {
    assert_eq!(
      run(indoc! {r#"
        import { to_remove, to_keep } from "module";
                 ^^^^^^^^^
      "#}),
      indoc! {r#"
        import { to_keep } from "module";
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        import { a, b, c } from "module";
                    ^
      "#}),
      indoc! {r#"
        import { a, c } from "module";
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        import { a, b, c } from "module";
                 ^     ^
      "#}),
      indoc! {r#"
        import { b } from "module";
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        import { to_remove } from "module";
                 ^^^^^^^^^
      "#}),
      indoc! {r#""#}
    );

    assert_eq!(
      run(indoc! {r#"
        import { to_remove_1, to_remove_2 } from "module";
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

    assert_eq!(
      run(indoc! {r#"
        const a = function to_remove(param, ...rest) {
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

  #[test]
  fn test_remove_jsx() {
    assert_eq!(
      run(indoc! {r#"
        const str = "to remove";
        const a = <div>{str}</div>;
      "#}),
      indoc! {r#"
        const a = null;
      "#}
    );

    assert_eq!(
      run(indoc! {r#"
        const a = <>to remove</>;
      "#}),
      indoc! {r#"
        const a = null;
      "#}
    );
  }

  #[test]
  fn test_keep_jsx() {
    assert_eq!(
      keep_jsx(indoc! {r#"
        const str = "to remove";
        const a = <div>{str}</div>;
      "#}),
      indoc! {r#"
        const str = "to remove";
        const a = <div>{str}</div>;
      "#}
    );

    assert_eq!(
      keep_jsx(indoc! {r#"
        const a = <>to remove</>;
      "#}),
      indoc! {r#"
        const a = <>to remove</>;
      "#}
    );
  }

  #[test]
  fn test_replace_fn_component() {
    assert_eq!(
      run(indoc! {r#"
        const Title1 = function(props) {
          return <h1>{props.children}</h1>;
        };
        
        const Title2 = (props) => <h1>{props.children}</h1>;
        
        function Title3(props) {
          return <h1>{props.children}</h1>;
        }
        
        export { Title1, Title2, Title3 };
      "#}),
      indoc! {r#"
        const Title1 = function() { return null; };
        
        const Title2 = () => null;
        
        function Title3() { return null; }
        
        export { Title1, Title2, Title3 };
      "#}
    );
  }

  #[test]
  fn test_replace_class_component() {
    assert_eq!(
      run(indoc! {r#"
        class Title {
          someMethod() {}
          
          render() {
            return <h1>to remove</h1>;
          }
        }

        export { Title };
      "#}),
      indoc! {r#"
        function Title() { return null; }
        
        export { Title };
      "#}
    );
  }
}
