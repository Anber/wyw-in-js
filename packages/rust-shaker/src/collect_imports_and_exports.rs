use std::borrow::Cow;
use std::path::Path;

use crate::declaration_context::{DeclarationContext, PathPart};
use crate::meta::export::{Export, ExportedValue};
use crate::meta::file::{JsFilePatch, Meta};
use crate::meta::ident_usages::IdentUsage;
use crate::meta::import::{Import, LocalIdentifier};
use crate::meta::MetaCollector;
use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::diagnostics::OxcDiagnostic;
use oxc::parser::{ParseOptions, Parser};
use oxc::span::{Atom, GetSpan, SourceType};
use oxc_semantic::IsGlobalReference;
use oxc_traverse::{traverse_mut, Ancestor, Traverse, TraverseCtx};

// There is a built-in method `is_require_call` in `oxc_traverse` crate
// but it doesn't check if `require` is a global reference.
fn is_require_call(call_expr: &CallExpression, ctx: &TraverseCtx) -> bool {
  if let Expression::Identifier(ident) = &call_expr.callee {
    return ident.is_global_reference_name("require", ctx.symbols())
      && call_expr.arguments.len() == 1;
  }

  false
}

enum ExportName<'a> {
  Default,
  Named(Atom<'a>),
  None,
}

fn get_export_name_from_member_expr<'a>(
  expr: &MemberExpression<'a>,
  value: &Expression<'a>,
  ctx: &TraverseCtx,
) -> ExportName<'a> {
  let prop = &expr.static_property_name();
  if prop.is_none() {
    return ExportName::None;
  }

  let prop = prop.unwrap();

  match &expr.object() {
    Expression::Identifier(ident) => {
      // exports.foo = ...
      if ident.is_global_reference_name("exports", ctx.symbols()) {
        if prop == "default" {
          // FIXME: It might be a legit named export. We have to check if the current file has __esModule.
          return ExportName::Default;
        }

        return ExportName::Named(Atom::from(prop));
      }

      // module.exports = ...
      if ident.is_global_reference_name("module", ctx.symbols()) && prop == "exports" {
        // Check if the value is a __toCommonJS() call
        return match value {
          Expression::CallExpression(call_expr)
            if call_expr.callee_name().is_some_and(|s| s == "__toCommonJS") =>
          {
            ExportName::Named(Atom::from("__esModule"))
          }

          _ => ExportName::Default,
        };
      }
    }

    Expression::StaticMemberExpression(member_expr) => {
      // module.exports.foo = ...
      if let Expression::Identifier(ident) = &member_expr.object {
        if ident.is_global_reference_name("module", ctx.symbols())
          && member_expr.property.name == "exports"
        {
          return ExportName::Named(Atom::from(prop));
        }
      }
    }
    _ => {}
  }

  ExportName::None
}

fn unwrap_assignment_value<'a, 'b>(expr: &'b Expression<'a>) -> &'b Expression<'a> {
  match expr {
    Expression::AssignmentExpression(assigment) => unwrap_assignment_value(&assigment.right),
    _ => expr,
  }
}

