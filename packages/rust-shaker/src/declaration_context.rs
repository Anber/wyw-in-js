use crate::meta::symbol::Symbol;
use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc_semantic::SymbolTable;

#[derive(Clone, Debug)]
pub enum PathPart<'a> {
  Index(usize),
  Member(Atom<'a>),
}

#[derive(Debug)]
pub struct DeclaredIdent<'a> {
  pub symbol: &'a Symbol<'a>,
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
  allocator: &'a Allocator,
  symbols: &SymbolTable,
  pattern: &BindingPatternKind<'a>,
  stack: &mut Vec<PathPart<'a>>,
) -> Vec<DeclaredIdent<'a>> {
  match pattern {
    BindingPatternKind::BindingIdentifier(ident) => vec![DeclaredIdent {
      symbol: Symbol::new(
        allocator,
        symbols,
        ident.symbol_id.get().expect("Expected a symbol id"),
      ),
      from: stack.clone(),
    }],

    BindingPatternKind::ArrayPattern(array) => array
      .elements
      .iter()
      .enumerate()
      .filter_map(|(idx, elem)| match elem {
        Some(elem) => {
          stack.push(PathPart::Index(idx));
          let res = unfold(allocator, symbols, &elem.kind, stack);
          stack.pop();
          Some(res)
        }

        None => None,
      })
      .flatten()
      .collect(),

    BindingPatternKind::AssignmentPattern(assigment) => {
      unfold(allocator, symbols, &assigment.left.kind, stack)
    }

    BindingPatternKind::ObjectPattern(object) => {
      let mut res = vec![];

      for prop in &object.properties {
        let key = get_property_key(prop);
        if key.is_none() {
          // FIXME: It's okay if we will not try to use this context later
          continue;
        }
        stack.push(PathPart::Member(key.unwrap().clone()));
        res.extend(unfold(allocator, symbols, &prop.value.kind, stack));
        stack.pop();
      }

      if let Some(ident) = &object.rest {
        res.extend(unfold(allocator, symbols, &ident.argument.kind, stack));
      }

      res
    }
  }
}

impl<'a> DeclarationContext<'a> {
  pub fn from(
    allocator: &'a Allocator,
    symbols: &SymbolTable,
    node: &VariableDeclarator<'a>,
  ) -> Self {
    match &node.id.kind {
      BindingPatternKind::BindingIdentifier(ident) => {
        DeclarationContext::List(vec![DeclaredIdent {
          symbol: Symbol::new(
            allocator,
            symbols,
            ident.symbol_id.get().expect("Expected a symbol id"),
          ),
          from: vec![],
        }])
      }

      pattern => DeclarationContext::List(unfold(allocator, symbols, pattern, &mut vec![])),
    }
  }

  pub(crate) fn get_declaring_symbol(&self) -> Option<Symbol<'a>> {
    match &self {
      DeclarationContext::List(list) if list.len() == 1 => Some(list[0].symbol.clone()),
      _ => None,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use oxc::allocator::Allocator;
  use oxc::parser::{ParseOptions, Parser};
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

    let semantic_ret = oxc_semantic::SemanticBuilder::new(&source_text)
      .build_module_record(path, program)
      .with_check_syntax_error(true)
      .with_trivias(parser_ret.trivias)
      .build(program);

    let (symbols, _scopes) = semantic_ret.semantic.into_symbol_table_and_scope_tree();

    if let Statement::VariableDeclaration(decl) = &program.body[0] {
      return DeclarationContext::from(&allocator, &symbols, &decl.declarations[0])
        .to_debug_string();
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
