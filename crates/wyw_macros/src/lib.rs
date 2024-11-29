use crate::ast::{Ast, AstType, InnerType};
use crate::traverse::create_hook_fn;
use proc_macro::TokenStream;
use quote::ToTokens;
use syn::{ImplItem, ImplItemFn, Item, ItemImpl};

mod ast;
mod traverse;

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
pub fn define_traverse(input: TokenStream) -> TokenStream {
  traverse::define(input)
}