impl<'a> Traverse<'a> for MetaCollector<'a> {
  fn exit_program(&mut self, _node: &mut Program<'a>, _ctx: &mut TraverseCtx<'a>) {
    // let mut new_imports = vec![];
    // let mut new_exports = vec![];
    // let mut imports_for_delete = vec![];
    // let mut exports_for_delete = vec![];
    let mut patch = JsFilePatch::default();

    for import in &self.data.imports.list {
      if let Import::Namespace { source, local } = import {
        let usages = self.identifier_usages.get(local);
        if usages.is_none() {
          // The identifier is not used. Maybe a side effect import?
          patch.delete_import(&import);
          patch.imports.add_side_effect(&source);
          continue;
        }

        let usages = usages.unwrap();

        // Check if the namespace is used only in an export area
        if usages.len() == 1 {
          let only_usage = &usages[0];
          let export = self.get_export_by_span(only_usage.span());

          match (only_usage.prop(), export) {
            (
              Some(prop),
              Some(Export::Named { exported, .. } | Export::Reexport { exported, .. }),
            ) => {
              patch.delete_import(&import);
              patch.delete_export(export.unwrap());
              patch.exports.add_reexport(&prop, &exported, &source);
              continue;
            }

            (_, None) => {}

            (None, Some(Export::Named { exported, .. })) => {
              patch.delete_import(&import);
              patch.delete_export(export.unwrap());
              patch.exports.add_reexport_namespace(&exported, &source);
              continue;
            }

            (prop, export) => {
              todo!("Handle unknown export: {:?} as {:?}", export, prop);
            }
          }
        }

        let mut has_uncertain = false;

        for usage in usages {
          match usage {
            IdentUsage::Unpacked(_span, prop) => {
              patch
                .imports
                .add_named(&source, prop, &LocalIdentifier::Identifier(prop.clone()));
            }

            IdentUsage::MemberExpression(_span, obj, prop) => {
              patch.imports.add_named(
                &source,
                prop,
                &LocalIdentifier::MemberExpression(obj.clone(), prop.clone()),
              );
            }

            IdentUsage::ReexportAll(_) => {
              // The identifier is reexported. We have to remove the import and add a reexport.
              patch.delete_import(import);
              patch.exports.add_reexport_all(source);
            }

            IdentUsage::Uncertain(_) => {
              // The identifier is used in an unknown way. We can skip it.
              has_uncertain = true;
            }
          }
        }

        // If at least one usage is uncertain, we have to keep the import.
        if !has_uncertain {
          patch.delete_import(import);
        }
      }
    }

    self.data.apply_patch(patch);
  }

  fn enter_identifier_reference(
    &mut self,
    node: &mut IdentifierReference<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if !self.is_span_ignored(&node.span) {
      self.resolve_identifier_usage(ctx, &node.span, node.name.clone());
    }
  }

  fn enter_member_expression(
    &mut self,
    node: &mut MemberExpression<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if let MemberExpression::ComputedMemberExpression(member_expr) = node {
      // Something like `namespace["property"]`
      if let Expression::Identifier(ident) = &member_expr.object {
        let ident_name = ident.name.clone();

        if let Expression::StringLiteral(string) = &member_expr.expression {
          self.add_member_usage(&member_expr.span, string.value.clone(), ident_name);
          self.ignore_span(&member_expr.span);
        }
      }
    }
  }

  // Looking for "require" and "import" calls.
  fn enter_call_expression(&mut self, node: &mut CallExpression<'a>, ctx: &mut TraverseCtx<'a>) {
    if is_require_call(node, ctx) {
      self.import_from_require_call(node, ctx)
    }
  }

  fn enter_assignment_expression(
    &mut self,
    node: &mut AssignmentExpression<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if !node.left.is_member_expression() {
      return;
    }

    let member_expr = node.left.as_member_expression().unwrap();

    // if let AssignmentTarget::StaticMemberExpression(member_expr) = &node.left {
    let right = unwrap_assignment_value(&node.right);

    if right.is_void_0() {
      // … = void 0;
      return;
    }

    let reexport_source = if let Expression::CallExpression(call_expr) = &node.right {
      if is_require_call(call_expr, ctx) {
        let args = &call_expr.arguments;
        if let Argument::StringLiteral(str) = &args[0] {
          Some(str.value.clone())
        } else {
          None
        }
      } else {
        None
      }
    } else {
      None
    };

    let export = match (
      get_export_name_from_member_expr(member_expr, &node.right, ctx),
      reexport_source,
    ) {
      (ExportName::Default, None) => Some(Export::Default),
      (ExportName::Default, Some(source)) => Some(Export::ReexportNamespace {
        exported: Atom::from("default"),
        source: source.clone(),
      }),

      (ExportName::Named(name), None) => {
        if name == "__esModule" {
          Some(Export::Named {
            local: ExportedValue::BooleanLiteral(true),
            exported: name.clone(),
          })
        } else {
          Some(Export::Named {
            local: self.object_get_value_from_expression(right),
            exported: name.clone(),
          })
        }
      }

      (ExportName::Named(name), Some(source)) => Some(Export::ReexportNamespace {
        exported: name.clone(),
        source: source.clone(),
      }),

      (ExportName::None, _) => None,
    };

    if let Some(export) = export {
      self.data.exports.add(export.clone());
      self.add_export_area(&node.span, &export);
    }
  }

  // If we are inside a declarator, we have to save declared variable name.
  fn enter_variable_declarator(
    &mut self,
    node: &mut VariableDeclarator<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    self.declaration_context = DeclarationContext::from(node);
  }

  fn exit_variable_declarator(
    &mut self,
    _node: &mut VariableDeclarator<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    self.declaration_context = DeclarationContext::None;
  }

  fn enter_expression_statement(
    &mut self,
    node: &mut ExpressionStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    self.tslib_entrypoint(node, ctx);
    self.esbuild_entrypoint(node, ctx);
    self.swc_entrypoint(node, ctx);
    self.object_define_property_entrypoint(node, ctx);
  }

  fn enter_import_declaration(
    &mut self,
    node: &mut ImportDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    if node.specifiers.is_none() {
      self.data.imports.add_side_effect(&node.source.value);
    }
  }

  fn enter_import_specifier(&mut self, node: &mut ImportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {
    if node.import_kind.is_type() || self.is_type_import(ctx) {
      return;
    }

    let source = self.get_source_from_specifier(ctx);

    match &node.imported {
      ModuleExportName::IdentifierName(ident) => {
        self.data.imports.add_named(
          &source.unwrap(),
          &ident.name,
          &LocalIdentifier::Identifier(node.local.name.clone()),
        );
      }

      _ => {
        // Unknown type of import specifier. Throw an error.
        todo!("Handle other types of import specifiers");
      }
    }
  }

  fn enter_import_default_specifier(
    &mut self,
    node: &mut ImportDefaultSpecifier<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_type_import(ctx) {
      return;
    }

    let source = self.get_source_from_specifier(ctx);

    self.data.imports.add_default(
      source.unwrap(),
      &LocalIdentifier::Identifier(node.local.name.clone()),
    );
  }

  fn enter_import_namespace_specifier(
    &mut self,
    node: &mut ImportNamespaceSpecifier<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if self.is_type_import(ctx) {
      return;
    }

    let source = self.get_source_from_specifier(ctx);

    // FIXME: unresolved
    self
      .data
      .imports
      .add_namespace(source.unwrap(), &node.local.name);
  }

  fn enter_export_named_declaration(
    &mut self,
    node: &mut ExportNamedDeclaration<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) {
    if node.declaration.is_none() || self.is_type_export(ctx) || node.export_kind.is_type() {
      return;
    }

    match &node.declaration {
      Some(Declaration::TSEnumDeclaration(enum_decl)) => {
        self.data.exports.add_named(
          ExportedValue::Identifier(enum_decl.id.name.clone()),
          &enum_decl.id.name,
        );
      }

      Some(Declaration::ClassDeclaration(class_decl)) => {
        match &class_decl.id {
          Some(id) => {
            self
              .data
              .exports
              .add_named(ExportedValue::Identifier(id.name.clone()), &id.name);
          }
          None => {
            // Anonymous class declaration. Throw an error.
            todo!("Handle anonymous class declaration");
          }
        }
      }

      Some(Declaration::FunctionDeclaration(func_decl)) => {
        match &func_decl.id {
          Some(id) => {
            self
              .data
              .exports
              .add_named(ExportedValue::Identifier(id.name.clone()), &id.name);
          }
          None => {
            // Anonymous function declaration. Throw an error.
            todo!("Handle anonymous function declaration");
          }
        }
      }

      Some(Declaration::VariableDeclaration(var_decl)) => {
        for decl in &var_decl.declarations {
          self.export_from_binding_pattern(&decl.id);
        }
      }

      _ => {
        todo!("Handle other types of export declarations");
      }
    }
  }

  fn enter_export_default_declaration(
    &mut self,
    _node: &mut ExportDefaultDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    self.data.exports.add_default();
  }

  fn enter_export_all_declaration(
    &mut self,
    node: &mut ExportAllDeclaration<'a>,
    _ctx: &mut TraverseCtx<'a>,
  ) {
    let source = node.source.value.clone();

    match &node.exported {
      Some(ModuleExportName::IdentifierName(ident)) => {
        self
          .data
          .exports
          .add_reexport_namespace(&ident.name, &source);
      }
      Some(_) => {
        // Unknown type of export specifier. Throw an error.
        todo!("Handle other types of export specifiers");
      }
      None => {
        self.data.exports.add_reexport_all(&source);
      }
    }
  }

  fn enter_export_specifier(&mut self, node: &mut ExportSpecifier<'a>, ctx: &mut TraverseCtx<'a>) {
    if self.is_type_export(ctx) || node.export_kind.is_type() {
      return;
    }

    let source = self.get_source_from_specifier(ctx);
    match (&node.local, &node.exported, source) {
      (
        ModuleExportName::IdentifierReference(local),
        ModuleExportName::IdentifierName(exported),
        None,
      ) => {
        self.data.exports.add_named(
          ExportedValue::Identifier(local.name.clone()),
          &exported.name,
        );
      }
      (
        ModuleExportName::IdentifierName(local),
        ModuleExportName::IdentifierName(exported),
        Some(source),
      ) => {
        self
          .data
          .exports
          .add_reexport(&local.name, &exported.name, &source);
      }
      _ => {
        // Unknown type of export specifier. Throw an error.
        todo!("Handle other types of export specifiers");
      }
    }
  }
}

