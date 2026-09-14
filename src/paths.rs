//! Where a worktree goes.
//!
//! One template, rendered per branch, so you name the branch and nothing else. Hand-written
//! rather than a template engine: the grammar is four variables and one filter, and a
//! dependency would bring a whole expression language we would then have to say no to.

use camino::{Utf8Path, Utf8PathBuf};

/// The variables a worktree path may reference. Deliberately small — the path is rendered
/// *before* the worktree exists, so nothing inside one can be referenced.
#[derive(Debug, Clone)]
pub struct PathVars<'a> {
    /// Repository name, e.g. `canopy`.
    pub repo: &'a str,
    /// Absolute path of the main checkout.
    pub repo_path: &'a Utf8Path,
    /// Branch name as given, e.g. `feat/login`.
    pub branch: &'a str,
    /// Directory-safe name for the worktree; defaults to the sanitized branch.
    pub name: &'a str,
}

/// Replaces anything outside `[A-Za-z0-9._-]` with `-`, then trims leading and trailing
/// separators.
///
/// This is what turns the branch `feat/login` into the directory `feat-login` while the branch
/// keeps its real name. Runs of illegal characters collapse to a single `-`, so `feat//login`
/// and `feat/login` agree.
pub fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // The separator is emitted lazily, when the *next* legal character arrives. That is what
    // collapses a run of illegal characters into one dash and leaves none trailing.
    let mut needs_separator = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
            if needs_separator && !out.is_empty() {
                out.push('-');
            }
            needs_separator = false;
            out.push(ch);
        } else {
            needs_separator = true;
        }
    }
    out.trim_matches(|c| c == '-' || c == '.').to_owned()
}

/// Renders a worktree path template.
///
/// Supports `{{ var }}` and `{{ var | sanitize }}` for the variables in [`PathVars`]. An
/// unknown variable renders empty, matching the daemon's behaviour — a template is a user
/// setting, and failing the whole operation over a typo in it is worse than a visibly odd path
/// they can see and fix.
///
/// A relative result is resolved against `repo_path`; `~` expands to `$HOME`.
pub fn render(template: &str, vars: &PathVars<'_>) -> Utf8PathBuf {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some((before, after_open)) = rest.split_once("{{") {
        out.push_str(before);
        let Some((inner, tail)) = after_open.split_once("}}") else {
            // An unclosed `{{` is literal text, not an error.
            out.push_str("{{");
            rest = after_open;
            continue;
        };
        rest = tail;
        out.push_str(&substitute(inner, vars));
    }
    out.push_str(rest);
    resolve(&out, vars.repo_path)
}

fn substitute(inner: &str, vars: &PathVars<'_>) -> String {
    let mut parts = inner.split('|').map(str::trim);
    let value = match parts.next().unwrap_or("") {
        "repo" => vars.repo.to_owned(),
        "repo_path" => vars.repo_path.to_string(),
        "branch" => vars.branch.to_owned(),
        "name" => vars.name.to_owned(),
        _ => String::new(),
    };
    match parts.next() {
        Some("sanitize") => sanitize(&value),
        // An unknown filter leaves the value alone rather than blanking it: the path stays
        // usable and the mistake is visible.
        _ => value,
    }
}

/// Expands `~`, then makes a relative path absolute against `base`, then removes `.` and `..`
/// lexically.
///
/// Lexical rather than `canonicalize`: the path does not exist yet, which is the whole point,
/// and `canonicalize` fails on paths that do not exist.
fn resolve(rendered: &str, base: &Utf8Path) -> Utf8PathBuf {
    resolve_with_home(rendered, base, std::env::var("HOME").ok().as_deref())
}

/// The pure half. `home` is threaded through rather than read here so the no-home fallback can
/// be tested — the process environment cannot be changed, since `set_var` is unsafe in edition
/// 2024 and this crate forbids unsafe.
fn resolve_with_home(rendered: &str, base: &Utf8Path, home: Option<&str>) -> Utf8PathBuf {
    let expanded = match rendered.strip_prefix("~/").or_else(|| rendered.strip_prefix("~")) {
        Some(rest) if rendered.starts_with('~') => match home.filter(|home| !home.is_empty()) {
            // A `~` with nowhere to expand to is left as written: a literal tilde is a strange
            // directory name, but inventing a path would be stranger.
            Some(home) => format!("{}/{}", home.trim_end_matches('/'), rest.trim_start_matches('/')),
            None => rendered.to_owned(),
        },
        _ => rendered.to_owned(),
    };
    let joined = if expanded.starts_with('/') { Utf8PathBuf::from(expanded) } else { base.join(expanded) };
    normalize(&joined)
}

