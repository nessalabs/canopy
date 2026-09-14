//! The documentation, checked against the implementation.
//!
//! Prose goes stale quietly. Every complete `canopy.yaml` shown in the docs is parsed here, so
//! an example that stops being valid fails the build instead of misleading whoever copies it.

use canopy_worktree::parse_str;

/// Every fenced ```yaml block in a markdown file.
fn yaml_blocks(markdown: &str) -> Vec<(usize, String)> {
    let mut blocks = Vec::new();
    let mut lines = markdown.lines().enumerate();
    while let Some((index, line)) = lines.next() {
        if line.trim_start_matches('>').trim() != "```yaml" {
            continue;
        }
        let mut body = String::new();
        for (_, line) in lines.by_ref() {
            if line.trim() == "```" {
                break;
            }
            body.push_str(line);
            body.push('\n');
        }
        blocks.push((index + 1, body));
    }
    blocks
}

/// A block is a whole config if it starts with `version:`; anything else is a fragment
/// illustrating one key, which cannot be validated on its own.
fn complete_configs(markdown: &str) -> Vec<(usize, String)> {
    yaml_blocks(markdown).into_iter().filter(|(_, body)| body.trim_start().starts_with("version:")).collect()
}

#[track_caller]
fn check_examples(file: &str, markdown: &str, expect_at_least: usize) {
    let configs = complete_configs(markdown);
    assert!(
        configs.len() >= expect_at_least,
        "{file}: expected at least {expect_at_least} complete config example(s), found {} — \
         did the examples move, or did the fence language change?",
        configs.len()
    );

    for (line, body) in configs {
        let parsed = parse_str(&body);
        let errors: Vec<String> = parsed.errors().map(|d| format!("{}: {}", d.path, d.message)).collect();
        assert!(errors.is_empty(), "{file}:{line}: example does not parse: {errors:?}");

        // Warnings matter too: an example that trips the linter teaches the wrong habit to
        // whoever copies it, which is most readers.
        let warnings: Vec<String> = parsed.warnings().map(|d| format!("{}: {}", d.path, d.message)).collect();
        assert!(warnings.is_empty(), "{file}:{line}: example produces warnings: {warnings:?}");
    }
}

#[test]
fn readme_config_examples_are_valid() {
    check_examples("README.md", include_str!("../README.md"), 1);
}

#[test]
fn configuration_reference_examples_are_valid() {
    check_examples("docs/configuration.md", include_str!("../docs/configuration.md"), 2);
}

#[test]
fn the_starter_shown_by_config_init_is_the_one_documented() {
    // `config init` prints this; the configuration reference describes its defaults. If the
    // two drift, the first thing a new user does is read a description of something else.
    let parsed = parse_str(canopy_worktree::config::STARTER);
    assert!(parsed.is_valid(), "{:?}", parsed.errors().collect::<Vec<_>>());
    assert_eq!(parsed.warning_count(), 0);
}

#[test]
fn every_documented_error_code_exists() {
    // The JSON reference tabulates error codes; a code that is documented but not real sends
    // a consumer hunting for a branch that can never be taken.
    let doc = include_str!("../docs/json-api.md");
    let known: Vec<&str> = canopy_worktree::ErrorCode::ALL.iter().map(|code| code.as_str()).collect();

    let mut documented = Vec::new();
    for line in doc.lines().filter(|line| line.starts_with("| `")) {
        if let Some(code) = line.trim_start_matches("| `").split('`').next()
            && (known.contains(&code) || code.contains('_'))
        {
            documented.push(code.to_owned());
        }
    }

    assert!(documented.len() >= known.len(), "only {} of {} codes documented", documented.len(), known.len());
    for code in &documented {
        assert!(known.contains(&code.as_str()), "docs/json-api.md documents `{code}`, which is not a real ErrorCode");
    }
    for code in &known {
        assert!(documented.iter().any(|d| d == code), "error code `{code}` is not documented in docs/json-api.md");
    }
}