fn get_property_key<'a>(prop: &PropertyKey<'a>) -> Option<Atom<'a>> {
  match prop.static_name() {
    Some(Cow::Owned(name)) => {
      todo!("Handle owned property name: {:?}", name);
    }
    Some(Cow::Borrowed(name)) => Some(Atom::from(name)),
    _ => None,
  }
}

impl<'a> MetaCollector<'a> {
  // es import/export helpers
  fn get_source_from_specifier<'b>(&self, ctx: &'b TraverseCtx<'a>) -> Option<&'b Atom<'a>> {
    match ctx.parent() {
      Ancestor::ImportDeclarationSpecifiers(spec) => Some(&spec.source().value),

      Ancestor::ExportNamedDeclarationSpecifiers(spec) => {
        let source = spec.source();
        match source {
          Some(source) => Some(&source.value),
          None => None,
        }
      }

      _ => {
        todo!("Handle other types of import specifiers");
      }
    }
  }

  fn is_type_import(&self, ctx: &TraverseCtx<'a>) -> bool {
    match ctx.parent() {
      Ancestor::ImportDeclarationSpecifiers(spec) => spec.import_kind().is_type(),
      _ => false,
    }
  }

  fn is_type_export(&self, ctx: &TraverseCtx<'a>) -> bool {
    match ctx.parent() {
      Ancestor::ExportNamedDeclarationSpecifiers(spec) => spec.export_kind().is_type(),
      _ => false,
    }
  }
}

