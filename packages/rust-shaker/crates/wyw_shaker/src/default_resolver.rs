use oxc_resolver::TsconfigOptions;
use std::path::{Path, PathBuf};

pub const EXTENSIONS: [&str; 5] = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

fn find_tsconfig(start: PathBuf) -> Option<PathBuf> {
  let mut path = start;

  loop {
    let tsconfig = path.join("tsconfig.json");
    if tsconfig.exists() {
      return Some(tsconfig);
    }

    if !path.pop() {
      break;
    }
  }

  None
}

fn get_tsconfig(path: &PathBuf) -> Option<TsconfigOptions> {
  let tsconfig_path = find_tsconfig(path.parent().unwrap().to_path_buf());
  tsconfig_path.map(|tsconfig_path| oxc_resolver::TsconfigOptions {
    config_file: tsconfig_path,
    references: oxc_resolver::TsconfigReferences::Auto,
  })
}

pub fn create_resolver(path: &Path) -> oxc_resolver::Resolver {
  let tsconfig = get_tsconfig(&path.to_path_buf());

  let resolver_options = oxc_resolver::ResolveOptions {
    tsconfig,
    condition_names: vec!["import".into(), "require".into(), "node".into()],
    extensions: EXTENSIONS.map(|ext| ext.to_string()).into(),
    main_fields: vec!["module".into(), "main".into()],
    ..oxc_resolver::ResolveOptions::default()
  };

  let resolver = oxc_resolver::Resolver::new(resolver_options);

  resolver
}
