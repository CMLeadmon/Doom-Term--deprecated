//! The account's rate-limit usage, fetched on a timer and served from cache.
//!
//! `GetTelemetry` is polled every 2 s by the UI and must never wait on the
//! network, so nothing here is called from the request path: the refresh loop
//! writes the cache and the request path only reads it.

use parking_lot::RwLock;
use std::time::{Duration, Instant};

use super::credentials::read_access_token;
use super::limits::{map_limits, reportable_fraction};

/// Anthropic's own quota endpoint — the one the CLI reads. Hardcoded on
/// purpose: a configurable URL is a way to point a bearer token at an
/// arbitrary host.
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The OAuth-scoped beta header the endpoint gates on.
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// How long one request may take. Comfortably under the refresh interval so a
/// hung request can never overlap the next one.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The soonest one read may follow another. This is the real request rate.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(60);

/// How often the loop wakes to CHECK the gate. Much shorter than the refresh
/// interval so the number appears within seconds of an agent starting, rather
/// than up to a minute later; `due()` is what keeps this from becoming the
/// request rate.
pub const GATE_TICK: Duration = Duration::from_secs(5);

/// How long a value stays reportable after its last successful read. Rate-limit
/// windows are 5 h and 7 d, so a minutes-old number is still true; past this it
/// is an assertion we can no longer stand behind and the slot returns to '--'.
const STALE_AFTER: Duration = Duration::from_secs(600);

struct Snapshot {
    /// The answer as of `read_at`. `None` is a real answer: "this account has no
    /// subscription window" (API-key billing, or logged out).
    fraction: Option<f64>,
    read_at: Instant,
}

#[derive(Default)]
pub struct UsageService {
    snapshot: RwLock<Option<Snapshot>>,
    /// When a read was last ATTEMPTED — success or not. Separate from the
    /// snapshot's `read_at`, which only advances on success: rate limiting has
    /// to count failures too, or an offline host retries at the tick rate.
    last_attempt: RwLock<Option<Instant>>,
}

impl UsageService {
    pub fn new() -> Self {
        Self::default()
    }

    /// May a read be attempted now?
    pub fn due(&self) -> bool {
        match *self.last_attempt.read() {
            None => true,
            Some(at) => at.elapsed() >= REFRESH_INTERVAL,
        }
    }

    fn mark_attempted(&self) {
        *self.last_attempt.write() = Some(Instant::now());
    }

    /// The cached fraction, or None when we have never read one, the last read
    /// said there is nothing to show, or the value has gone stale.
    pub fn cached(&self) -> Option<f64> {
        let guard = self.snapshot.read();
        let snap = guard.as_ref()?;
        if snap.read_at.elapsed() > STALE_AFTER {
            return None;
        }
        snap.fraction
    }

    /// Record a successful read. `None` means the read succeeded and the answer
    /// is "no subscription window" — it overwrites any earlier number.
    fn store(&self, fraction: Option<f64>) {
        *self.snapshot.write() = Some(Snapshot {
            fraction,
            read_at: Instant::now(),
        });
    }

    /// Record a FAILED read: leave the last good value alone. An unreachable
    /// endpoint is not evidence about the account, and blanking the slot on
    /// every transient network blip would make it flicker.
    fn store_failure(&self) {
        // Deliberately empty. Named so the call site reads as a decision
        // rather than a forgotten branch.
    }

    /// Fetch and cache. BLOCKING — call from `spawn_blocking`, never from the
    /// request path. Stamps the attempt FIRST so a slow or hanging request
    /// still holds the gate shut against the next tick.
    pub fn refresh_blocking(&self) {
        self.mark_attempted();
        match fetch_fraction() {
            Ok(fraction) => self.store(fraction),
            Err(()) => self.store_failure(),
        }
    }