impl<'a> MetaCollector<'a> {
  // Object related helpers

  pub fn object_is_member(
    &self,
    expr: &Expression<'a>,
    method_name: &str,
    ctx: &TraverseCtx<'a>,
  ) -> bool {
    if let Expression::StaticMemberExpression(ident) = &expr {
      if ident.property.name != method_name {
        return false;
      }

      if let Expression::Identifier(ident) = &ident.object {
        return ident.is_global_reference_name("Object", ctx.symbols());
      }
    }

    false
  }

  fn object_is_method_call(
    &self,
    call_expr: &CallExpression<'a>,
    method_name: &str,
    arity: usize,
    ctx: &TraverseCtx<'a>,
  ) -> bool {
    if call_expr.arguments.len() != arity {
      return false;
    }

    self.object_is_member(&call_expr.callee, method_name, ctx)
  }

  // Object.defineProperty(exports, "__esModule", { value: true });

  fn object_define_property_entrypoint(
    &mut self,
    node: &mut ExpressionStatement<'a>,
    ctx: &TraverseCtx<'a>,
  ) -> bool {
    if let Expression::CallExpression(call_expr) = &node.expression {
      if !self.object_is_method_call(call_expr, "defineProperty", 3, ctx) {
        return false;
      }

      let args = &call_expr.arguments;

      if let Argument::Identifier(ident) = &args[0] {
        if !ident.is_global_reference_name("exports", ctx.symbols()) {
          return false;
        }
      } else {
        return false;
      }

      let exported = if let Argument::StringLiteral(str) = &args[1] {
        str.value.clone()
      } else {
        return false;
      };

      // FIXME: The 3rd argument is an object literal. It may refer a local variable.
      if let Argument::ObjectExpression(obj) = &args[2] {
        if let Some(local) = self.object_get_value_from_property_definition(obj) {
          let export = if exported == "default" {
            Export::Default
          } else {
            Export::Named { local, exported }
          };

          self.data.exports.add(export.clone());

          self.add_export_area(&node.span, &export);
        }
      }
    }

    false
  }

