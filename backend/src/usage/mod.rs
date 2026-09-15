//! Account rate-limit usage, read from the provider's own quota endpoint.
//!
//! Split so the mapping and credential parsing stay pure and unit-tested, and
//! every side effect (fs, network, timers) is confined to `service.rs`.

pub mod codex;
pub mod context;
pub mod credentials;
pub mod hint;
pub mod limits;
pub mod service;
