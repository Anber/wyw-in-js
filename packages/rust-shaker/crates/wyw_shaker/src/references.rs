use crate::replacements::Replacements;
use fast_traverse::symbol::Symbol;
use oxc::allocator::Allocator;
use oxc::ast::ast::{Expression, IdentifierReference, MemberExpression};
use oxc::ast::AstKind;
use oxc::span::{GetSpan, Span};
use oxc::syntax::reference::ReferenceFlags;
use oxc_semantic::{AstNode, AstNodes, NodeId, Semantic};
use std::collections::HashMap;
use wyw_processor::replacement_value::ReplacementValue;

#[derive(Clone, Debug)]
pub struct Reference {
  pub flags: ReferenceFlags,
  pub span: Span,
}

#[derive(Clone, Debug, Default)]
pub struct References<'a> {
  pub map: HashMap<&'a Symbol, Vec<Reference>>,
}

fn get_parent_node<'a>(nodes: &'a AstNodes, node_id: NodeId) -> &'a AstNode<'a> {
  let parent = nodes.parent_node(node_id);
  parent.expect("Parent node should exist")
}

fn is_mut_call(node: &AstNode) -> bool {
  // Such as `Object.assign(obj, { key: value })`
  if let AstKind::CallExpression(call_exp) = node.kind() {
    if let Expression::StaticMemberExpression(member_exp) = &call_exp.callee {
      if let Expression::Identifier(ident) = &member_exp.object {
        return ident.name == "Object" && member_exp.property.name == "assign";
      }
    }
  }

  false
}

fn is_write_ref(nodes: &AstNodes, node: &IdentifierReference, node_id: NodeId) -> bool {
  let parent = get_parent_node(nodes, node_id);

  // Such as `obj.key = value`
  if let AstKind::MemberExpression(MemberExpression::StaticMemberExpression(member_exp)) =
    parent.kind()
  {
    if let Expression::Identifier(ident) = &member_exp.object {
      if ident.name != node.name {
        return false;
      }

      let parent = get_parent_node(nodes, parent.id());
      return match parent.kind() {
        AstKind::SimpleAssignmentTarget(_) => return true,
        _ => false,
      };
    }
  }

  if let AstKind::Argument(_arg) = parent.kind() {
    let parent = get_parent_node(nodes, parent.id());
    return is_mut_call(parent);
  }

  false
}

impl<'a> References<'a> {
  pub fn add(&mut self, symbol: &'a Symbol, reference: Reference) {
    if let std::collections::hash_map::Entry::Vacant(e) = self.map.entry(symbol) {
      e.insert(vec![reference]);
    } else {
      self.map.get_mut(&symbol).unwrap().push(reference);
    }
  }

  pub fn get(&self, symbol: &'a Symbol) -> Option<&Vec<Reference>> {
    self.map.get(symbol)
  }

  pub fn apply_replacements(&mut self, replacements: &Replacements) {
    let mut moved_spans = vec![];
    for replacement in &replacements.list {
      match replacement.value {
        ReplacementValue::Del => {}
        ReplacementValue::Span(from) => {
          moved_spans.push((from, replacement.span));
        }
        ReplacementValue::Str(_) => {}
        ReplacementValue::Undefined => {}
      }
    }

    let mut new_refs = vec![];
    for (&symbol, refs) in self.map.iter_mut() {
      for reference in &*refs {
        for (from, to) in &moved_spans {
          if reference.span.start >= from.start && reference.span.end <= from.end {
            let delta: i32 = from.start as i32 - reference.span.start as i32;
            new_refs.push((
              symbol,
              Span::new(
                (to.start as i32 - delta) as u32,
                (to.end as i32 - delta) as u32,
              ),
              reference.flags,
            ));
          }
        }
      }

      refs.retain(|reference| !replacements.has(reference.span));
    }

    for (symbol, span, flags) in new_refs {
      self
        .map
        .get_mut(symbol)
        .unwrap()
        .push(Reference { flags, span });
    }
  }