  fn object_get_value_from_expression(&self, expr: &Expression<'a>) -> ExportedValue<'a> {
    if expr.is_void_0() {
      return ExportedValue::Void0;
    }

    match expr {
      Expression::Identifier(ident) => ExportedValue::Identifier(ident.name.clone()),

      Expression::NumericLiteral(num_lit) => ExportedValue::NumericLiteral(num_lit.value),

      Expression::BigIntLiteral(num_lit) => ExportedValue::BigIntLiteral(num_lit.raw.clone()),

      Expression::StringLiteral(str_lit) => ExportedValue::StringLiteral(str_lit.value.clone()),

      Expression::BooleanLiteral(bool_lit) => ExportedValue::BooleanLiteral(bool_lit.value),

      Expression::NullLiteral(_) => ExportedValue::NullLiteral,

      Expression::CallExpression(e) => ExportedValue::Span(e.span),
      Expression::ObjectExpression(e) => ExportedValue::Span(e.span),
      Expression::StaticMemberExpression(e) => ExportedValue::Span(e.span),
      Expression::ComputedMemberExpression(e) => ExportedValue::Span(e.span),

      some => {
        let span = some.span();
        ExportedValue::Span(span)
      }
    }
  }

  fn object_get_value_from_function_body(&self, body: &FunctionBody<'a>) -> ExportedValue<'a> {
    // FIXME: for now only simple functions are supported (e.g. `() => 42` and `() => { return 42; }`)

    if body.statements.len() != 1 {
      todo!("Unsupported function body");
    }

    match &body.statements[0] {
      Statement::ExpressionStatement(ret_stmt) => {
        self.object_get_value_from_expression(&ret_stmt.expression)
      }

      Statement::ReturnStatement(ret_stmt) => match &ret_stmt.argument {
        Some(expr) => self.object_get_value_from_expression(expr),
        None => {
          todo!("Unsupported function body");
        }
      },

      _ => {
        todo!("Unsupported function body");
      }
    }
  }

  fn get_value_from_function_expression(&self, expr: &Expression<'a>) -> Option<ExportedValue<'a>> {
    match &expr {
      Expression::ArrowFunctionExpression(func_expr) => {
        Some(self.object_get_value_from_function_body(&func_expr.body))
      }

      Expression::FunctionExpression(func_expr) => {
        match &func_expr.body {
          Some(body) => Some(self.object_get_value_from_function_body(body)),

          None => {
            // Function without body. Throw an error.
            todo!("Unsupported type of function");
          }
        }
      }

      _ => {
        // Unsupported type of value. Throw an error.
        todo!("Unsupported type of exported value");
      }
    }
  }

  fn object_get_value_from_property_definition(
    &self,
    obj: &ObjectExpression<'a>,
  ) -> Option<ExportedValue<'a>> {
    for prop in &obj.properties {
      match prop {
        ObjectPropertyKind::ObjectProperty(data_prop) => {
          if let PropertyKey::StaticIdentifier(ident) = &data_prop.key {
            if ident.name == "enumerable" {
              continue;
            }

            if ident.name == "value" {
              return Some(self.object_get_value_from_expression(&data_prop.value));
            }

            if ident.name == "get" {
              return self.get_value_from_function_expression(&data_prop.value);
            }
          }
        }
        _ => {
          // Unknown type of property. Throw an error.
          todo!("Unsupported type of property");
        }
      }
    }

    None
  }
}

impl<'a> MetaCollector<'a> {
  // swc & esbuild
  fn exports_from_object_expression(&mut self, obj: &ObjectExpression<'a>) {
    for prop in &obj.properties {
      match prop {
        ObjectPropertyKind::ObjectProperty(method) => {
          let exported = get_property_key(&method.key);
          if exported.is_none() {
            todo!("Unsupported name of exported value");
          }
          let exported = exported.unwrap();
          if exported == "default" {
            self.data.exports.add_default();
            continue;
          }

          let local = self.get_value_from_function_expression(&method.value);
          if local.is_none() {
            todo!("Unsupported type of exported value");
          }

          let export = Export::Named {
            local: local.unwrap(),
            exported,
          };

          self.data.exports.add(export.clone());

          self.add_export_area(&method.span, &export);
        }
        _ => {
          // Unknown type of property. Throw an error.
          todo!("Unsupported type of property");
        }
      }
    }
  }
}

impl<'a> MetaCollector<'a> {
  // swc

  fn swc_get_from_fn_export(&mut self, node: &CallExpression<'a>, ctx: &TraverseCtx) {
    // It might be `__export(exports, {  Foo: () => Foo });`
    if let Some("_export") = node.callee_name() {
      let args = &node.arguments;
      if args.len() != 2 {
        return;
      }

      if let Argument::Identifier(ident) = &args[0] {
        if !ident.is_global_reference_name("exports", ctx.symbols()) {
          return;
        }
      }

      if let Argument::ObjectExpression(obj) = &args[1] {
        self.exports_from_object_expression(obj);
      }
    }
  }

  fn swc_entrypoint(
    &mut self,
    node: &mut ExpressionStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) -> bool {
    if let Expression::CallExpression(call_expr) = &node.expression {
      self.swc_get_from_fn_export(call_expr, ctx);
    }

    false
  }
}

impl<'a> MetaCollector<'a> {
  // esbuild

  fn esbuild_get_from_fn_export(&mut self, node: &CallExpression<'a>, ctx: &TraverseCtx) {
    // It might be `__export(exports, {  Foo: () => Foo });`
    if let Some("__export") = node.callee_name() {
      let args = &node.arguments;
      if args.len() != 2 {
        return;
      }

      if let Argument::Identifier(ident) = &args[0] {
        if !ident.is_global_reference_name("exports", ctx.symbols())
          && ident.name != "source_exports"
        {
          return;
        }
      }

      if let Argument::ObjectExpression(obj) = &args[1] {
        self.exports_from_object_expression(obj);
      }
    }
  }

  fn esbuild_entrypoint(
    &mut self,
    node: &mut ExpressionStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) -> bool {
    if let Expression::CallExpression(call_expr) = &node.expression {
      self.esbuild_get_from_fn_export(call_expr, ctx);
    }

    false
  }
}

impl<'a> MetaCollector<'a> {
  // tslib

  fn tslib_entrypoint(
    &mut self,
    node: &mut ExpressionStatement<'a>,
    ctx: &mut TraverseCtx<'a>,
  ) -> bool {
    let tslib_import = self.get_tslib_import();
    if tslib_import.is_none() {
      return false;
    }

    let tslib_import = tslib_import.unwrap();

    // We are looking for expressions like:
    // tslib_1.__exportStar(require('./moduleA1'), exports);
    if let Expression::CallExpression(call_expr) = &node.expression {
      if !self.tslib_is_export_star(call_expr, tslib_import) {
        return false;
      }

      let args = &call_expr.arguments;
      if args.len() != 2 {
        return false;
      }

      if let Argument::Identifier(ident) = &args[1] {
        if !ident.is_global_reference_name("exports", ctx.symbols()) {
          return false;
        }
      } else {
        return false;
      }

      if let Argument::CallExpression(maybe_require) = &args[0] {
        if !is_require_call(maybe_require, ctx) {
          return false;
        }

        // It is `tslib_1.__exportStar(require('./moduleA1'), exports);`

        let source = match &maybe_require.arguments.first().unwrap() {
          Argument::StringLiteral(str) => str.value.clone(),
          _ => return false,
        };

        self.data.exports.add_reexport_all(&source);
        self.ignore_span(&maybe_require.span);
        return true;
      }
    }

    false
  }

  fn tslib_is_export_star(&self, call_expr: &CallExpression<'a>, tslib: &Atom<'a>) -> bool {
    if let Expression::StaticMemberExpression(ident) = &call_expr.callee {
      if ident.property.name != "__exportStar" {
        return false;
      }

      if let Expression::Identifier(ident) = &ident.object {
        if ident.name == tslib {
          return true;
        }
      }
    }

    false
  }
}

impl<'a> MetaCollector<'a> {
  fn get_tslib_import(&self) -> Option<&Atom<'a>> {
    self.data.imports.find_ns_by_source("tslib")
  }
}

impl<'a> MetaCollector<'a> {
  fn ignore_span(&mut self, span: &Span) {
    // FIXME: use more efficient data structure
    self.ignored_spans.push(*span);
  }

