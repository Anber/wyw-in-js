use std::path::PathBuf;

pub const EXTENSIONS: [&str; 6] = [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs"];

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

pub fn create_resolver(file_path_buf: &PathBuf) -> oxc_resolver::Resolver {
  // TODO: this should be cached on directory level
  let tsconfig_path = find_tsconfig(file_path_buf.parent().unwrap().to_path_buf());
  let tsconfig = {
    if let Some(tsconfig_path) = tsconfig_path {
      Some(oxc_resolver::TsconfigOptions {
        config_file: tsconfig_path,
        references: oxc_resolver::TsconfigReferences::Auto,
      })
    } else {
      None
    }
  };

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

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json;
  use std::{
    fs::{self, File},
    io::Write,
  };

  use tempfile::tempdir;

  #[test]
  fn test_resolve_existing_module_ts() {
    let dir = tempdir().unwrap();
    let dir_path = dir.path();

    let ts_module_path = dir_path.join("existing_module.ts");
    File::create(&ts_module_path).unwrap();

    let js_module_path = dir_path.join("existing_module.js");
    File::create(&js_module_path).unwrap();

    let resolver = create_resolver(&dir_path.to_path_buf());
    let resolved = resolver.resolve(dir_path, "./existing_module").unwrap();

    assert_eq!(ts_module_path.canonicalize().unwrap(), resolved.path());
  }

  #[test]
  fn test_resolve_nonexistent_module() {
    let dir = tempdir().unwrap();
    let dir_path = dir.path();

    let resolver = create_resolver(&dir_path.to_path_buf());
    let resolved = resolver.resolve(dir_path, "./nonexistent_module");

    assert!(
      resolved.is_err(),
      "Resolver should return an error for nonexistent_module"
    );
  }

  #[test]
  fn test_resolve_ts_reference() {
    let dir = tempdir().unwrap();
    let dir_path = dir.path();

    let tsconfig_path = dir_path.join("tsconfig.json");
    let tsconfig_json = serde_json::json!({
      "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "@/components": ["src/components/index.ts"]
          }
        }
    })
    .to_string();

    let mut tsconfig_file = File::create(&tsconfig_path).unwrap();
    tsconfig_file.write(tsconfig_json.as_bytes()).unwrap();

    let module_dir = dir_path.join("src/components");
    let module_path = module_dir.join("index.ts");

    fs::create_dir_all(module_dir.clone()).unwrap();
    File::create(&module_path).unwrap();

    let resolver = create_resolver(&module_dir.to_path_buf());
    let resolved = resolver.resolve(module_dir, "@/components").unwrap();

    assert_eq!(module_path.canonicalize().unwrap(), resolved.path());
  }
}
