use crate::Processor;
use oxc::span::{Atom, Span};
use std::borrow::Cow;
use std::fmt::Debug;
use std::path::PathBuf;
use wyw_traverse::local_identifier::LocalIdentifier;

#[derive(Debug)]
pub enum ConstValue<'a> {
  BigInt(Span, Atom<'a>),
  Boolean(Span, bool),
  Null(Span),
  Number(Span, f64),
  String(Span, Atom<'a>),
  Undefined(Span),
}

pub enum ExpressionValue<'a> {
  ConstValue(ConstValue<'a>),
  Function(Span),
  Ident(Span, Atom<'a>),
  Source(Span),
  TemplateValue {
    cooked: Option<Atom<'a>>,
    raw: Atom<'a>,
    span: Span,
  },
}

impl<'a> Debug for ExpressionValue<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      ExpressionValue::ConstValue(value) => write!(f, "{:?}", value),
      ExpressionValue::Function(span) => write!(f, "Function({:?})", span),
      ExpressionValue::Ident(span, ident) => {
        write!(f, "Ident({:?}..{:?}, {:?})", span.start, span.end, ident)
      }
      ExpressionValue::Source(span) => write!(f, "Source({:?}..{:?})", span.start, span.end),
      ExpressionValue::TemplateValue { span, raw, .. } => {
        write!(
          f,
          "TemplateValue({:?}..{:?}, {:?})",
          span.start, span.end, raw
        )
      }
    }
  }
}

pub enum Param<'a> {
  Callee(Span, LocalIdentifier<'a>),
  Call(Span, Vec<ExpressionValue<'a>>),
  Member(Span, Atom<'a>),
  Template(Span, Vec<ExpressionValue<'a>>),
}

impl<'a> Debug for Param<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      Param::Callee(span, ident) => {
        write!(f, "Callee({:?}..{:?}, {:?})", span.start, span.end, ident)
      }
      Param::Call(span, args) => write!(f, "Call({:?}..{:?}, {:?}))", span.start, span.end, args),
      Param::Member(span, prop) => {
        write!(f, "Member({:?}..{:?}, {:?}))", span.start, span.end, prop)
      }
      Param::Template(span, exprs) => write!(
        f,
        "Template({:?}..{:?}, {:?}))",
        span.start, span.end, exprs
      ),
    }
  }
}

pub struct ProcessorParams<'a> {
  pub idx: usize,
  pub display_name: Cow<'a, str>,
  pub params: Vec<Param<'a>>,
  pub root: &'a PathBuf,
  pub filename: &'a PathBuf,
}

#[derive(Debug)]
pub struct ProcessorCall<'a> {
  pub span: Span,
  pub processor: Box<dyn Processor>,
  pub params: ProcessorParams<'a>,
}

impl<'a> Debug for ProcessorParams<'a> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("ProcessorParams")
      .field("idx", &self.idx)
      .field("display_name", &self.display_name)
      .field("params", &self.params)
      .finish()
  }
}

pub type ProcessorCalls<'a> = Vec<ProcessorCall<'a>>;
