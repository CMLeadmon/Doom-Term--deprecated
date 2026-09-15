//! Locating and reading the access token the Claude CLI already wrote.
//!
//! READ-ONLY, always. The CLI rotates these tokens itself and rewriting the
//! file would log out a live `claude` session. Nothing here logs, returns or
//! formats the token into an error — the only thing that leaves this module is
//! the token itself, straight into the one request that uses it.

use std::path::PathBuf;

/// `~/.claude/.credentials.json`, or None when `$HOME` is unset.
pub fn credentials_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    Some(
        PathBuf::from(home)
            .join(".claude")
            .join(".credentials.json"),
    )
}

/// Pull the subscription access token out of a credentials file's contents.
///
/// Narrows to the `claudeAiOauth` object FIRST. The file also holds one
/// `accessToken` per authorized MCP server under `mcpOAuth`, so a scan that
/// takes the first match in the file hands the usage endpoint an MCP token,
/// gets a 401, and reports "not signed in" on a machine that is perfectly
/// signed in. Falling back to the whole document covers the older flat shape.
pub fn parse_access_token(raw: &str) -> Option<String> {
    let doc: serde_json::Value = serde_json::from_str(raw).ok()?;
    let scope = doc.get("claudeAiOauth").unwrap_or(&doc);
    let token = scope.get("accessToken")?.as_str()?;
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// The token, or None if there is no file, it is unreadable, or it holds no
/// subscription credential. Every one of those is "we don't know", which the
/// caller renders as '--'.
pub fn read_access_token() -> Option<String> {
    let raw = std::fs::read_to_string(credentials_path()?).ok()?;
    parse_access_token(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_token_from_the_oauth_object() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"sk-real","refreshToken":"r"}}"#;
        assert_eq!(parse_access_token(raw), Some("sk-real".to_string()));
    }

    #[test]
    fn reads_the_flat_top_level_shape() {
        // Older files put the token at the top level.
        let raw = r#"{"accessToken":"sk-flat"}"#;
        assert_eq!(parse_access_token(raw), Some("sk-flat".to_string()));
    }

    #[test]
    fn never_returns_an_mcp_servers_token() {
        // `.credentials.json` holds one accessToken PER authorized MCP server
        // under `mcpOAuth`. Handing the endpoint an MCP token answers 401 —
        // i.e. the plate reports "no subscription" on a signed-in machine.
        // Ordering the MCP block FIRST is the case a naive scan gets wrong.
        let raw = r#"{
            "mcpOAuth": { "some-server": { "accessToken": "mcp-token-WRONG" } },
            "claudeAiOauth": { "accessToken": "sk-right" }
        }"#;
        assert_eq!(parse_access_token(raw), Some("sk-right".to_string()));
    }

    #[test]
    fn returns_nothing_when_only_mcp_tokens_are_present() {
        let raw = r#"{"mcpOAuth":{"s":{"accessToken":"mcp-only"}}}"#;
        assert_eq!(parse_access_token(raw), None);
    }

    #[test]
    fn returns_nothing_for_malformed_or_empty_input() {
        assert_eq!(parse_access_token(""), None);
        assert_eq!(parse_access_token("not json"), None);
        assert_eq!(parse_access_token("{}"), None);
        assert_eq!(parse_access_token(r#"{"claudeAiOauth":{}}"#), None);
    }

    #[test]
    fn treats_an_empty_token_string_as_absent() {
        // A blank token is not a credential; sending it would 401 and be
        // reported as "no subscription".
        assert_eq!(parse_access_token(r#"{"accessToken":""}"#), None);
    }
}
