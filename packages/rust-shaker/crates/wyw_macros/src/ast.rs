use cargo::core::{Package, PackageId, SourceId};
use cargo::sources::source::Source;
use cargo::sources::RegistrySource;
use cargo::util::cache_lock::CacheLockMode;
use cargo::util::context::GlobalContext;
use cargo::util::interning::InternedString;
use convert_case::{Case, Casing};
use proc_macro::TokenStream;
use quote::{format_ident, quote};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use syn::{
  AngleBracketedGenericArguments, Attribute, Field, File, GenericArgument, Item, ItemEnum,
  ItemMacro, ItemStruct, Type,
};

const REGISTRY: &str = "registry+https://github.com/rust-lang/crates.io-index";
const OXC_AST_VERSION: semver::Version = semver::Version::new(0, 30, 5);

#[derive(Debug)]
pub enum FieldType {
  Optional(String),
  OptionalVector(String),
  Simple(String),
  Vector(String),
  VectorOfOptional(String),
}

impl FieldType {
  pub fn get_name(&self) -> String {
    match &self {
      FieldType::Optional(t)
      | FieldType::OptionalVector(t)
      | FieldType::Simple(t)
      | FieldType::Vector(t)
      | FieldType::VectorOfOptional(t) => t.to_string(),
    }
  }

  pub fn as_any_node(&self) -> proc_macro2::TokenStream {
    let type_name = self.get_name();
    let type_ident = format_ident!("{}", type_name);
    quote! { AnyNode::#type_ident }
  }
}

#[derive(Debug)]
pub struct EnumType {
  pub variants: Vec<(String, String, bool)>,
  pub inherits: Vec<String>,
}

#[derive(Debug)]
pub enum InnerType {
  Enum(EnumType),
  Field(FieldType),
  Struct(Vec<AstType>),
}

#[derive(Debug)]
pub struct AstType {
  pub name: String,
  pub has_lifetime: bool,
  pub inner: InnerType,
}

fn parse_path_segment(segment: &syn::PathSegment) -> Vec<String> {
  let mut result = vec![segment.ident.to_string()];

  let rest = match &segment.arguments {
    syn::PathArguments::AngleBracketed(AngleBracketedGenericArguments { args, .. }) => {
      match (args.get(0), args.get(1), args.get(2)) {
        (
          Some(GenericArgument::Lifetime(_)),
          Some(GenericArgument::Type(Type::Path(path))),
          None,
        ) => parse_path_segment(path.path.segments.first().unwrap()),
        (Some(GenericArgument::Type(Type::Path(path))), None, None) => {
          parse_path_segment(path.path.segments.first().unwrap())
        }
        (Some(GenericArgument::Lifetime(_)), None, None) => vec!["life time".into()],
        _ => {
          dbg!(&args);
          vec![]
        }
      }
    }

    syn::PathArguments::None => vec![],

    unknown => {
      dbg!(unknown, segment);
      vec![]
    }
  };

  result.extend(rest);
  result
}

impl AstType {
  pub fn as_fn_name(&self, prefix: &str) -> proc_macro2::Ident {
    format_ident!("{prefix}_{}", self.name.to_case(Case::Snake))
  }

