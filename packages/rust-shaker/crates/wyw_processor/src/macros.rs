#[macro_export]
macro_rules! processor {
  ($initializer:expr) => {
    #[no_mangle]
    pub extern "C" fn get_interface<'a>() -> *mut dyn Processor<'a> {
      Box::into_raw(Box::new($initializer))
    }
  };
}
