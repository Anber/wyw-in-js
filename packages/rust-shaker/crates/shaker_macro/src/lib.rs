use crate::ast::{Ast, EnumType, FieldType, NodeType};
use convert_case::{Case, Casing};
use proc_macro::TokenStream;
use quote::{format_ident, quote, ToTokens};
use syn::{Block, ImplItem, ImplItemFn, Item, ItemImpl};
use yaml_rust::{Yaml, YamlLoader};

mod ast;

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

fn create_hook_fn(
  prefix: &str,
  node_type: &NodeType,
  return_type: &str,
) -> proc_macro2::TokenStream {
  let fn_name_ident = node_type.as_fn_name(prefix);
  let node_ref = node_type.as_ref();

  if return_type.is_empty() {
    quote! {
      fn #fn_name_ident(
        &mut self,
        node: #node_ref,
        ctx: &mut TraverseCtx<'a>,
      ) {}
    }
  } else {
    let return_type_ident = format_ident!("{}", return_type);
    quote! {
      fn #fn_name_ident(
        &mut self,
        node: #node_ref,
        ctx: &mut TraverseCtx<'a>,
      ) -> #return_type_ident {
        #return_type_ident::default()
      }
    }
  }
}

fn create_enum_walk_fn_body(node_type: &EnumType) -> proc_macro2::TokenStream {
  let enum_name = node_type.as_full_name();

  let mut variants_stream = vec![];
  for (variant, type_name, boxed) in &node_type.variants {
    let name = format_ident!("{}", variant);
    let walker = format_ident!("walk_{}", type_name.to_case(Case::Snake));

    let stream = if *boxed {
      quote! {
        #enum_name::#name(v) => #walker(hooks, v.as_ref(), ctx),
      }
    } else {
      quote! {
        #enum_name::#name(v) => #walker(hooks, v, ctx),
      }
    };

    variants_stream.push(stream);
  }

  quote! {
    match node {
      #(#variants_stream)*
    }
  }
}

