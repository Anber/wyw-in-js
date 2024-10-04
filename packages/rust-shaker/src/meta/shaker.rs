use crate::meta::spans::Spans;
use oxc::allocator::CloneIn;
use oxc::ast::ast::*;
use oxc::span::{GetSpan, Span};
use oxc_traverse::TraverseCtx;

pub struct Shaker<'a> {
  for_delete: Spans,
  for_replace: Vec<(Span, Expression<'a>)>,
}

impl<'a> Shaker<'a> {
  pub fn new(for_delete: Vec<Span>) -> Self {
    Self {
      for_delete: Spans::new(for_delete),
      for_replace: vec![],
    }
  }

  fn is_for_delete(&self, span: Span) -> bool {
    self.for_delete.has(span)
  }

  fn mark_for_delete(&mut self, span: Span) {
    self.for_delete.add(span);
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

impl<'a> oxc_traverse::Traverse<'a> for Shaker<'a> {
  fn exit_program(&mut self, node: &mut Program<'a>, ctx: &mut TraverseCtx<'a>) {
    node.body.retain(|stmt| !self.is_for_delete(stmt.span()));
  }

  fn exit_expression(&mut self, _node: &mut Expression<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_identifier_name(&mut self, _node: &mut IdentifierName<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_identifier_reference(
    &mut self,
    _node: &mut IdentifierReference<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_binding_identifier(
    &mut self,
    node: &mut BindingIdentifier<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_label_identifier(&mut self, node: &mut LabelIdentifier<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_this_expression(&mut self, node: &mut ThisExpression, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_array_expression(&mut self, node: &mut ArrayExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    // todo!("Not implemented");
  }

  fn exit_array_expression_element(
    &mut self,
    node: &mut ArrayExpressionElement<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.span()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_elision(&mut self, node: &mut Elision, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_object_expression(&mut self, node: &mut ObjectExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    // todo!("Not implemented");
  }

  fn exit_object_property_kind(
    &mut self,
    node: &mut ObjectPropertyKind<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    // todo!("Not implemented");
  }

  fn exit_object_property(&mut self, node: &mut ObjectProperty<'a>, ctx: &mut TraverseCtx<'a>) {
    // todo!("Not implemented");
  }

  fn exit_property_key(&mut self, _node: &mut PropertyKey<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_template_literal(&mut self, node: &mut TemplateLiteral<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_tagged_template_expression(
    &mut self,
    node: &mut TaggedTemplateExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_template_element(&mut self, node: &mut TemplateElement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_member_expression(&mut self, node: &mut MemberExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_computed_member_expression(
    &mut self,
    node: &mut ComputedMemberExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_static_member_expression(
    &mut self,
    node: &mut StaticMemberExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_private_field_expression(
    &mut self,
    node: &mut PrivateFieldExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_call_expression(&mut self, node: &mut CallExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_new_expression(&mut self, node: &mut NewExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_meta_property(&mut self, node: &mut MetaProperty<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_spread_element(&mut self, node: &mut SpreadElement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_argument(&mut self, node: &mut Argument<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_update_expression(&mut self, node: &mut UpdateExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_unary_expression(&mut self, node: &mut UnaryExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_binary_expression(&mut self, node: &mut BinaryExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_private_in_expression(
    &mut self,
    node: &mut PrivateInExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
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

  fn exit_conditional_expression(
    &mut self,
    node: &mut ConditionalExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.test.span()) {
      self.mark_for_replace(node.span(), node.alternate.clone_in(ctx.ast.allocator));
    }

    if self.is_for_delete(node.consequent.span()) {
      node.consequent = ctx
        .ast
        .expression_identifier_reference(node.consequent.span(), "undefined");
    }

    if self.is_for_delete(node.alternate.span()) {
      node.alternate = ctx
        .ast
        .expression_identifier_reference(node.alternate.span(), "undefined");
    }
  }

  fn exit_assignment_expression(
    &mut self,
    node: &mut AssignmentExpression<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.right.span()) {
      todo!("Handle assignment expression with deleted right side");
    }

    if self.is_for_delete(node.left.span()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_assignment_target(
    &mut self,
    _node: &mut AssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_simple_assignment_target(
    &mut self,
    _node: &mut SimpleAssignmentTarget<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_assignment_target_pattern(
    &mut self,
    _node: &mut AssignmentTargetPattern<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
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

  fn exit_assignment_target_rest(
    &mut self,
    node: &mut AssignmentTargetRest<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_assignment_target_maybe_default(
    &mut self,
    node: &mut AssignmentTargetMaybeDefault<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_assignment_target_with_default(
    &mut self,
    node: &mut AssignmentTargetWithDefault<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_assignment_target_property(
    &mut self,
    _node: &mut AssignmentTargetProperty<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_assignment_target_property_identifier(
    &mut self,
    node: &mut AssignmentTargetPropertyIdentifier<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.binding.span()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_assignment_target_property_property(
    &mut self,
    node: &mut AssignmentTargetPropertyProperty<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.name.span()) {
      self.mark_for_delete(node.span());
    }

    if self.is_for_delete(node.binding.span()) {
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

  fn exit_super(&mut self, node: &mut Super, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_await_expression(&mut self, node: &mut AwaitExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_chain_expression(&mut self, node: &mut ChainExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_chain_element(&mut self, node: &mut ChainElement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_parenthesized_expression(
    &mut self,
    node: &mut ParenthesizedExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.expression.span()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_statement(&mut self, _node: &mut Statement<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_directive(&mut self, node: &mut Directive<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_hashbang(&mut self, node: &mut Hashbang<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_block_statement(&mut self, node: &mut BlockStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_declaration(&mut self, _node: &mut Declaration<'a>, _ctx: &mut TraverseCtx<'a>) {}

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

    if self.is_for_delete(node.id.span()) {
      self.mark_for_delete(node.span());
    }

    // match &mut node.id.kind {
    //   BindingPatternKind::BindingIdentifier(id) => {
    //     if self.is_for_delete(id.span) {
    //       self.mark_for_delete(node.span());
    //     }
    //   }
    //
    //   BindingPatternKind::ObjectPattern(obj) => {
    //     obj
    //       .properties
    //       .retain(|prop| !self.is_for_delete(prop.span()));
    //   }
    //
    //   _ => {}
    // }
  }

  fn exit_empty_statement(&mut self, node: &mut EmptyStatement, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_expression_statement(
    &mut self,
    node: &mut ExpressionStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.expression.span()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_if_statement(&mut self, node: &mut IfStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_do_while_statement(
    &mut self,
    node: &mut DoWhileStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_while_statement(&mut self, node: &mut WhileStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_for_statement(&mut self, node: &mut ForStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_for_statement_init(
    &mut self,
    node: &mut ForStatementInit<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_for_in_statement(&mut self, node: &mut ForInStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_for_statement_left(
    &mut self,
    node: &mut ForStatementLeft<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_for_of_statement(&mut self, node: &mut ForOfStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_continue_statement(
    &mut self,
    node: &mut ContinueStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_break_statement(&mut self, node: &mut BreakStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_return_statement(&mut self, node: &mut ReturnStatement<'a>, ctx: &mut TraverseCtx<'a>) {}

  fn exit_with_statement(&mut self, node: &mut WithStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_switch_statement(&mut self, node: &mut SwitchStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_switch_case(&mut self, node: &mut SwitchCase<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_labeled_statement(&mut self, node: &mut LabeledStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_throw_statement(&mut self, node: &mut ThrowStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_try_statement(&mut self, node: &mut TryStatement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_catch_clause(&mut self, node: &mut CatchClause<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_catch_parameter(&mut self, node: &mut CatchParameter<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
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

  fn exit_binding_pattern_kind(
    &mut self,
    _node: &mut BindingPatternKind<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_assignment_pattern(
    &mut self,
    node: &mut AssignmentPattern<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_for_delete(node.right.span()) {
      todo!("Handle assignment pattern with deleted right side");
    }

    if self.is_for_delete(node.left.span()) {
      self.mark_for_delete(node.span());
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

  fn exit_binding_property(&mut self, node: &mut BindingProperty<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_for_delete(node.key.span()) {
      self.mark_for_delete(node.span());
    }

    if self.is_for_delete(node.value.span()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_array_pattern(&mut self, node: &mut ArrayPattern<'a>, ctx: &mut TraverseCtx<'a>) {
    // todo!("Not implemented");
  }

  fn exit_binding_rest_element(
    &mut self,
    node: &mut BindingRestElement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_function(&mut self, node: &mut Function<'a>, _ctx: &mut TraverseCtx<'a>) {
    if let Some(body) = &mut node.body {
      if body.statements.is_empty() {
        node.params.items.clear();
        node.params.rest = None;
      }
    }
  }

  fn exit_formal_parameters(&mut self, node: &mut FormalParameters<'a>, ctx: &mut TraverseCtx<'a>) {
  }

  fn exit_formal_parameter(&mut self, node: &mut FormalParameter<'a>, ctx: &mut TraverseCtx<'a>) {}

  fn exit_function_body(&mut self, node: &mut FunctionBody<'a>, ctx: &mut TraverseCtx<'a>) {
    node
      .statements
      .retain(|stmt| !self.is_for_delete(stmt.span()));
  }

  fn exit_arrow_function_expression(
    &mut self,
    node: &mut ArrowFunctionExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_yield_expression(&mut self, node: &mut YieldExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_class(&mut self, node: &mut Class<'a>, ctx: &mut TraverseCtx<'a>) {}

  fn exit_class_body(&mut self, node: &mut ClassBody<'a>, ctx: &mut TraverseCtx<'a>) {
    node
      .body
      .retain(|element| !self.is_for_delete(element.span()));
  }

  fn exit_class_element(&mut self, _node: &mut ClassElement<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_method_definition(&mut self, node: &mut MethodDefinition<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_for_delete(node.key.span()) {
      self.mark_for_delete(node.span());
    }

    if self.is_for_delete(node.value.span()) {
      self.mark_for_delete(node.span());
    }
  }

  fn exit_property_definition(
    &mut self,
    node: &mut PropertyDefinition<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_private_identifier(
    &mut self,
    node: &mut PrivateIdentifier<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_static_block(&mut self, node: &mut StaticBlock<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_module_declaration(
    &mut self,
    _node: &mut ModuleDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_accessor_property(&mut self, node: &mut AccessorProperty<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_import_expression(&mut self, node: &mut ImportExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_import_declaration(
    &mut self,
    node: &mut ImportDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_import_declaration_specifier(
    &mut self,
    node: &mut ImportDeclarationSpecifier<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_import_specifier(&mut self, node: &mut ImportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_import_default_specifier(
    &mut self,
    node: &mut ImportDefaultSpecifier<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_import_namespace_specifier(
    &mut self,
    node: &mut ImportNamespaceSpecifier<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_with_clause(&mut self, node: &mut WithClause<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_import_attribute(&mut self, node: &mut ImportAttribute<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_import_attribute_key(
    &mut self,
    node: &mut ImportAttributeKey<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
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

  fn exit_export_default_declaration(
    &mut self,
    node: &mut ExportDefaultDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_export_all_declaration(
    &mut self,
    node: &mut ExportAllDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_export_specifier(&mut self, node: &mut ExportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_for_delete(node.local.span()) {
      self.mark_for_delete(node.span);
    }
  }

  fn exit_export_default_declaration_kind(
    &mut self,
    node: &mut ExportDefaultDeclarationKind<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_module_export_name(
    &mut self,
    _node: &mut ModuleExportName<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
  }

  fn exit_jsx_element(&mut self, node: &mut JSXElement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_opening_element(
    &mut self,
    node: &mut JSXOpeningElement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_closing_element(
    &mut self,
    node: &mut JSXClosingElement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_fragment(&mut self, node: &mut JSXFragment<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_element_name(&mut self, node: &mut JSXElementName<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_namespaced_name(
    &mut self,
    node: &mut JSXNamespacedName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_member_expression(
    &mut self,
    node: &mut JSXMemberExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_member_expression_object(
    &mut self,
    node: &mut JSXMemberExpressionObject<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_expression_container(
    &mut self,
    node: &mut JSXExpressionContainer<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_expression(&mut self, node: &mut JSXExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_empty_expression(
    &mut self,
    node: &mut JSXEmptyExpression,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_attribute_item(
    &mut self,
    node: &mut JSXAttributeItem<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_attribute(&mut self, node: &mut JSXAttribute<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_spread_attribute(
    &mut self,
    node: &mut JSXSpreadAttribute<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_attribute_name(
    &mut self,
    node: &mut JSXAttributeName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_attribute_value(
    &mut self,
    node: &mut JSXAttributeValue<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_jsx_identifier(&mut self, node: &mut JSXIdentifier<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_child(&mut self, node: &mut JSXChild<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_spread_child(&mut self, node: &mut JSXSpreadChild<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_jsx_text(&mut self, node: &mut JSXText<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_boolean_literal(&mut self, _node: &mut BooleanLiteral, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_null_literal(&mut self, _node: &mut NullLiteral, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_numeric_literal(&mut self, _node: &mut NumericLiteral<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_big_int_literal(&mut self, _node: &mut BigIntLiteral<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_reg_exp_literal(&mut self, _node: &mut RegExpLiteral<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_string_literal(&mut self, _node: &mut StringLiteral<'a>, _ctx: &mut TraverseCtx<'a>) {}

  fn exit_ts_this_parameter(&mut self, node: &mut TSThisParameter<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_enum_declaration(
    &mut self,
    node: &mut TSEnumDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_enum_member(&mut self, node: &mut TSEnumMember<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_enum_member_name(
    &mut self,
    node: &mut TSEnumMemberName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_type_annotation(
    &mut self,
    node: &mut TSTypeAnnotation<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_literal_type(&mut self, node: &mut TSLiteralType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_literal(&mut self, node: &mut TSLiteral<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type(&mut self, node: &mut TSType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_conditional_type(
    &mut self,
    node: &mut TSConditionalType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_union_type(&mut self, node: &mut TSUnionType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_intersection_type(
    &mut self,
    node: &mut TSIntersectionType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_parenthesized_type(
    &mut self,
    node: &mut TSParenthesizedType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_type_operator(&mut self, node: &mut TSTypeOperator<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_array_type(&mut self, node: &mut TSArrayType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_indexed_access_type(
    &mut self,
    node: &mut TSIndexedAccessType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_tuple_type(&mut self, node: &mut TSTupleType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_named_tuple_member(
    &mut self,
    node: &mut TSNamedTupleMember<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_optional_type(&mut self, node: &mut TSOptionalType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_rest_type(&mut self, node: &mut TSRestType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_tuple_element(&mut self, node: &mut TSTupleElement<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_any_keyword(&mut self, node: &mut TSAnyKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_string_keyword(&mut self, node: &mut TSStringKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_boolean_keyword(&mut self, node: &mut TSBooleanKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_number_keyword(&mut self, node: &mut TSNumberKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_never_keyword(&mut self, node: &mut TSNeverKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_intrinsic_keyword(
    &mut self,
    node: &mut TSIntrinsicKeyword,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_unknown_keyword(&mut self, node: &mut TSUnknownKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_null_keyword(&mut self, node: &mut TSNullKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_undefined_keyword(
    &mut self,
    node: &mut TSUndefinedKeyword,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_void_keyword(&mut self, node: &mut TSVoidKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_symbol_keyword(&mut self, node: &mut TSSymbolKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_this_type(&mut self, node: &mut TSThisType, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_object_keyword(&mut self, node: &mut TSObjectKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_big_int_keyword(&mut self, node: &mut TSBigIntKeyword, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_reference(&mut self, node: &mut TSTypeReference<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_name(&mut self, node: &mut TSTypeName<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_qualified_name(&mut self, node: &mut TSQualifiedName<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_parameter_instantiation(
    &mut self,
    node: &mut TSTypeParameterInstantiation<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_type_parameter(&mut self, node: &mut TSTypeParameter<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_parameter_declaration(
    &mut self,
    node: &mut TSTypeParameterDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_type_alias_declaration(
    &mut self,
    node: &mut TSTypeAliasDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_class_implements(
    &mut self,
    node: &mut TSClassImplements<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_interface_declaration(
    &mut self,
    node: &mut TSInterfaceDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_interface_body(&mut self, node: &mut TSInterfaceBody<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_property_signature(
    &mut self,
    node: &mut TSPropertySignature<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_signature(&mut self, node: &mut TSSignature<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_index_signature(
    &mut self,
    node: &mut TSIndexSignature<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_call_signature_declaration(
    &mut self,
    node: &mut TSCallSignatureDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_method_signature(
    &mut self,
    node: &mut TSMethodSignature<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_construct_signature_declaration(
    &mut self,
    node: &mut TSConstructSignatureDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_index_signature_name(
    &mut self,
    node: &mut TSIndexSignatureName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_interface_heritage(
    &mut self,
    node: &mut TSInterfaceHeritage<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_type_predicate(&mut self, node: &mut TSTypePredicate<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_predicate_name(
    &mut self,
    node: &mut TSTypePredicateName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_module_declaration(
    &mut self,
    node: &mut TSModuleDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_module_declaration_name(
    &mut self,
    node: &mut TSModuleDeclarationName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_module_declaration_body(
    &mut self,
    node: &mut TSModuleDeclarationBody<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_module_block(&mut self, node: &mut TSModuleBlock<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_literal(&mut self, node: &mut TSTypeLiteral<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_infer_type(&mut self, node: &mut TSInferType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_query(&mut self, node: &mut TSTypeQuery<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_type_query_expr_name(
    &mut self,
    node: &mut TSTypeQueryExprName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_import_type(&mut self, node: &mut TSImportType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_import_attributes(
    &mut self,
    node: &mut TSImportAttributes<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_import_attribute(
    &mut self,
    node: &mut TSImportAttribute<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_import_attribute_name(
    &mut self,
    node: &mut TSImportAttributeName<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_function_type(&mut self, node: &mut TSFunctionType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_constructor_type(
    &mut self,
    node: &mut TSConstructorType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_mapped_type(&mut self, node: &mut TSMappedType<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_template_literal_type(
    &mut self,
    node: &mut TSTemplateLiteralType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_as_expression(&mut self, node: &mut TSAsExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_satisfies_expression(
    &mut self,
    node: &mut TSSatisfiesExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_type_assertion(&mut self, node: &mut TSTypeAssertion<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_import_equals_declaration(
    &mut self,
    node: &mut TSImportEqualsDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_module_reference(
    &mut self,
    node: &mut TSModuleReference<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_external_module_reference(
    &mut self,
    node: &mut TSExternalModuleReference<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_non_null_expression(
    &mut self,
    node: &mut TSNonNullExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_decorator(&mut self, node: &mut Decorator<'a>, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
  }

  fn exit_ts_export_assignment(
    &mut self,
    node: &mut TSExportAssignment<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_namespace_export_declaration(
    &mut self,
    node: &mut TSNamespaceExportDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_ts_instantiation_expression(
    &mut self,
    node: &mut TSInstantiationExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_js_doc_nullable_type(
    &mut self,
    node: &mut JSDocNullableType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_js_doc_non_nullable_type(
    &mut self,
    node: &mut JSDocNonNullableType<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    todo!("Not implemented");
  }

  fn exit_js_doc_unknown_type(&mut self, node: &mut JSDocUnknownType, ctx: &mut TraverseCtx<'a>) {
    todo!("Not implemented");
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
