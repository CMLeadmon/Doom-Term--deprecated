//! Print the remote enrichment snippet.
//!
//! `tools/agent-hooks/doom-term-remote.sh` is generated from this, so the
//! shipped script and the daemon's own string cannot drift. Regenerating it by
//! scraping the Rust source with a regex was fragile enough to corrupt the
//! script once; asking the compiler is exact.
fn main() {
    print!(
        "{}",
        doom_term_pty::shell_integration::remote_enrichment_snippet()
    );
}