fn create_struct_walk_fn_body(node_type: &NodeType) -> proc_macro2::TokenStream {
  let mut fields_stream = vec![];
  let mut node_type_ident = node_type.as_ident();
  for field in &node_type.fields {
    let field_name = &field.name;
    let field_name_ident = field.as_ident();
    let any_node = field.as_any_node();

    let stream = match &field.value {
      FieldType::Simple(_) => quote! {
        ctx.ancestors.push(Ancestor::Field(AnyNode::#node_type_ident(node), #field_name));
        walk_any(hooks, #any_node(&node.#field_name_ident), ctx);
        ctx.ancestors.pop();
      },

      FieldType::Vector(_) => quote! {
        for (idx, item) in node.#field_name_ident.iter().enumerate() {
          let next = node.#field_name_ident.get(idx + 1).map(|i| Span::new(item.span().end, i.span().start));
          let prev = if idx > 0 {
            node.#field_name_ident.get(idx - 1).map(|i| Span::new(i.span().end, item.span().start))
          } else {
            None
          };
          ctx.ancestors.push(Ancestor::ListItem(AnyNode::#node_type_ident(node), #field_name, idx, next.or(prev)));
          walk_any(hooks, #any_node(item), ctx);
          ctx.ancestors.pop();
        }
      },

      FieldType::Optional(_) => quote! {
        if let Some(v) = &node.#field_name_ident {
          ctx.ancestors.push(Ancestor::Field(AnyNode::#node_type_ident(node), #field_name));
          walk_any(hooks, #any_node(v), ctx);
          ctx.ancestors.pop();
        }
      },

      FieldType::OptionalVector(_) => quote! {
        if let Some(v) = &node.#field_name_ident {
          for (idx, item) in v.iter().enumerate() {
            let next = v.get(idx + 1).map(|i| Span::new(item.span().end, i.span().start));
            ctx.ancestors.push(Ancestor::ListItem(AnyNode::#node_type_ident(node), #field_name, idx, next));
            walk_any(hooks, #any_node(item), ctx);
            ctx.ancestors.pop();
          }
        }
      },

      FieldType::VectorOfOptional(_) => quote! {
        for (idx, item) in node.#field_name_ident.iter().enumerate() {
          if let Some(v) = item {
            let next = if let Some(Some(next)) = node.#field_name_ident.get(idx + 1) {
              Some(Span::new(v.span().end, next.span().start))
            } else {
              None
            };

            ctx.ancestors.push(Ancestor::ListItem(AnyNode::#node_type_ident(node), #field_name, idx, next));
            walk_any(hooks, #any_node(v), ctx);
            ctx.ancestors.pop();
          }
        }
      },
    };

    fields_stream.push(stream);
  }

  quote! {
      #(#fields_stream)*
  }
}

fn create_walk_fn(
  name: &String,
  type_ref: proc_macro2::TokenStream,
  body: proc_macro2::TokenStream,
) -> proc_macro2::TokenStream {
  // let name_ident = format_ident!("{}", name);
  let walk_fn_name = format_ident!("walk_{}", name.to_case(Case::Snake));
  let enter_fn_name = format_ident!("enter_{}", name.to_case(Case::Snake));
  let exit_fn_name = format_ident!("exit_{}", name.to_case(Case::Snake));

  quote! {
    fn #walk_fn_name<'a, Tr: TraverseHooks<'a>>(
      hooks: &mut Tr,
      node: #type_ref,
      ctx: &mut TraverseCtx<'a>,
    ) {
      if let EnterAction::Ignore = hooks.#enter_fn_name(node, ctx) {
        return;
      }

      #body

      hooks.#exit_fn_name(node, ctx);
    }
  }
}

fn create_enum_walk_fn(enum_type: &EnumType) -> proc_macro2::TokenStream {
  let type_ref = enum_type.as_ref();
  let body = create_enum_walk_fn_body(enum_type);
  create_walk_fn(&enum_type.name, type_ref, body)
}

fn create_struct_walk_fn(node_type: &NodeType) -> proc_macro2::TokenStream {
  let type_ref = node_type.as_ref();
  let body = create_struct_walk_fn_body(node_type);
  create_walk_fn(&node_type.name, type_ref, body)
}

fn create_match_branch(node_type: &NodeType) -> proc_macro2::TokenStream {
  let fn_name_ident = node_type.as_fn_name("walk");
  let type_ident = node_type.as_ident();

  quote! {
    AnyNode::#type_ident(node) => #fn_name_ident(hooks, node, ctx),
  }
}

fn create_enum_item(node_type: &NodeType) -> proc_macro2::TokenStream {
  let type_ident = node_type.as_ident();
  let type_ref = node_type.as_ref();

  quote! {
    #type_ident(#type_ref),
  }
}

fn add_hook_fn(prefix: &str, item: &mut ItemImpl, node_type: &NodeType) {
  let stream = create_hook_fn(prefix, node_type, "");

  let method: ImplItemFn = syn::parse(stream.into()).expect("Invalid expression");
  item.items.push(ImplItem::Fn(method));
}

fn add_exit_and_enter_fns(item: &mut ItemImpl, node_type: &NodeType) {
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

  for node_type in &ast.structs {
    add_exit_and_enter_fns(&mut impl_item, node_type);
  }

  impl_item.to_token_stream().into()
}

#[proc_macro]
pub fn define(_input: TokenStream) -> TokenStream {
  let ast = Ast::new();

  let mut hooks = vec![];
  let mut walkers = vec![];
  let mut matches = vec![];
  let mut enum_items = vec![];

  for node_type in &ast.structs {
    enum_items.push(create_enum_item(node_type));

    hooks.push(create_hook_fn("enter", node_type, "EnterAction"));
    hooks.push(create_hook_fn("exit", node_type, ""));

    walkers.push(create_struct_walk_fn(node_type));

    matches.push(create_match_branch(node_type));
  }

  for enum_type in &ast.enums {
    let node_type = NodeType {
      name: enum_type.name.to_string(),
      has_lifetime: true,
      fields: vec![],
    };

    enum_items.push(create_enum_item(&node_type));

    hooks.push(create_hook_fn("enter", &node_type, "EnterAction"));
    hooks.push(create_hook_fn("exit", &node_type, ""));

    walkers.push(create_enum_walk_fn(enum_type));
    matches.push(create_match_branch(&node_type));
  }

  let result = quote! {
    pub enum AnyNode<'a> {
      #(#enum_items)*
    }

    pub trait TraverseHooks<'a> {
      #(#hooks)*
    }

    #(#walkers)*

    fn walk_any<'a, Tr: TraverseHooks<'a>>(
      hooks: &mut Tr,
      any_node: AnyNode<'a>,
      ctx: &mut TraverseCtx<'a>
    ) {
      match &any_node {
        #(#matches)*
      }
    }
  };

  result.into()
}
