//! Bounded memory of observed process exits, never inferred success.
use doom_term_pty::stream::{Identity, ProcessExit, StreamJournal};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClosedInfo {
    pub incarnation: Identity,
    pub exit_code: Option<i32>,
}
#[derive(Default)]
pub struct Tombstones {
    entries: VecDeque<Retained>,
}
struct Retained {
    id: String,
    info: ClosedInfo,
    expires: Instant,
    _journal: StreamJournal,
}
impl Tombstones {
    pub fn insert(&mut self, journal: StreamJournal, now: Instant) -> bool {
        self.prune(now);
        let snapshot = journal.snapshot();
        let Some(ProcessExit { exit_code }) = snapshot.process_exit else {
            return false;
        };
        let id = snapshot.metadata.session_id;
        let incarnation = snapshot.metadata.incarnation;
        if self
            .entries
            .iter()
            .any(|entry| entry.id == id && entry.info.incarnation == incarnation)
        {
            return true;
        }
        self.entries.push_back(Retained {
            id,
            info: ClosedInfo {
                incarnation,
                exit_code,
            },
            expires: now + Duration::from_secs(300),
            _journal: journal,
        });
        while self.entries.len() > 256 {
            self.entries.pop_front();
        }
        true
    }
    pub fn get(&mut self, id: &str, incarnation: &Identity, now: Instant) -> Option<ClosedInfo> {
        self.prune(now);
        self.entries
            .iter()
            .find(|entry| entry.id == id && &entry.info.incarnation == incarnation)
            .map(|entry| entry.info.clone())
    }
    pub fn prune(&mut self, now: Instant) {
        self.entries.retain(|entry| entry.expires > now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use doom_term_pty::stream::{JournalHub, StreamFault, StreamMetadata, StreamPayload};
    use std::time::Duration;

    fn closed(hub: &JournalHub, id: &str, code: Option<i32>) -> StreamJournal {
        let journal = hub
            .open(
                StreamMetadata::new(id.into(), Identity::random().unwrap(), 80, 24, false).unwrap(),
            )
            .unwrap();
        journal
            .append(StreamPayload::Closed { exit_code: code })
            .unwrap();
        journal
    }

    #[test]
    fn repeats_do_not_extend_five_minute_retention_or_convert_unknown_exit_to_success() {
        let hub = JournalHub::default();
        let mut retained = Tombstones::default();
        let now = Instant::now();
        let journal = closed(&hub, "closed", None);
        let incarnation = journal.snapshot().metadata.incarnation;
        assert!(retained.insert(journal.clone(), now));
        assert!(retained.insert(journal, now + Duration::from_secs(299)));
        assert!(
            hub.retained_bytes() > 0,
            "tombstones must remain charged to the shared journal"
        );
        assert_eq!(
            retained.get("closed", &incarnation, now + Duration::from_secs(299)),
            Some(ClosedInfo {
                incarnation: incarnation.clone(),
                exit_code: None
            })
        );
        assert_eq!(
            retained.get("closed", &incarnation, now + Duration::from_secs(300)),
            None
        );
        assert_eq!(hub.retained_bytes(), 0);
    }

    #[test]
    fn count_eviction_releases_the_oldest_journal_and_fences_incarnations() {
        let hub = JournalHub::default();
        let now = Instant::now();
        let mut retained = Tombstones::default();
        let mut identities = Vec::new();
        for index in 0..257 {
            let journal = closed(&hub, &format!("closed-{index}"), Some(7));
            identities.push(journal.snapshot().metadata.incarnation);
            assert!(retained.insert(journal, now));
        }
        assert_eq!(retained.get("closed-0", &identities[0], now), None);
        assert_eq!(retained.get("closed-256", &identities[0], now), None);
        assert_eq!(
            retained
                .get("closed-256", &identities[256], now)
                .unwrap()
                .exit_code,
            Some(7)
        );
        retained.prune(now + Duration::from_secs(300));
        assert_eq!(hub.retained_bytes(), 0);
    }

    #[test]
    fn live_streams_and_rendering_faults_cannot_be_retained_as_closed_processes() {
        let hub = JournalHub::default();
        let mut retained = Tombstones::default();
        let journal = hub
            .open(
                StreamMetadata::new("fault".into(), Identity::random().unwrap(), 80, 24, false)
                    .unwrap(),
            )
            .unwrap();
        let incarnation = journal.snapshot().metadata.incarnation;
        assert!(!retained.insert(journal.clone(), Instant::now()));
        journal
            .append(StreamPayload::Fault {
                reason: StreamFault::ControlTooLong,
            })
            .unwrap();
        assert!(!retained.insert(journal, Instant::now()));
        assert_eq!(retained.get("fault", &incarnation, Instant::now()), None);
        assert_eq!(hub.retained_bytes(), 0);
    }
}
