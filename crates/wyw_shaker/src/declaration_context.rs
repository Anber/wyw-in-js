use oxc::ast::ast::*;
use wyw_traverse::symbol::Symbol;
use wyw_traverse::{Ancestor, AnyNode};

#[derive(Clone, Debug)]
pub enum PathPart<'a> {
  Index(usize),
  Member(Atom<'a>),
}

#[derive(Debug)]
pub struct DeclaredIdent<'a> {
  pub symbol: Symbol,
  pub from: Vec<PathPart<'a>>,
}

#[derive(Debug)]
pub enum DeclarationContext<'a> {
  None,
  List(Vec<DeclaredIdent<'a>>),
}

fn get_property_key<'a, 'b>(prop: &'b BindingProperty<'a>) -> Option<&'b Atom<'a>> {
  match &prop.key {
    PropertyKey::StaticIdentifier(ident) => Some(&ident.name),

    _ => None,
  }
}

fn unfold<'a>(
  pattern: &BindingPatternKind<'a>,
  stack: &mut Vec<PathPart<'a>>,
) -> Vec<DeclaredIdent<'a>> {
  match pattern {
    BindingPatternKind::BindingIdentifier(ident) => {
      let symbol_id = ident.symbol_id.get().expect("Expected a symbol id");
      vec![DeclaredIdent {
        symbol: Symbol::new_with_name(ident.name.to_string(), symbol_id, ident.span),
        from: stack.clone(),
      }]
    }

    BindingPatternKind::ArrayPattern(array) => array
      .elements
      .iter()
      .enumerate()
      .filter_map(|(idx, elem)| match elem {
        Some(elem) => {
          stack.push(PathPart::Index(idx));
          let res = unfold(&elem.kind, stack);
          stack.pop();
          Some(res)
        }

        None => None,
      })
      .flatten()
      .collect(),

    BindingPatternKind::AssignmentPattern(assigment) => unfold(&assigment.left.kind, stack),

    BindingPatternKind::ObjectPattern(object) => {
      let mut res = vec![];

      for prop in &object.properties {
        let key = get_property_key(prop);
        if key.is_none() {
          // FIXME: It's okay if we will not try to use this context later
          continue;
        }
        stack.push(PathPart::Member(key.unwrap().clone()));
        res.extend(unfold(&prop.value.kind, stack));
        stack.pop();
      }

      if let Some(ident) = &object.rest {
        res.extend(unfold(&ident.argument.kind, stack));
      }

      res
    }
  }
}

impl<'a> DeclarationContext<'a> {
  pub fn from(node: &VariableDeclarator<'a>) -> Self {
    match &node.id.kind {
      BindingPatternKind::BindingIdentifier(ident) => DeclarationContext::List({
        let symbol_id = ident.symbol_id.get().expect("Expected a symbol id");
        let decl = ident.span;

        vec![DeclaredIdent {
          symbol: Symbol::new_with_name(ident.name.to_string(), symbol_id, decl),
          from: vec![],
        }]
      }),

      pattern => DeclarationContext::List(unfold(pattern, &mut vec![])),
    }
  }

  pub fn from_ancestors(ancestors: &[Ancestor<'a>]) -> Self {
    let decl = ancestors.iter().rev().find_map(|ancestor| match ancestor {
      Ancestor::Field(AnyNode::VariableDeclarator(decl), _) => Some(decl),
      _ => None,
    });

    match decl {
      None => DeclarationContext::None,
      Some(decl) => DeclarationContext::from(decl),
    }
  }

  // pub(crate) fn get_declaring_symbol(&self) -> Option<Symbol> {
  //   match &self {
  //     DeclarationContext::List(list) if list.len() == 1 => Some(list[0].symbol.clone()),
  //     _ => None,
  //   }
  // }
}

#[cfg(test)]
mod tests {
  use super::*;
  use oxc::allocator::Allocator;
  use oxc::parser::{ParseOptions, Parser};
  use oxc_semantic::SemanticBuilder;
  use std::path::Path;

  fn run(pattern: &str) -> String {
    let allocator = Allocator::default();

    let source_text = format!("const {} = obj;", pattern);

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

    SemanticBuilder::new()
      .build_module_record(path, program)
      .with_check_syntax_error(true)
      .build(program);

    if let Statement::VariableDeclaration(decl) = &program.body[0] {
      return DeclarationContext::from(&decl.declarations[0]).to_debug_string();
    }

    panic!("Expected a variable declaration statement");
  }

  impl<'a> DeclarationContext<'a> {
    fn to_debug_string(self) -> String {
      match self {
        DeclarationContext::None => "".to_string(),

        DeclarationContext::List(list) => list
          .iter()
          .map(|ident| {
            let from = ident
              .from
              .iter()
              .map(|part| match part {
                PathPart::Member(ident) => ident.to_string(),
                PathPart::Index(idx) => idx.to_string(),
              })
              .collect::<Vec<String>>()
              .join(".");

            format!("{}:{}", ident.symbol.name, from)
          })
          .collect::<Vec<String>>()
          .join(", "),
      }
    }
  }

  #[test]
  fn test_simple_ident() {
    // const a = obj;
    assert_eq!(run("a"), "a:");
  }

  #[test]
  fn test_simple_array() {
    // const [a, b] = obj;
    assert_eq!(run("[a, b]"), "a:0, b:1");
  }

  #[test]
  fn test_nested_array() {
    // const [a, [b, c]] = obj;
    assert_eq!(run("[a, [b, c]]"), "a:0, b:1.0, c:1.1");
  }

  #[test]
  fn test_simple_object() {
    // const {a, b} = obj;
    assert_eq!(run("{a, b}"), "a:a, b:b");
  }

  #[test]
  fn test_nested_object() {
    // const {a, b: {b, c}} = obj;
    assert_eq!(run("{a, b: {b, c}}"), "a:a, b:b.b, c:b.c");
  }

  #[test]
  fn test_rest_object() {
    // const {a, ...rest} = obj;
    assert_eq!(run("{a, ...rest}"), "a:a, rest:");
  }

  #[test]
  fn test_with_default() {
    // const {a = 1} = obj;
    assert_eq!(run("{a = 1}"), "a:a");
  }

  #[test]
  fn test_mixed() {
    // const {a, b = 1, c: [c, d] = [], ...rest} = obj;
    assert_eq!(
      run("{a, b = 1, c: [c, d] = [], ...rest}"),
      "a:a, b:b, c:c.0, d:c.1, rest:"
    );
  }
}