  fn is_span_ignored(&self, span: &Span) -> bool {
    self
      .ignored_spans
      .iter()
      .any(|ignored_span| ignored_span.start <= span.start && ignored_span.end >= span.end)
  }
}

impl<'a> MetaCollector<'a> {
  fn export_from_binding_pattern(&mut self, pattern: &BindingPattern<'a>) {
    match &pattern.kind {
      BindingPatternKind::BindingIdentifier(ident) => {
        let export = Export::Named {
          local: ExportedValue::Identifier(ident.name.clone()),
          exported: ident.name.clone(),
        };
        self.data.exports.add(export.clone());
        self.add_export_area(&pattern.span(), &export);
      }

      BindingPatternKind::ObjectPattern(pattern) => {
        for prop in &pattern.properties {
          self.export_from_binding_property(prop);
        }

        if let Some(rest) = &pattern.rest {
          self.export_from_binding_pattern(&rest.argument);
        }
      }

      _ => {
        // Unknown type of binding pattern. Throw an error.
        todo!("Unsupported type of binding pattern.");
      }
    }
  }

  fn export_from_binding_property<'b>(&mut self, prop: &'b BindingProperty<'a>) {
    if prop.computed {
      todo!("Computed property names are not supported.");
    }

    let key = get_property_key(&prop.key);
    if prop.shorthand && key.is_some() {
      let key = key.unwrap();
      self
        .data
        .exports
        .add_named(ExportedValue::Identifier(key.clone()), &key);

      return;
    }

