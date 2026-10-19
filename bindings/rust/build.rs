fn main() {
    let src_dir = std::path::Path::new("src");
    println!("cargo:rerun-if-changed={}", src_dir.display());

    let mut c_config = cc::Build::new();
    c_config
        .std("c11")
        .include(src_dir)
        .flag_if_supported("-Wno-sign-compare")
        .flag_if_supported("-Wno-implicit-fallthrough");

    #[cfg(target_env = "msvc")]
    c_config.flag("-utf-8");

    if std::env::var("TARGET").unwrap() == "wasm32-unknown-unknown" {
        let Ok(wasm_headers) = std::env::var("DEP_TREE_SITTER_LANGUAGE_WASM_HEADERS") else {
            panic!(
                "Environment variable DEP_TREE_SITTER_LANGUAGE_WASM_HEADERS must be set by the language crate"
            );
        };

        c_config.include(&wasm_headers);
    }

    c_config.file(src_dir.join("parser.c"));
    c_config.file(src_dir.join("scanner.c"));

    c_config.compile("tree-sitter-html");
}
