//! Bounded, ordered observations of a PTY adapter. No transport callbacks or
//! subprocess work run under this module's lock. Consumers read one record by
//! cursor; a subscriber never owns a copied replay queue.

use crate::DemuxEvent;
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

pub const MAX_RECORD_BYTES: usize = 64 * 1024;
pub const MAX_SESSION_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SESSION_RECORDS: usize = 8192;
pub const MAX_GLOBAL_BYTES: usize = 64 * 1024 * 1024;

/// Canonical opaque 128-bit identity, never a process id or a session name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Identity(String);

impl Identity {
    pub fn random() -> anyhow::Result<Self> {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("Identity entropy unavailable"))?;
        Ok(Self(bytes.iter().map(|b| format!("{b:02x}")).collect()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for Identity {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() == 32
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            Ok(Self(value))
        } else {
            Err("Expected a canonical 128-bit identity")
        }
    }
}

impl From<Identity> for String {
    fn from(value: Identity) -> Self {
        value.0
    }
}

/// Decimal-string u64 on the wire: JS numbers cannot represent every cursor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Sequence(u64);

impl Sequence {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<String> for Sequence {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.is_empty()
            || value.len() > 20
            || !value.bytes().all(|b| b.is_ascii_digit())
            || (value.len() > 1 && value.starts_with('0'))
        {
            return Err("Expected a canonical decimal u64 sequence");
        }
        value
            .parse::<u64>()
            .map(Self)
            .map_err(|_| "Sequence exceeds u64")
    }
}

impl From<Sequence> for String {
    fn from(value: Sequence) -> Self {
        value.0.to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamMetadata {
    pub session_id: String,
    pub incarnation: Identity,
    pub stream_epoch: Identity,
    pub initial_cols: u16,
    pub initial_rows: u16,
    pub durable: bool,
}

impl StreamMetadata {
    pub fn new(
        session_id: String,
        incarnation: Identity,
        cols: u16,
        rows: u16,
        durable: bool,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            session_id,
            incarnation,
            stream_epoch: Identity::random()?,
            initial_cols: cols,
            initial_rows: rows,
            durable,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum StreamPayload {
    Event(DemuxEvent),
    Resize { cols: u16, rows: u16 },
    Closed { exit_code: Option<i32> },
    Fault { reason: StreamFault },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StreamFault {
    RecordTooLarge,
    SequenceExhausted,
    ControlTooLong,
    AdapterRetired,
    AdapterLost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessExit {
    pub exit_code: Option<i32>,
}

/// Terminal state survives payload eviction; a rendering fault is not an exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEnd {
    Closed { exit_code: Option<i32> },
    Fault { reason: StreamFault },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamRecord {
    pub session_id: String,
    pub incarnation: Identity,
    pub stream_epoch: Identity,
    pub sequence: Sequence,
    /// Since the hub's origin, valid only in this hub's clock_epoch.
    pub observed_micros: u64,
    pub payload: StreamPayload,
}

#[derive(Debug, Clone)]
pub struct StreamSnapshot {
    pub metadata: StreamMetadata,
    pub clock_epoch: Identity,
    pub high_water: Sequence,
    pub first_retained: Option<Sequence>,
    pub retained_records: usize,
    pub retained_bytes: usize,
    pub ended: bool,
    pub termination: Option<StreamEnd>,
    /// Lifecycle observation may arrive after the rendering stream faulted.
    pub process_exit: Option<ProcessExit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamError {
    Gap,
    FutureCursor,
    Ended,
    RecordTooLarge,
    SequenceExhausted,
    DuplicateEpoch,
    InvalidMetadata,
}

impl std::fmt::Display for StreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for StreamError {}

#[derive(Clone, Copy)]
struct Limits {
    session_bytes: usize,
    session_records: usize,
    global_bytes: usize,
}

struct StoredRecord {
    record: StreamRecord,
    bytes: usize,
    order: u128,
}

/// Count encoded bytes without allocating a second copy of terminal output.
/// Stop serialization at the declared limit, even for a huge rejected string.
struct EncodedSize {
    bytes: usize,
    limit: usize,
}
impl std::io::Write for EncodedSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes) {
            return Err(std::io::Error::other(
                "Encoded stream record exceeds its limit",
            ));
        }
        self.bytes += bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encoded_size(value: &impl Serialize, limit: usize) -> Option<usize> {
    let mut counter = EncodedSize { bytes: 0, limit };
    serde_json::to_writer(&mut counter, value).ok()?;
    Some(counter.bytes)
}
struct JournalState {
    metadata: StreamMetadata,
    records: VecDeque<StoredRecord>,
    high_water: Sequence,
    bytes: usize,
    ended: bool,
    termination: Option<StreamEnd>,
    process_exit: Option<ProcessExit>,
}

#[derive(Default)]
struct HubState {
    streams: HashMap<Identity, JournalState>,
    // Contains precisely one entry per retained record, never per append.
    oldest: BTreeMap<u128, Identity>,
    next_order: u128,
    bytes: usize,
}

impl HubState {
    fn evict_front(&mut self, epoch: &Identity) {
        let stream = self.streams.get_mut(epoch).expect("live journal");
        if let Some(record) = stream.records.pop_front() {
            stream.bytes -= record.bytes;
            self.bytes -= record.bytes;
            self.oldest.remove(&record.order);
        }
    }
}

struct HubInner {
    state: Mutex<HubState>,
    changed: Condvar,
    origin: Instant,
    clock_epoch: Identity,
    limits: Limits,
}

#[derive(Clone)]
pub struct JournalHub(Arc<HubInner>);

impl Default for JournalHub {
    fn default() -> Self {
        Self::with_limits(Limits {
            session_bytes: MAX_SESSION_BYTES,
            session_records: MAX_SESSION_RECORDS,
            global_bytes: MAX_GLOBAL_BYTES,
        })
    }
}

impl JournalHub {
    fn with_limits(limits: Limits) -> Self {
        Self(Arc::new(HubInner {
            state: Mutex::new(HubState::default()),
            changed: Condvar::new(),
            origin: Instant::now(),
            clock_epoch: Identity::random().expect("A journal requires secure identity entropy"),
            limits,
        }))
    }

    /// Every production session in one process shares the global retention cap.
    pub fn shared() -> Self {
        static HUB: OnceLock<JournalHub> = OnceLock::new();
        HUB.get_or_init(Self::default).clone()
    }

    pub fn open(&self, metadata: StreamMetadata) -> Result<StreamJournal, StreamError> {
        if metadata.session_id.is_empty()
            || metadata.session_id.len() > 256
            || metadata.initial_cols == 0
            || metadata.initial_rows == 0
        {
            return Err(StreamError::InvalidMetadata);
        }
        let mut state = self.0.state.lock();
        let epoch = metadata.stream_epoch.clone();
        if state.streams.contains_key(&epoch) {
            return Err(StreamError::DuplicateEpoch);
        }
        state.streams.insert(
            epoch.clone(),
            JournalState {
                metadata,
                records: VecDeque::new(),
                high_water: Sequence::default(),
                bytes: 0,
                ended: false,
                termination: None,
                process_exit: None,
            },
        );
        Ok(StreamJournal(Arc::new(JournalLease {
            hub: self.0.clone(),
            epoch,
        })))
    }

    pub fn retained_bytes(&self) -> usize {
        self.0.state.lock().bytes
    }
}

struct JournalLease {
    hub: Arc<HubInner>,
    epoch: Identity,
}
impl Drop for JournalLease {
    fn drop(&mut self) {
        let mut state = self.hub.state.lock();
        if let Some(stream) = state.streams.remove(&self.epoch) {
            state.bytes -= stream.bytes;
            for record in stream.records {
                state.oldest.remove(&record.order);
            }
        }
    }
}

#[derive(Clone)]
pub struct StreamJournal(Arc<JournalLease>);

impl StreamJournal {
    pub fn snapshot(&self) -> StreamSnapshot {
        let state = self.0.hub.state.lock();
        let stream = &state.streams[&self.0.epoch];
        StreamSnapshot {
            metadata: stream.metadata.clone(),
            clock_epoch: self.0.hub.clock_epoch.clone(),
            high_water: stream.high_water,
            first_retained: stream.records.front().map(|r| r.record.sequence),
            retained_records: stream.records.len(),
            retained_bytes: stream.bytes,
            ended: stream.ended,
            termination: stream.termination,
            process_exit: stream.process_exit,
        }
    }

    /// Preserve an observed root-process exit even if rendering already ended.
    /// This never reopens the stream or appends behind a terminal fault.
    pub fn observe_process_exit(&self, exit_code: Option<i32>) {
        {
            let mut state = self.0.hub.state.lock();
            let stream = state.streams.get_mut(&self.0.epoch).expect("live journal");
            stream.process_exit.get_or_insert(ProcessExit { exit_code });
        }
        let _ = self.append(StreamPayload::Closed { exit_code });
    }

    pub fn append(&self, mut payload: StreamPayload) -> Result<Sequence, StreamError> {
        let mut fault = None;
        if encoded_size(&payload, MAX_RECORD_BYTES).is_none() {
            payload = StreamPayload::Fault {
                reason: StreamFault::RecordTooLarge,
            };
            fault = Some(StreamError::RecordTooLarge);
        }
        let hub = &self.0.hub;
        let mut state = hub.state.lock();
        let order = state.next_order;
        // A u128 append clock cannot exhaust before every u64 stream counter;
        // nevertheless never wrap and change oldest-first eviction order.
        state.next_order = order.checked_add(1).ok_or(StreamError::SequenceExhausted)?;
        let (sequence, bytes) = {
            let stream = state.streams.get_mut(&self.0.epoch).expect("live journal");
            if stream.ended {
                return Err(StreamError::Ended);
            }
            let sequence = Sequence(
                stream
                    .high_water
                    .0
                    .checked_add(1)
                    .ok_or(StreamError::SequenceExhausted)?,
            );
            if sequence.0 == u64::MAX {
                payload = StreamPayload::Fault {
                    reason: StreamFault::SequenceExhausted,
                };
                fault = Some(StreamError::SequenceExhausted);
            }
            let mut record = StreamRecord {
                session_id: stream.metadata.session_id.clone(),
                incarnation: stream.metadata.incarnation.clone(),
                stream_epoch: stream.metadata.stream_epoch.clone(),
                sequence,
                observed_micros: hub.origin.elapsed().as_micros().min(u64::MAX as u128) as u64,
                payload,
            };
            // Charge complete serialized records, including identity/sequence
            // overhead, so tiny semantic events cannot evade the byte budget.
            let bytes = match encoded_size(&record, MAX_RECORD_BYTES) {
                Some(bytes) => bytes,
                None => {
                    record.payload = StreamPayload::Fault {
                        reason: StreamFault::RecordTooLarge,
                    };
                    fault = Some(StreamError::RecordTooLarge);
                    encoded_size(&record, MAX_RECORD_BYTES)
                        .expect("bounded metadata and a fault fit in a record")
                }
            };
            stream.termination = match &record.payload {
                StreamPayload::Closed { exit_code } => Some(StreamEnd::Closed {
                    exit_code: *exit_code,
                }),
                StreamPayload::Fault { reason } => Some(StreamEnd::Fault { reason: *reason }),
                _ => None,
            };
            stream.ended = stream.termination.is_some();
            if let Some(StreamEnd::Closed { exit_code }) = stream.termination {
                stream.process_exit.get_or_insert(ProcessExit { exit_code });
            }
            stream.high_water = sequence;
            stream.bytes += bytes;
            stream.records.push_back(StoredRecord {
                record,
                bytes,
                order,
            });
            (sequence, bytes)
        };
        state.bytes += bytes;
        state.oldest.insert(order, self.0.epoch.clone());
        while state.streams[&self.0.epoch].bytes > hub.limits.session_bytes
            || state.streams[&self.0.epoch].records.len() > hub.limits.session_records
        {
            state.evict_front(&self.0.epoch);
        }
        while state.bytes > hub.limits.global_bytes {
            let epoch = state
                .oldest
                .first_key_value()
                .expect("retained bytes have records")
                .1
                .clone();
            state.evict_front(&epoch);
        }
        drop(state);
        hub.changed.notify_all();
        match fault {
            Some(error) => Err(error),
            None => Ok(sequence),
        }
    }

    pub fn read_after(&self, after: Sequence) -> Result<Option<StreamRecord>, StreamError> {
        let state = self.0.hub.state.lock();
        let stream = &state.streams[&self.0.epoch];
        if after > stream.high_water {
            return Err(StreamError::FutureCursor);
        }
        if after == stream.high_water {
            return Ok(None);
        }
        let first = stream
            .records
            .front()
            .ok_or(StreamError::Gap)?
            .record
            .sequence;
        if after.0 < first.0 - 1 {
            return Err(StreamError::Gap);
        }
        let index = (after.0 - (first.0 - 1)) as usize;
        Ok(Some(stream.records[index].record.clone()))
    }

    /// For blocking delivery workers only. Recheck the predicate under the
    /// same lock as append, avoiding a missed wakeup between read and wait.
    pub fn wait_for_change(&self, after: Sequence, timeout: Duration) {
        let hub = &self.0.hub;
        let mut state = hub.state.lock();
        let deadline = Instant::now() + timeout;
        while state.streams[&self.0.epoch].high_water == after
            && !state.streams[&self.0.epoch].ended
        {
            if hub.changed.wait_until(&mut state, deadline).timed_out() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests;