    self.export_from_binding_pattern(&prop.value);
  }

  fn process_standalone_require_call(&mut self, source: &Atom<'a>, ctx: &TraverseCtx<'a>) {
    let parent = ctx.parent();
    let is_namespace_import =
      (parent.is_via_expression() || parent.is_via_argument()) && !parent.is_expression_statement();

    if !is_namespace_import {
      // Side effect import
      self.data.imports.add_side_effect(source);

      return;
    }

    let reexport_method_names = [
      "__export", // TypeScript <=3.8.3
      "__exportStar",
      "__reExport",
      "_exportStar",
      "_export_star",
    ];

    let reexport_method = ctx.ancestors().find(|ancestor| {
      matches!(
          ancestor,
          Ancestor::CallExpressionArguments(arg) if reexport_method_names.iter().any(|m| arg.callee().is_specific_id(m))
      )
    });

    if reexport_method.is_some() {
      // It is a reexport
      self.data.exports.add_reexport_all(source);
    }
  }

  fn import_from_require_call(&mut self, call_expr: &CallExpression<'a>, ctx: &TraverseCtx<'a>) {
    if self.is_span_ignored(&call_expr.span) {
      return;
    }

    let prop = match ctx.parent() {
      Ancestor::StaticMemberExpressionObject(member_expr) => {
        Some(member_expr.property().name.clone())
      }
      _ => None,
    };

    match &call_expr.arguments.first().unwrap() {
      Argument::StringLiteral(str) => {
        let source = &str.value;

        match &self.declaration_context {
          DeclarationContext::None => {
            self.process_standalone_require_call(source, ctx);
          }

          DeclarationContext::List(list) => {
            for decl in list {
              match (&*decl.from, &prop) {
                (_, Some(ref ident)) | (&[PathPart::Identifier(ref ident), ..], None) => {
                  self.data.imports.add_named(
                    source,
                    ident,
                    &LocalIdentifier::Identifier(decl.name.clone()),
                  );
                }

                (&[], None) => {
                  self.data.imports.add_namespace(source, &decl.name);
                }

                (&[PathPart::Index(_), ..], None) => {
                  // Is it an array imported as a namespace?
                  panic!("Unsupported import declaration");
                }
              }
            }
          }
        }
      }

      _ => {
        // Unknown type of import. Throw an error.
        todo!("Handle other types of arguments");
      }
    }
  }
}

