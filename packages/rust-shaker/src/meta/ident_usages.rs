use crate::declaration_context::{DeclarationContext, PathPart};
use crate::meta::import::{Import, Processor, Source};
use crate::meta::processor_params::ProcessorParams;
use crate::meta::symbol::Symbol;
use crate::meta::MetaCollector;
use normalize_path::NormalizePath;
use oxc::span::{Atom, Span};
use oxc_traverse::{Ancestor, TraverseCtx};

#[derive(Debug)]
pub enum IdentUsage<'a> {
  MemberExpression(Span, &'a Symbol<'a>, Atom<'a>),
  ReexportAll(Span),
  Uncertain(Span),
  Unpacked {
    span: Span,
    local: &'a Symbol<'a>,
    path: Atom<'a>,
    symbol_id: &'a Symbol<'a>,
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

impl<'a> MetaCollector<'a> {
  fn add_usage(&mut self, usage: IdentUsage<'a>, symbol_id: &'a Symbol<'a>) {
    let usages = self.identifier_usages.get_mut(&symbol_id);
    match usages {
      None => {
        self.identifier_usages.insert(symbol_id, vec![usage]);
      }

      Some(v) => {
        v.push(usage);
      }
    }
  }

  pub fn add_member_usage(&mut self, span: &Span, usage: Atom<'a>, symbol_id: &'a Symbol<'a>) {
    let usage = IdentUsage::MemberExpression(*span, symbol_id, usage);
    self.add_usage(usage, symbol_id);
  }

  fn add_unpacked_usage(
    &mut self,
    span: &Span,
    to: &'a Symbol<'a>,
    path: Atom<'a>,
    from: &'a Symbol<'a>,
  ) {
    let usage = IdentUsage::Unpacked {
      span: *span,
      local: to,
      path,
      symbol_id: from,
    };

    self.add_usage(usage, to);
  }

  fn mark_identifier_as_unresolvable(&mut self, span: &Span, symbol_id: &'a Symbol<'a>) {
    let usage = IdentUsage::Uncertain(*span);
    self.add_usage(usage, symbol_id);
  }

  fn mark_identifier_as_reexport(&mut self, span: &Span, symbol_id: &'a Symbol<'a>) {
    let usage = IdentUsage::ReexportAll(*span);
    self.add_usage(usage, symbol_id);
  }

  pub fn resolve_identifier_usage(
    &mut self,
    ctx: &TraverseCtx<'a>,
    span: &Span,
    symbol: &'a Symbol<'a>,
  ) {
    if ctx.ancestors().any(|ancestor| ancestor.is_via_ts_type()) {
      return;
    }

    let import = self.meta.imports.find_by_symbol(symbol);

    if import.is_some() {
      let mut import = import.unwrap();

      // If the source is unresolved, we have to resolve it first
      if let Import::Named {
        source: Source::Unresolved(source),
        ..
      } = import
      {
        let resolved = self.resolver.resolve(self.meta.directory, source);
        if let Ok(resolution) = resolved {
          // FIXME: Why borrow checker doesn't allow to use `resolved.path()`?
          let resolution = self.allocator.alloc(resolution);
          let path = self.allocator.alloc(resolution.path());
          import = import.set_resolved(path);

          if let Some(package_json) = resolution.package_json() {
            let raw_json = package_json.raw_json();

            if let Some(obj) = raw_json.as_object() {
              if let Some(wyw) = obj.get("wyw-in-js") {
                if let Some(tags) = wyw.get("tags") {
                  if let Some(tag) = tags.get(symbol.name) {
                    // processor here is a relative path to the processor file
                    let processor = tag.as_str().unwrap();

                    let full_path = package_json
                      .path
                      .parent()
                      .map(|p| p.join(processor).normalize())
                      .unwrap();

                    import.set_processor(full_path);
                  }
                }
              }
            }
          }
        }
      }

      if let Import::Named {
        processor: Processor::Resolved(processor),
        source: Source::Resolved(source),
        ..
      } = import
      {
        let idx = self.meta.processor_params.len();
        let (span, processor_params) = ProcessorParams::from_ident(
          ctx,
          span,
          symbol,
          self.declaration_context.get_declaring_symbol(),
          idx,
          self.file_name,
        );

        if !processor_params.is_empty() {
          self.meta.processor_params.push((span, processor_params));
        }
      }
    }

    match ctx.parent() {
      Ancestor::StaticMemberExpressionObject(member_expr) => {
        self.add_member_usage(span, member_expr.property().name.clone(), symbol);
      }

      Ancestor::ComputedMemberExpressionObject(_) => {
        self.mark_identifier_as_unresolvable(span, symbol);
      }

      Ancestor::VariableDeclaratorInit(_node) => {
        let mut usages = vec![];
        if let DeclarationContext::List(list) = &self.declaration_context {
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

      Ancestor::CallExpressionArguments(call_expr) => {
        let callee = call_expr.callee();
        if self.object_is_member(callee, "keys", ctx) {
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
