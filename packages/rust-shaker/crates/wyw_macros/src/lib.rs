use crate::ast::{Ast, AstType, InnerType};
use crate::traverse::create_hook_fn;
use convert_case::{Case, Casing};
use proc_macro::TokenStream;
use quote::{format_ident, quote, ToTokens};
use syn::{Block, ImplItem, ImplItemFn, Item, ItemImpl};
use yaml_rust::{Yaml, YamlLoader};

mod ast;
mod traverse;

const YAML_CONTENT: &str = include_str!("../rules.yaml");

fn add_fn_to_impl(
  item: &mut ItemImpl,
  type_name: &String,
  body: Vec<proc_macro2::TokenStream>,
  with_lifetime: bool,
) {
  let type_ident = format_ident!("{}", type_name);

  let node_type = if with_lifetime {
    quote! { #type_ident<'a> }
  } else {
    quote! { #type_ident }
  };

  let fn_name_ident = format_ident!("exit_{}", type_name.to_case(Case::Snake));

  let existed = item.items.iter_mut().find(|f| {
    if let ImplItem::Fn(f) = f {
      return f.sig.ident == fn_name_ident;
    }

    false
  });

  if let Some(ImplItem::Fn(existed)) = existed {
    let extension: Block = syn::parse(
      quote! {
        {
          #(#body)*
        }
      }
      .into(),
    )
    .expect("Invalid block");

    for stmt in extension.stmts {
      existed.block.stmts.push(stmt);
    }

    return;
  }

  let stream = quote! {
    fn #fn_name_ident(
      &mut self,
      node: &mut #node_type,
      ctx: &mut TraverseCtx<'a>,
    ) {
      #(#body)*
    }
  };

  let method: ImplItemFn = syn::parse(stream.into()).expect("Invalid expression");
  item.items.push(ImplItem::Fn(method));
}

fn get_action(key: &String, action_name: &String, cfg: &Yaml) -> proc_macro2::TokenStream {
  match action_name.as_str() {
    "remove" => quote! {
      self.mark_for_delete(node.span());
    },

    "replace" => {
      let with = cfg["with"].as_str().expect("with must be string");
      let path = format_ident!("{}", cfg["path"].as_str().expect("path must be string"));

      if with == "undefined" {
        quote! {
          node.#path = ctx.ast.expression_identifier_reference(node.#path.span(), "undefined");
        }
      } else {
        let with = format_ident!("{}", with);
        quote! {
          self.mark_for_replace(node.span(), node.#with.clone_in(ctx.ast.allocator));
        }
      }
    }

    "todo" => {
      let msg = format!("Action {key} is not specified");
      quote! {
        todo!(#msg);
      }
    }

    _ => {
      let msg = format!("{action_name} for {key} is not implemented");
      quote! {
        unimplemented!(#msg);
      }
    }
  }
}

fn get_action_stmt(key: &String, cfg: &Yaml) -> proc_macro2::TokenStream {
  let action_name = &cfg["action"];
  let path = &cfg["path"];

  if let (Yaml::String(action_name), Yaml::String(path)) = (action_name, path) {
    let action = get_action(key, action_name, cfg);
    let key = format_ident!("{}", path);
    let cond_stream = quote! {
      if self.is_for_delete(node.#key.span()) {
        #action
      }
    };

    cond_stream
  } else {
    panic!("Unexpected config for {key}: {:?}", cfg);
  }
}

fn get_actions(key: &String, cfg: &Yaml) -> Vec<proc_macro2::TokenStream> {
  let skip = &cfg["skip"];
  if let Yaml::Boolean(true) = skip {
    return vec![];
  }

  match cfg {
    Yaml::Array(actions) => {
      let mut actions_stream = vec![];
      for action in actions {
        actions_stream.push(get_action_stmt(key, action));
      }

      actions_stream
    }

    Yaml::String(msg) if msg == "Not implemented" => {
      let msg = format!("Visitor for {key} is not implemented");
      vec![quote! { todo!(#msg) }]
    }

    cfg => {
      panic!("Unexpected config for {key}: {:?}", cfg);
    }
  }
}

#[proc_macro_attribute]
pub fn shaker_from_cfg(_args: TokenStream, input: TokenStream) -> TokenStream {
  let config = YamlLoader::load_from_str(YAML_CONTENT);
  let yaml = match config {
    Ok(yaml) => yaml,
    Err(e) => {
      panic!("{}", e)
    }
  };

  let doc = &yaml[0];
  let rules = &doc["rules"];

  let input = syn::parse_macro_input!(input as Item);

  let mut item = if let Item::Impl(i) = input {
    i
  } else {
    panic!("Unexpected attribute target. Should be impl.")
  };

  for pair in rules.as_hash().expect("rules expected to be a hash") {
    if let (Yaml::String(key), cfg) = pair {
      let lifetime = !matches!(&cfg["lifetime"], Yaml::Boolean(false));

      add_fn_to_impl(&mut item, key, get_actions(key, cfg), lifetime);
    } else {
      panic!("Unexpected type of key {:?}", pair.0)
    }
  }

  item.to_token_stream().into()
}

fn add_hook_fn(prefix: &str, item: &mut ItemImpl, node_type: &AstType) {
  let stream = create_hook_fn(prefix, node_type, "");

  let method: ImplItemFn = syn::parse(stream.into()).expect("Invalid expression");
  item.items.push(ImplItem::Fn(method));
}

fn add_exit_and_enter_fns(item: &mut ItemImpl, node_type: &AstType) {
  add_hook_fn("enter", item, node_type);
  add_hook_fn("exit", item, node_type);
}

#[proc_macro_attribute]
pub fn traverse(_args: TokenStream, input: TokenStream) -> TokenStream {
  let input = syn::parse_macro_input!(input as Item);
  let mut impl_item = if let Item::Impl(i) = input {
    i
  } else {
    panic!("Unexpected attribute target. Should be impl.")
  };

  let ast = Ast::new();

  for node_type in &ast.types {
    if matches!(node_type.inner, InnerType::Struct(_)) {
      add_exit_and_enter_fns(&mut impl_item, node_type);
    }
  }

  impl_item.to_token_stream().into()
}

#[proc_macro]
pub fn define(input: TokenStream) -> TokenStream {
  traverse::define(input)
}