  pub fn from_semantic(semantic: &Semantic, allocator: &'a Allocator) -> Self {
    let symbols = semantic.symbols();
    let nodes = semantic.nodes();

    let mut references = Self::default();

    for reference in &symbols.references {
      let symbol_id = reference.symbol_id();
      let decl_node = symbol_id
        .and_then(|id| symbols.declarations.get(id))
        .map(|&decl| nodes.get_node(decl));
      if decl_node.is_none() {
        // It's a reference to a built-in or unknown symbol
        continue;
      }

      let decl_node = decl_node.unwrap();
      let symbol_id = symbol_id.unwrap();
      let symbol = allocator.alloc(Symbol::new(symbols, symbol_id, decl_node.span()));
      let node_id = reference.node_id();
      let node = nodes.get_node(node_id);
      let node_kind = node.kind();

      let flags = if let AstKind::IdentifierReference(ref_node) = node_kind {
        if is_write_ref(nodes, ref_node, node_id) {
          reference.flags().union(ReferenceFlags::Write)
        } else {
          reference.flags()
        }
      } else {
        reference.flags()
      };

      references.add(
        symbol,
        Reference {
          flags,
          span: node_kind.span(),
        },
      );
    }

    references
  }
}

#[cfg(test)]
mod test {
  use super::*;
  use indoc::indoc;
  use oxc::allocator::Allocator;
  use oxc::parser::{ParseOptions, Parser};
  use oxc::span::SourceType;
  use oxc_semantic::Semantic;
  use std::path::Path;

  fn parse<'a>(source: &'a str, allocator: &'a Allocator) -> Semantic<'a> {
    let path = Path::new("test.ts");
    let source_type = SourceType::from_path(path).unwrap();

    let parser_ret = Parser::new(allocator, source, source_type)
      .with_options(ParseOptions {
        parse_regular_expression: true,
        ..ParseOptions::default()
      })
      .parse();

    let semantic_ret = oxc_semantic::SemanticBuilder::new(source)
      .build_module_record(path, &parser_ret.program)
      .with_check_syntax_error(true)
      .with_trivias(parser_ret.trivias)
      .build(&parser_ret.program);

    semantic_ret.semantic
  }

  fn annotate(source: &str) -> String {
    let allocator = Allocator::default();
    let semantic = parse(source, &allocator);
    let references = References::from_semantic(&semantic, &allocator);

    let mut flat_refs = references
      .map
      .iter()
      .flat_map(|(_symbol, refs)| refs)
      .collect::<Vec<_>>();

    flat_refs.sort_by(|a, b| a.span.start.cmp(&b.span.start));

    let mut chunks = vec![];
    let mut last_pos: usize = 0;
    for reference in flat_refs {
      let start = reference.span.start as usize;
      let end = reference.span.end as usize;
      if last_pos != start {
        chunks.push(source[last_pos..end].to_string());
      }

      let mut flags = vec![];
      if reference.flags.contains(ReferenceFlags::Read) {
        flags.push("Read");
      }

      if reference.flags.contains(ReferenceFlags::Write) {
        flags.push("Write");
      }

      chunks.push(format!("/* {} */", flags.join(" | ")));

      last_pos = end;
    }

    chunks.push(source[last_pos..].to_string());

    chunks.join("")
  }

  #[test]
  fn test_object_assign() {
    assert_eq!(
      annotate(indoc! {r#"
        const classes = {};
        Object.assign(
          classes,
          {
            disabled: "disabled",
          }
        );
        export { classes };
      "#}),
      indoc! {r#"
        const classes = {};
        Object.assign(
          classes/* Read | Write */,
          {
            disabled: "disabled",
          }
        );
        export { classes/* Read */ };
      "#}
    )
  }

  #[test]
  fn test_assign_to_prop() {
    assert_eq!(
      annotate(indoc! {r#"
        const obj = {};
        obj.key = "value";
        export const key = obj.key;
      "#}),
      indoc! {r#"
        const obj = {};
        obj/* Read | Write */.key = "value";
        export const key = obj/* Read */.key;
      "#}
    )
  }
}
