use crate::declaration_context::{DeclarationContext, PathPart};
use oxc::ast::ast::Expression;
use oxc::span::{Atom, Span};
use oxc_semantic::{IsGlobalReference, SymbolTable};
use std::collections::HashMap;
use wyw_traverse::symbol::Symbol;
use wyw_traverse::{Ancestor, AnyNode};

#[derive(Debug)]
pub enum IdentUsage<'a> {
  MemberExpression(Span, &'a Symbol, Atom<'a>),
  ReexportAll(Span),
  Uncertain(Span),
  Unpacked {
    span: Span,
    local: &'a Symbol,
    path: Atom<'a>,
    symbol: Symbol,
  },
}

impl<'a> IdentUsage<'a> {
  pub fn prop(&self) -> Option<&Atom<'a>> {
    match self {
      Self::MemberExpression(_, _, prop) => Some(prop),
      Self::Unpacked { path, .. } => Some(path),
      _ => None,
    }
  }

  pub fn span(&self) -> &Span {
    match self {
      Self::MemberExpression(span, _, _) => span,
      Self::ReexportAll(span) => span,
      Self::Uncertain(span) => span,
      Self::Unpacked { span, .. } => span,
    }
  }
}

#[derive(Default)]
pub struct IdentUsages<'a> {
  // symbols: &'a SymbolTable,
  map: HashMap<&'a Symbol, Vec<IdentUsage<'a>>>,
}

impl<'a> IdentUsages<'a> {
  fn add_usage(&mut self, usage: IdentUsage<'a>, symbol: &'a Symbol) {
    let usages = self.map.get_mut(&symbol);
    match usages {
      None => {
        self.map.insert(symbol, vec![usage]);
      }

      Some(v) => {
        v.push(usage);
      }
    }
  }

  pub fn add_member_usage(&mut self, span: &Span, usage: Atom<'a>, symbol: &'a Symbol) {
    let usage = IdentUsage::MemberExpression(*span, symbol, usage);
    self.add_usage(usage, symbol);
  }

  fn add_unpacked_usage(&mut self, span: &Span, to: &'a Symbol, path: Atom<'a>, from: Symbol) {
    let usage = IdentUsage::Unpacked {
      span: *span,
      local: to,
      path,
      symbol: from,
    };

    self.add_usage(usage, to);
  }

  pub fn get(&self, symbol: &'a Symbol) -> Option<&Vec<IdentUsage<'a>>> {
    self.map.get(symbol)
  }

  fn mark_identifier_as_unresolvable(&mut self, span: &Span, symbol: &'a Symbol) {
    let usage = IdentUsage::Uncertain(*span);
    self.add_usage(usage, symbol);
  }

  fn mark_identifier_as_reexport(&mut self, span: &Span, symbol: &'a Symbol) {
    let usage = IdentUsage::ReexportAll(*span);
    self.add_usage(usage, symbol);
  }

  fn object_is_member(
    &self,
    expr: &'a Expression<'a>,
    method_name: &str,
    symbols: &'a SymbolTable,
  ) -> bool {
    if let Expression::StaticMemberExpression(ident) = &expr {
      if ident.property.name != method_name {
        return false;
      }

      if let Expression::Identifier(id_ref) = &ident.object {
        return id_ref.is_global_reference_name("Object", symbols);
      }
    }

    false
  }

  pub fn resolve_identifier_usage(
    &mut self,
    parent: &Ancestor<'a>,
    span: &Span,
    symbol: &'a Symbol,
    symbols: &'a SymbolTable,
  ) {
    // if ctx.ancestors.iter().any(|ancestor| ancestor.is_via_ts_type()) {
    //   return;
    // }

    // let import = self.imports.find_by_symbol(symbol);
    //
    // if import.is_some() {
    //   let mut import = import.unwrap();
    //
    //   // If the source is unresolved, we have to resolve it first
    //   if let Import::Named {
    //     source: Source::Unresolved(source),
    //     ..
    //   } = import
    //   {
    //     let resolved = self.resolver.resolve(self.directory, source);
    //     if let Ok(resolution) = resolved {
    //       let resolution = self.allocator.alloc(resolution);
    //       let path = self.allocator.alloc(resolution.path());
    //       import = import.set_resolved(path);
    //
    //       if let Some(package_json) = resolution.package_json() {
    //         let raw_json = package_json.raw_json();
    //
    //         if let Some(obj) = raw_json.as_object() {
    //           if let Some(wyw) = obj.get("wyw-in-js") {
    //             if let Some(tags) = wyw.get("tags") {
    //               if let Some(tag) = tags.get(symbol.name) {
    //                 // processor here is a relative path to the processor file
    //                 let processor = tag.as_str().unwrap();
    //
    //                 let full_path = package_json
    //                   .path
    //                   .parent()
    //                   .map(|p| p.join(processor).normalize())
    //                   .unwrap();
    //
    //                 import.set_processor(full_path);
    //               }
    //             }
    //           }
    //         }
    //       }
    //     }
    //   }
    //
    //   if let Import::Named {
    //     processor: Processor::Resolved(processor),
    //     source: Source::Resolved(source),
    //     ..
    //   } = import
    //   {
    //     let idx = self.meta.processor_params.len();
    //     let (span, processor_params) = ProcessorParams::from_ident(
    //       ctx,
    //       span,
    //       symbol,
    //       self.declaration_context.get_declaring_symbol(),
    //       idx,
    //       self.file_name,
    //     );
    //
    //     if !processor_params.is_empty() {
    //       self.meta.processor_params.push((span, processor_params));
    //     }
    //   }
    // }

    match parent {
      Ancestor::Field(AnyNode::StaticMemberExpression(member_expr), "object") => {
        self.add_member_usage(span, member_expr.property.name.clone(), symbol);
      }

      Ancestor::Field(AnyNode::ComputedMemberExpression(member_expr), "object") => {
        if let Expression::StringLiteral(literal) = &member_expr.expression {
          self.add_member_usage(span, literal.value.clone(), symbol);
        } else {
          self.mark_identifier_as_unresolvable(span, symbol);
        }
      }

      Ancestor::Field(AnyNode::VariableDeclarator(declarator), "init") => {
        let mut usages = vec![];
        let declaration_context = DeclarationContext::from(declarator);

        if let DeclarationContext::List(list) = declaration_context {
          if list.is_empty() {
            self.mark_identifier_as_unresolvable(span, symbol);
            return;
          } else {
            for decl in list {
              if decl.from.is_empty() {
                self.mark_identifier_as_unresolvable(span, symbol);
                return;
              }

              match &decl.from[0] {
                PathPart::Member(ident) => {
                  usages.push((decl.symbol, ident.clone()));
                }
                PathPart::Index(_) => {}
              }
            }
          }
        }

        for (from, usage) in usages {
          self.add_unpacked_usage(span, symbol, usage.clone(), from);
        }
      }

      Ancestor::ListItem(AnyNode::CallExpression(call_expr), "arguments", _) => {
        if self.object_is_member(&call_expr.callee, "keys", symbols) {
          self.mark_identifier_as_reexport(span, symbol);
        } else {
          self.mark_identifier_as_unresolvable(span, symbol);
        }
      }

      _ => {
        self.mark_identifier_as_unresolvable(span, symbol);
      }
    }
  }
}
