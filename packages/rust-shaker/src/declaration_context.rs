use oxc::ast::ast::*;

#[derive(Clone, Debug)]
pub enum PathPart<'a> {
  Identifier(Atom<'a>),
  Index(usize),
}

#[derive(Debug)]
pub struct DeclaredIdent<'a> {
  pub name: Atom<'a>,
  pub from: Vec<PathPart<'a>>,
}

#[derive(Debug)]
pub enum DeclarationContext<'a> {
  None,
  List(Vec<DeclaredIdent<'a>>),
}

fn get_property_key<'a, 'b>(prop: &'b BindingProperty<'a>) -> &'b Atom<'a> {
  match &prop.key {
    PropertyKey::StaticIdentifier(ident) => &ident.name,

    _ => {
      // Unknown type of property name. Throw an error.
      todo!("Unsupported type of property name. Only static identifiers are supported.");
    }
  }
}

fn unfold<'a>(
  pattern: &BindingPatternKind<'a>,
  stack: &mut Vec<PathPart<'a>>,
) -> Vec<DeclaredIdent<'a>> {
  match pattern {
    BindingPatternKind::BindingIdentifier(ident) => vec![DeclaredIdent {
      name: ident.name.clone(),
      from: stack.clone(),
    }],

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
        stack.push(PathPart::Identifier(key.clone()));
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
      BindingPatternKind::BindingIdentifier(ident) => {
        DeclarationContext::List(vec![DeclaredIdent {
          name: ident.name.clone(),
          from: vec![],
        }])
      }

      pattern => DeclarationContext::List(unfold(pattern, &mut vec![])),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use oxc::allocator::{Allocator, CloneIn};
  use oxc::parser::{ParseOptions, Parser};
  use std::path::Path;

  fn prepare<'a>(allocator: &'a Allocator, pattern: &'a str) -> VariableDeclarator<'a> {
    let source_text = format!("const {} = obj;", pattern);

    let path = Path::new("test.js");
    let source_type = SourceType::from_path(path).unwrap();

    let ret = Parser::new(allocator, &source_text, source_type)
      .with_options(ParseOptions {
        parse_regular_expression: true,
        ..ParseOptions::default()
      })
      .parse();

    assert!(ret.errors.is_empty());

    if let Statement::VariableDeclaration(decl) = &ret.program.body[0] {
      return decl.declarations[0].clone_in(allocator);
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
                PathPart::Identifier(ident) => ident.to_string(),
                PathPart::Index(idx) => idx.to_string(),
              })
              .collect::<Vec<String>>()
              .join(".");

            format!("{}:{}", ident.name, from)
          })
          .collect::<Vec<String>>()
          .join(", "),
      }
    }
  }

  #[test]
  fn test_simple_ident() {
    // const a = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "a");

    assert_eq!(DeclarationContext::from(&node).to_debug_string(), "a:");
  }

  #[test]
  fn test_simple_array() {
    // const [a, b] = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "[a, b]");

    assert_eq!(
      DeclarationContext::from(&node).to_debug_string(),
      "a:0, b:1"
    );
  }

  #[test]
  fn test_nested_array() {
    // const [a, [b, c]] = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "[a, [b, c]]");

    assert_eq!(
      DeclarationContext::from(&node).to_debug_string(),
      "a:0, b:1.0, c:1.1"
    );
  }

  #[test]
  fn test_simple_object() {
    // const {a, b} = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "{a, b}");

    assert_eq!(
      DeclarationContext::from(&node).to_debug_string(),
      "a:a, b:b"
    );
  }

  #[test]
  fn test_nested_object() {
    // const {a, b: {b, c}} = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "{a, b: {b, c}}");

    assert_eq!(
      DeclarationContext::from(&node).to_debug_string(),
      "a:a, b:b.b, c:b.c"
    );
  }

  #[test]
  fn test_rest_object() {
    // const {a, ...rest} = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "{a, ...rest}");

    assert_eq!(
      DeclarationContext::from(&node).to_debug_string(),
      "a:a, rest:"
    );
  }

  #[test]
  fn test_with_default() {
    // const { a = 1 } = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "{ a = 1 }");

    assert_eq!(DeclarationContext::from(&node).to_debug_string(), "a:a");
  }

  #[test]
  fn test_mixed() {
    // const {a, b = 1, c: [c, d] = [], ...rest} = obj;
    let allocator = Allocator::default();
    let node = prepare(&allocator, "{a, b = 1, c: [c, d] = [], ...rest}");

    assert_eq!(
      DeclarationContext::from(&node).to_debug_string(),
      "a:a, b:b, c:c.0, d:c.1, rest:"
    );
  }
}
