use crate::ast::{Ast, AstType, EnumType, FieldType, InnerType};
use convert_case::{Case, Casing};
use proc_macro::TokenStream;
use quote::{format_ident, quote};

pub(crate) fn create_hook_fn(
  prefix: &str,
  node_type: &AstType,
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

fn create_enum_walk_fn_body(
  node_type: &AstType,
  variants: &Vec<(String, String, bool)>,
) -> proc_macro2::TokenStream {
  let enum_name = node_type.as_full_name();
  let mut variants_stream = vec![];
  for (variant, type_name, boxed) in variants {
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

fn create_struct_walk_fn_body(
  node_type: &AstType,
  fields: &Vec<AstType>,
) -> proc_macro2::TokenStream {
  let mut fields_stream = vec![];
  let node_type_ident = node_type.as_ident();
  for field in fields {
    let field_name = &field.name;
    let field_name_ident = field.as_ident();

    let inner = if let InnerType::Field(inner) = &field.inner {
      inner
    } else {
      panic!("Field must be a field type");
    };

    let any_node = inner.as_any_node();

    let stream = match &inner {
      FieldType::Simple(_) => quote! {
        ctx.ancestors.push(Ancestor::Field(AnyNode::#node_type_ident(node), #field_name));
        walk_any(hooks, #any_node(&node.#field_name_ident), ctx);
        ctx.ancestors.pop();
      },

      FieldType::Vector(_) => quote! {
        for (idx, item) in node.#field_name_ident.iter().enumerate() {
          ctx.ancestors.push(Ancestor::ListItem(AnyNode::#node_type_ident(node), #field_name, idx));
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
            ctx.ancestors.push(Ancestor::ListItem(AnyNode::#node_type_ident(node), #field_name, idx));
            walk_any(hooks, #any_node(item), ctx);
            ctx.ancestors.pop();
          }
        }
      },

      FieldType::VectorOfOptional(_) => quote! {
        for (idx, item) in node.#field_name_ident.iter().enumerate() {
          if let Some(v) = item {
            ctx.ancestors.push(Ancestor::ListItem(AnyNode::#node_type_ident(node), #field_name, idx));
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

fn create_walk_fn(node_type: &AstType) -> proc_macro2::TokenStream {
  let type_ref = node_type.as_ref();
  let body = match node_type.inner {
    InnerType::Enum(EnumType { ref variants, .. }) => create_enum_walk_fn_body(node_type, variants),

    InnerType::Struct(ref fields) => create_struct_walk_fn_body(node_type, fields),

    InnerType::Field(_) => {
      panic!("Cannot be on the top level")
    }
  };

  let name = &node_type.name;
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

fn create_match_branch(node_type: &AstType) -> proc_macro2::TokenStream {
  let fn_name_ident = node_type.as_fn_name("walk");
  let type_ident = node_type.as_ident();

  quote! {
    AnyNode::#type_ident(node) => #fn_name_ident(hooks, node, ctx),
  }
}

fn create_enum_item(node_type: &AstType) -> proc_macro2::TokenStream {
  let type_ident = node_type.as_ident();
  let type_ref = node_type.as_ref();

  quote! {
    #type_ident(#type_ref),
  }
}

fn create_get_span_item(node_type: &AstType) -> proc_macro2::TokenStream {
  let type_ident = node_type.as_ident();

  quote! {
    AnyNode::#type_ident(node) => node.span(),
  }
}

pub fn define(_input: TokenStream) -> TokenStream {
  let ast = Ast::new();

  let mut hooks = vec![];
  let mut walkers = vec![];
  let mut matches = vec![];
  let mut enum_items = vec![];
  let mut get_span = vec![];

  for node_type in &ast.types {
    enum_items.push(create_enum_item(node_type));
    get_span.push(create_get_span_item(node_type));

    hooks.push(create_hook_fn("enter", node_type, "EnterAction"));
    hooks.push(create_hook_fn("exit", node_type, ""));

    walkers.push(create_walk_fn(node_type));

    matches.push(create_match_branch(node_type));
  }

  let result = quote! {
    use oxc::span::GetSpan;
    use oxc::span::Span;

    #[derive(Debug)]
    pub enum AnyNode<'a> {
      #(#enum_items)*
    }

    impl<'a> oxc::span::GetSpan for AnyNode<'a> {
      fn span(&self) -> oxc::span::Span {
        match self {
          #(#get_span)*
        }
      }
    }

    pub trait TraverseHooks<'a> {
      fn should_skip(&self, node: &AnyNode) -> bool {
        false
      }

      #(#hooks)*
    }

    #(#walkers)*

    fn walk_any<'a, Tr: TraverseHooks<'a>>(
      hooks: &mut Tr,
      any_node: AnyNode<'a>,
      ctx: &mut TraverseCtx<'a>
    ) {
      if hooks.should_skip(&any_node) {
        return;
      }

      match &any_node {
        #(#matches)*
      }
    }
  };

  result.into()
}