  pub fn as_full_name(&self) -> proc_macro2::TokenStream {
    let type_ident = self.as_ident();
    quote! { oxc::ast::ast::#type_ident }
  }

  pub fn as_ident(&self) -> proc_macro2::Ident {
    format_ident!("{}", self.name)
  }

  pub fn as_ref(&self) -> proc_macro2::TokenStream {
    let full_name = self.as_full_name();
    if self.has_lifetime {
      quote! { &'a #full_name<'a> }
    } else {
      quote! { &'a #full_name }
    }
  }
}

#[derive(Debug)]
pub struct Ast {
  pub types: Vec<AstType>,
}

impl Ast {
  pub fn new() -> Self {
    let mut ast = Self {
      types: Default::default(),
    };

    ast.parse_file("js.rs");
    ast.parse_file("jsx.rs");
    ast.parse_file("literal.rs");
    ast.parse_file("ts.rs");

    let mut all_defined = HashSet::new();

    let mut enums = HashMap::new();

    let mut has_unexpanded = true;
    while has_unexpanded {
      has_unexpanded = false;

      for t in &ast.types {
        match t.inner {
          InnerType::Enum(ref enum_type) => {
            if enum_type.inherits.is_empty() {
              all_defined.insert(t.name.to_string());
              enums.insert(t.name.to_string(), enum_type.variants.clone());
              continue;
            }

            if enum_type.inherits.iter().all(|i| enums.contains_key(i)) {
              let mut combined = vec![];
              combined.extend(enum_type.variants.clone());
              for inherit in enum_type
                .inherits
                .iter()
                .flat_map(|i| enums.get(i).unwrap())
              {
                combined.push(inherit.clone())
              }

              all_defined.insert(t.name.to_string());
              enums.insert(t.name.to_string(), combined);

              continue;
            }

            has_unexpanded = true;
          }

          InnerType::Field(_) => {
            panic!("Cannot be on top level");
          }

          InnerType::Struct(_) => {
            all_defined.insert(t.name.to_string());
          }
        }
      }
    }

    for t in &mut ast.types {
      match t.inner {
        InnerType::Enum(ref mut inner) => {
          inner.inherits.clear();
          inner.variants = enums.remove(&t.name).unwrap();
        }
        InnerType::Field(_) => {
          panic!("Cannot be on top level");
        }
        InnerType::Struct(ref mut nodes) => {
          nodes.retain(|n| match &n.inner {
            InnerType::Field(value) => all_defined.contains(&value.get_name()),
            _ => false,
          });
        }
      }
    }

    ast
  }

  fn has_ast_visit_attr(&self, attrs: &[Attribute]) -> bool {
    let meta_attr = attrs.iter().find(|&attr| {
      attr
        .meta
        .require_list()
        .is_ok_and(|list| list.path.get_ident().is_some_and(|ident| ident == "ast"))
    });

    meta_attr.is_some()
  }

  fn get_package(&self) -> Package {
    let ctx = GlobalContext::default().unwrap();
    let lock = ctx.acquire_package_cache_lock(CacheLockMode::Shared);
    if lock.is_ok() {
      let yanked_whitelist = HashSet::default();
      let source = SourceId::from_url(REGISTRY).unwrap();
      let registry = RegistrySource::remote(source, &yanked_whitelist, &ctx).unwrap();

      let oxc_name = InternedString::new("oxc_ast");
      let package_id = PackageId::new(oxc_name, OXC_AST_VERSION, registry.source_id());
      let boxed_registry = Box::new(registry);
      let package = boxed_registry.download_now(package_id, &ctx);
      return package.unwrap();
    }

    panic!("Couldn't lock the registry")
  }

  fn parse_field_value(&self, field: &Field) -> Option<(FieldType, bool)> {
    match &field.ty {
      Type::Path(syn::TypePath { path, .. }) => {
        let first = path.segments.first();
        first?;

        let first = first.unwrap();
        let types = parse_path_segment(first);

        let types: Vec<&str> = types.iter().map(|s| s.as_str()).collect();
        let slice = &types[..];

        match slice {
          ["Cell", ..] => None,
          ["Vec", name] => Some((FieldType::Vector(name.to_string()), false)),
          ["Vec", name, "life time"] => Some((FieldType::Vector(name.to_string()), true)),
          ["Vec", "Option", name] => Some((FieldType::VectorOfOptional(name.to_string()), false)),
          ["Vec", "Option", name, "life time"] => {
            Some((FieldType::VectorOfOptional(name.to_string()), true))
          }
          ["Box", name] => Some((FieldType::Simple(name.to_string()), false)),
          ["Box", name, "life time"] => Some((FieldType::Simple(name.to_string()), true)),
          ["Option", "Vec", name] => Some((FieldType::OptionalVector(name.to_string()), false)),
          ["Option", "Vec", name, "life time"] => {
            Some((FieldType::OptionalVector(name.to_string()), true))
          }
          ["Option", "Box", name] => Some((FieldType::Optional(name.to_string()), false)),
          ["Option", "Box", name, "life time"] => {
            Some((FieldType::Optional(name.to_string()), true))
          }
          ["Option", name] => Some((FieldType::Optional(name.to_string()), false)),
          ["Option", name, "life time"] => Some((FieldType::Optional(name.to_string()), true)),
          [name] => Some((FieldType::Simple(name.to_string()), false)),
          [name, "life time"] => Some((FieldType::Simple(name.to_string()), true)),
          unknown_path => {
            dbg!(unknown_path, first);
            None
          }
        }
      }

      Type::Reference(_) => None,

      unknown => {
        dbg!(unknown, field);
        None
      }
    }
  }

  fn parse_field(&self, field: &Field) -> Option<(String, FieldType, bool)> {
    match &field.ident {
      Some(ident) if ident == "scope_id" => None,
      Some(ident) if ident == "span" => None,
      Some(ident) if ident == "trailing_comma" => None,

      Some(ident) => self
        .parse_field_value(field)
        .map(|(t, l)| (ident.to_string(), t, l)),

      _ => None,
    }
  }

  fn parse_enum_variant(&self, variant: &syn::Variant) -> Option<(String, bool)> {
    let field = if let syn::Fields::Unnamed(field) = &variant.fields {
      field
    } else {
      return None;
    };

    if let Type::Path(path) = &field.unnamed[0].ty {
      let segment = &path.path.segments[0];
      if segment.ident != "Box" {
        // Non boxed
        return Some((segment.ident.to_string(), false));
      }

      if let syn::PathArguments::AngleBracketed(args) = &segment.arguments {
        if let Some(GenericArgument::Type(Type::Path(arg))) = &args.args.get(1) {
          let ident = &arg.path.segments[0].ident;
          return Some((ident.to_string(), true));
        }
      }
    }

    None
  }

  fn parse_enum(&mut self, item_enum: &ItemEnum) {
    if !self.has_ast_visit_attr(&item_enum.attrs) {
      return;
    }

    let enum_name = &item_enum.ident;
    let mut enum_type = EnumType {
      variants: vec![],
      inherits: vec![],
    };

    for variant in &item_enum.variants {
      let boxed_type = self.parse_enum_variant(variant);
      if let Some((type_name, boxed)) = boxed_type {
        enum_type
          .variants
          .push((variant.ident.to_string(), type_name.to_string(), boxed))
      } else {
        dbg!(&variant);
      }
    }

    self.types.push(AstType {
      name: enum_name.to_string(),
      has_lifetime: true,
      inner: InnerType::Enum(enum_type),
    });
  }

  fn parse_macro_source(&self, source: &str) -> Option<AstType> {
    let re_name = Regex::new(r#"pub\s*enum\s*([A-Z]\w+)<'a>"#).unwrap();
    let name = if let Some(res) = re_name.captures(source) {
      let name = &res[1];
      name.to_string()
    } else {
      return None;
    };

    let mut enum_type = EnumType {
      variants: vec![],
      inherits: vec![],
    };

    // Something like `VariableDeclaration(Box<'a, VariableDeclaration<'a>>)`
    let re_member = Regex::new(r#"([A-Z]\w+)\(Box<'a, ([A-Z]\w+)"#).unwrap();
    for captures in re_member.captures_iter(source) {
      let variant = captures[1].to_string();
      let type_name = captures[2].to_string();
      enum_type.variants.push((variant, type_name, true));
    }

    // Something like `EmptyExpression(JSXEmptyExpression)`
    let re_member = Regex::new(r#"([A-Z]\w+)\(([A-Z]\w+)\)"#).unwrap();
    for captures in re_member.captures_iter(source) {
      let variant = captures[1].to_string();
      let type_name = captures[2].to_string();
      enum_type.variants.push((variant, type_name, false));
    }

    // `@inherit Expression`
    let re_inherit = Regex::new(r#"@inherit\s*([A-Z]\w+)\b"#).unwrap();
    for captures in re_inherit.captures_iter(source) {
      let inherit = captures[1].to_string();
      enum_type.inherits.push(inherit);
    }

    Some(AstType {
      name,
      has_lifetime: true,
      inner: InnerType::Enum(enum_type),
    })
  }

  fn parse_macro(&mut self, item_macro: &ItemMacro) {
    if !item_macro
      .mac
      .path
      .segments
      .first()
      .is_some_and(|s| s.ident == "inherit_variants")
    {
      return;
    }

    let tokens = &item_macro.mac.tokens;
    let source = tokens.to_string();
    if let Some(t) = self.parse_macro_source(&source) {
      self.types.push(t);
    } else {
      dbg!(source);
    }
  }

  fn parse_struct(&mut self, item_struct: &ItemStruct) {
    if !self.has_ast_visit_attr(&item_struct.attrs) {
      return;
    }

    let struct_name = &item_struct.ident;

    let mut fields = vec![];

    for field in &item_struct.fields {
      match self.parse_field(field) {
        Some((name, value, has_lifetime)) => {
          // Should start from capital
          if value
            .get_name()
            .starts_with(|ch: char| ch.is_ascii_lowercase())
          {
            continue;
          }

          fields.push(AstType {
            name,
            has_lifetime,
            inner: InnerType::Field(value),
          });
        }

        None => continue,
      };
    }

    self.types.push(AstType {
      name: struct_name.to_string(),
      has_lifetime: item_struct.generics.lifetimes().count() > 0,
      inner: InnerType::Struct(fields),
    });
  }

  fn parse_file(&mut self, file: &str) {
    let pkg = self.get_package();
    let pkg_root = pkg.root();
    let path = pkg_root.join("src").join("ast").join(file);
    let file_content = std::fs::read_to_string(path).unwrap();
    let stream: TokenStream = file_content.parse().unwrap();
    let file_ast: File = syn::parse(stream).expect("Invalid block");
    for item in file_ast.items {
      match item {
        Item::Struct(item_struct) => {
          self.parse_struct(&item_struct);
        }
        Item::Enum(item_enum) => {
          self.parse_enum(&item_enum);
        }
        Item::Macro(item_macro) => {
          self.parse_macro(&item_macro);
        }
        Item::Use(_) | Item::Const(_) => {
          // Ignore it
        }
        unsupported => {
          dbg!(unsupported);
        }
      }
    }
  }
}