    #[cfg(test)]
    fn expire_for_test(&self) {
        if let Some(snap) = self.snapshot.write().as_mut() {
            snap.read_at = Instant::now() - STALE_AFTER - Duration::from_secs(1);
        }
    }
}

/// One read. `Ok(None)` = read fine, nothing to show. `Err(())` = could not read.
///
/// The error type carries nothing on purpose: an error string built from a
/// request that had an Authorization header on it is exactly how a token ends
/// up in a log file.
fn fetch_fraction() -> Result<Option<f64>, ()> {
    let Some(token) = read_access_token() else {
        // Not signed in. A definite answer, not a failure.
        return Ok(None);
    };

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .into();

    let mut response = match agent
        .get(USAGE_URL)
        .header("authorization", &format!("Bearer {token}"))
        .header("anthropic-beta", OAUTH_BETA)
        .call()
    {
        Ok(r) => r,
        // 401/403 mean this identity has nothing to show — a definite answer.
        // Everything else is a failure that must keep the last good value.
        Err(ureq::Error::StatusCode(401 | 403)) => return Ok(None),
        Err(_) => return Err(()),
    };

    let body = response.body_mut().read_to_string().map_err(|_| ())?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|_| ())?;
    Ok(reportable_fraction(&map_limits(&json)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_service_knows_nothing() {
        // Never 0.0 before the first successful fetch.
        assert_eq!(UsageService::new().cached(), None);
    }

    #[test]
    fn serves_the_last_good_value() {
        let s = UsageService::new();
        s.store(Some(0.42));
        assert_eq!(s.cached(), Some(0.42));
    }

    #[test]
    fn a_failed_refresh_keeps_the_last_good_value() {
        // A dropped wifi connection is not evidence the account is at 0%.
        let s = UsageService::new();
        s.store(Some(0.42));
        s.store_failure();
        assert_eq!(s.cached(), Some(0.42));
    }

    #[test]
    fn forgets_a_value_that_has_gone_stale() {
        let s = UsageService::new();
        s.store(Some(0.42));
        s.expire_for_test();
        assert_eq!(s.cached(), None);
    }

    #[test]
    fn an_explicit_no_subscription_answer_is_remembered_as_unknown() {
        // 'unavailable' (API-key billing, logged out) is a SUCCESSFUL read whose
        // answer is "nothing to show" — it must overwrite a stale number.
        let s = UsageService::new();
        s.store(Some(0.42));
        s.store(None);
        assert_eq!(s.cached(), None);
    }

    #[test]
    fn is_due_before_it_has_ever_run() {
        assert!(UsageService::new().due());
    }

    #[test]
    fn is_not_due_again_immediately_after_an_attempt() {
        // The loop ticks every few seconds so it reacts fast when an agent
        // appears; this is what stops that tick becoming a request rate.
        let s = UsageService::new();
        s.mark_attempted();
        assert!(!s.due());
    }

    #[test]
    fn a_failed_attempt_still_counts_against_the_interval() {
        // Otherwise a host that is offline retries at the tick rate forever.
        let s = UsageService::new();
        s.mark_attempted();
        s.store_failure();
        assert!(!s.due());
    }

    /// The endpoint contract, against the real API. Ignored by default because
    /// it needs the network and a signed-in `~/.claude`, so it must never gate
    /// CI — but no unit test can prove the payload still parses, and a silent
    /// shape change would show up as a permanent '--' rather than an error.
    ///
    /// Run it when the slot stops reporting:
    ///   cargo test --manifest-path backend/Cargo.toml -- --ignored --nocapture
    #[test]
    #[ignore]
    fn probes_the_live_endpoint() {
        let got =
            fetch_fraction().expect("the read itself failed — network, or a changed contract");
        match got {
            // Prints the fraction, never the token.
            Some(f) => {
                println!("live usage fraction: {f}");
                assert!((0.0..=1.0).contains(&f));
            }
            None => println!("no subscription window (API-key billing, or logged out)"),
        }
    }
}