pub fn parse_js_file_from_source<'a>(
  allocator: &'a Allocator,
  path: &'a Path,
  source_text: &'a str,
  source_type: SourceType,
) -> Result<Meta<'a>, Vec<OxcDiagnostic>> {
  let parser_ret = Parser::new(allocator, source_text, source_type)
    .with_options(ParseOptions {
      parse_regular_expression: true,
      ..ParseOptions::default()
    })
    .parse();

  if !parser_ret.errors.is_empty() {
    for error in parser_ret.errors.clone() {
      // let error = error.with_source_code(source_text.clone());
      println!("{error:?}");
      println!("Parsed with Errors.");
    }

    return Err(parser_ret.errors.clone());
  }

  let mut collector = MetaCollector::new(path);

  let program = allocator.alloc(parser_ret.program);

  let semantic_ret = oxc_semantic::SemanticBuilder::new(source_text)
    .build_module_record(path, program)
    .with_check_syntax_error(true)
    .with_trivias(parser_ret.trivias)
    .build(program);

  let (symbols, scopes) = semantic_ret.semantic.into_symbol_table_and_scope_tree();
  traverse_mut(&mut collector, allocator, program, symbols, scopes);

  Ok(collector.data)
}

#[cfg(test)]
mod tests {
  use super::*;
  use glob::glob;
  use insta::assert_debug_snapshot;
  use std::path::PathBuf;

  #[testing::fixture("tests/fixture/meta/*/*.input.?s")]
  fn fixture(input: PathBuf) {
    let snapshot_path = input.parent().unwrap();
    let snapshot_name = input.file_stem().and_then(|s| s.to_str()).unwrap();

    let allocator = Allocator::default();
    let file_content = std::fs::read_to_string(&input).unwrap();
    let source_type = SourceType::from_path(&input).unwrap();
    let result = parse_js_file_from_source(&allocator, &input, &file_content, source_type);
    assert!(result.is_ok());

    let js_file = result.unwrap();

    insta::with_settings!({
      input_file => &input,
      snapshot_path => &snapshot_path,
      description => &file_content,
      omit_expression => true
    }, {
          assert_debug_snapshot!(snapshot_name, js_file);
    });
  }

  #[test]
  fn performance() {
    // Load all fixtures
    let fixtures = glob("tests/fixture/meta/*/*.input.?s")
      .unwrap()
      .map(|file| file.unwrap())
      .map(|file| (file.clone(), std::fs::read_to_string(&file).unwrap()));

    fn run_for_file(file: &PathBuf, file_content: &str) {
      let allocator = Allocator::default();
      let source_type = SourceType::from_path(file).unwrap();
      let result = parse_js_file_from_source(&allocator, file, file_content, source_type);
      assert!(result.is_ok());
    }

    let n = 1;

    // Run the parser N times for each file and measure the time
    let start = std::time::Instant::now();

    let mut count = 0;
    for entry in fixtures {
      let (file, content) = entry;
      for _ in 0..n {
        run_for_file(&file, &content);
        count += 1;
      }
    }

    let duration = start.elapsed();
    println!("Parsed {} files in {:?}", count, duration);
  }
}