/// Collapses `.` and `..` without touching the filesystem.
fn normalize(path: &Utf8Path) -> Utf8PathBuf {
    let mut out: Vec<&str> = Vec::new();
    let absolute = path.as_str().starts_with('/');
    for part in path.as_str().split('/') {
        match part {
            "" | "." => {}
            ".." => {
                // A leading `..` on a relative path has nothing to pop and must be kept.
                if matches!(out.last(), Some(&last) if last != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    let body = out.join("/");
    if absolute { Utf8PathBuf::from(format!("/{body}")) } else { Utf8PathBuf::from(body) }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::*;

    fn vars<'a>(branch: &'a str, name: &'a str, repo_path: &'a Utf8Path) -> PathVars<'a> {
        PathVars { repo: "canopy", repo_path, branch, name }
    }

    #[rstest]
    #[case("main", "main")]
    #[case("feat/login", "feat-login")]
    #[case("feat//login", "feat-login")]
    #[case("release/v1.2.3", "release-v1.2.3")]
    #[case("with space", "with-space")]
    #[case("keeps_underscores-and-dashes", "keeps_underscores-and-dashes")]
    #[case("UPPER", "UPPER")]
    #[case("trailing/", "trailing")]
    #[case("/leading", "leading")]
    #[case("a@b#c", "a-b-c")]
    fn sanitize_cases(#[case] input: &str, #[case] expected: &str) {
        assert_eq!(sanitize(input), expected);
    }

    #[test]
    fn sanitize_can_come_back_empty() {
        // A branch made only of separators has no directory-safe form. Callers must reject
        // it rather than create a worktree at the repository root.
        assert_eq!(sanitize("///"), "");
        assert_eq!(sanitize("---"), "");
        assert_eq!(sanitize(""), "");
    }

    #[test]
    fn sanitize_never_leaves_a_dangling_separator() {
        // A name ending in `-` or `.` makes for an ugly directory and, on some tools, a
        // hidden one.
        for input in ["feat/", "//feat//", ".hidden.", "---"] {
            let got = sanitize(input);
            assert!(!got.starts_with(['-', '.']) && !got.ends_with(['-', '.']), "{input:?} -> {got:?}");
        }
    }

    #[test]
    fn the_default_template_puts_worktrees_beside_the_repo() {
        let repo = Utf8Path::new("/home/me/dev/canopy");
        let got =
            render("{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}", &vars("feat/login", "feat-login", repo));
        // Beside, not inside: a nested worktree shows up in every git status and file watcher.
        assert_eq!(got, "/home/me/dev/canopy.feat-login");
    }

    #[test]
    fn a_relative_template_resolves_against_the_repo() {
        let repo = Utf8Path::new("/home/me/dev/canopy");
        assert_eq!(
            render("worktrees/{{ name }}", &vars("feat/x", "feat-x", repo)),
            "/home/me/dev/canopy/worktrees/feat-x"
        );
    }

    #[test]
    fn an_absolute_template_is_left_where_it_points() {
        let repo = Utf8Path::new("/home/me/dev/canopy");
        assert_eq!(render("/tmp/wt/{{ name }}", &vars("x", "x", repo)), "/tmp/wt/x");
    }

    #[test]
    fn every_variable_renders() {
        let repo = Utf8Path::new("/home/me/dev/canopy");
        let got = render("/out/{{ repo }}/{{ name }}/{{ branch }}/{{ repo_path }}", &vars("feat/x", "wt", repo));
        assert_eq!(got, "/out/canopy/wt/feat/x/home/me/dev/canopy");
    }

    #[test]
    fn whitespace_inside_the_braces_is_optional() {
        let repo = Utf8Path::new("/r");
        assert_eq!(render("/o/{{name}}", &vars("b", "n", repo)), render("/o/{{  name  }}", &vars("b", "n", repo)));
        assert_eq!(render("/o/{{branch|sanitize}}", &vars("a/b", "n", repo)), "/o/a-b");
    }

    #[test]
    fn an_unknown_variable_renders_empty_and_an_unknown_filter_is_ignored() {
        let repo = Utf8Path::new("/r");
        // The template is a user setting; a visibly odd path they can fix beats refusing to work.
        assert_eq!(render("/o/{{ nope }}x", &vars("b", "n", repo)), "/o/x");
        assert_eq!(render("/o/{{ name | shout }}", &vars("b", "n", repo)), "/o/n");
    }

    #[test]
    fn an_unclosed_brace_is_literal_text() {
        let repo = Utf8Path::new("/r");
        assert_eq!(render("/o/{{ name", &vars("b", "n", repo)), "/o/{{ name");
    }

    #[test]
    fn dot_segments_are_collapsed_lexically() {
        // `canonicalize` would be wrong here: the path does not exist yet, which is the point.
        let repo = Utf8Path::new("/home/me/dev/canopy");
        assert_eq!(render("{{ repo_path }}/./../x", &vars("b", "n", repo)), "/home/me/dev/x");
        assert_eq!(render("{{ repo_path }}/../../x", &vars("b", "n", repo)), "/home/me/x");
    }

    #[test]
    fn a_tilde_with_no_home_is_left_as_written() {
        // Nothing to expand to, so nothing is invented: the caller sees the tilde it wrote
        // rather than a path rooted somewhere arbitrary.
        let base = Utf8Path::new("/base");
        assert_eq!(resolve_with_home("~/wt/x", base, None), Utf8PathBuf::from("/base/~/wt/x"));
        assert_eq!(resolve_with_home("~/wt/x", base, Some("")), Utf8PathBuf::from("/base/~/wt/x"));
        // …and with one, it expands.
        assert_eq!(resolve_with_home("~/wt/x", base, Some("/home/me")), Utf8PathBuf::from("/home/me/wt/x"));
        // A trailing slash on HOME does not double up.
        assert_eq!(resolve_with_home("~/wt", base, Some("/home/me/")), Utf8PathBuf::from("/home/me/wt"));
    }

    #[test]
    fn a_template_with_no_variables_is_returned_as_is() {
        assert_eq!(render("/fixed/path", &vars("b", "n", Utf8Path::new("/r"))), "/fixed/path");
    }
}
