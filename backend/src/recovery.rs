//! Negotiated recovery transport. Installed in the public handler only with the
//! matching frontend cutover; it never dispatches legacy mutating commands.
use crate::{
    attachments::{Attachment, Denied, Ownership},
    outbound::{Outbound, OutboundHub, SendError},
    protocol::{self, AttachOutcome, Client, Descriptor, ResumeCursor},
    tombstones::Tombstones,
    SessionsMap,
};
mod attach;
mod history;
mod legacy;
use doom_term_pty::{
    stream::{Identity, ProcessExit, Sequence, StreamJournal, StreamPayload},
    PtySession,
};
use futures_util::{SinkExt, StreamExt};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame},
        Message,
    },
    WebSocketStream,
};

pub struct RecoveryServer {
    pub sessions: SessionsMap,
    pub usage: crate::UsageHandle,
    pub hooks: Arc<crate::hooks::HookHub>,
    epoch: Identity,
    outbound: OutboundHub,
    catalog: Mutex<Catalog>,
    metadata_workers: Arc<tokio::sync::Semaphore>,
}

#[cfg(test)]
mod pump_tests {
    use super::*;
    use doom_term_pty::stream::{JournalHub, StreamMetadata};

    #[cfg(unix)]
    fn isolated(test: &str) -> bool {
        if std::env::var_os("DOOM_PUMP_TEST_CHILD").is_some() {
            return false;
        }
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("recovery::pump_tests::{test}"),
                "--nocapture",
            ])
            .env("DOOM_PUMP_TEST_CHILD", "1")
            .env("DOOM_TERM_NO_TMUX", "1")
            .env("DOOM_TERM_NO_SHELL_INTEGRATION", "1")
            .env_remove("ENV")
            .env_remove("BASH_ENV")
            .env_remove("TMUX")
            .env_remove("TMUX_PANE")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        true
    }

    #[tokio::test]
    async fn an_ack_cannot_overtake_a_caught_up_frame_waiting_for_queue_capacity() {
        let journal = JournalHub::default()
            .open(
                StreamMetadata::new("cut".into(), Identity::random().unwrap(), 80, 24, false)
                    .unwrap(),
            )
            .unwrap();
        let snapshot = journal.snapshot();
        let owner = Arc::new(Mutex::new(Ownership::default()));
        let attachment = owner
            .lock()
            .acquire(
                Identity::random().unwrap(),
                snapshot.metadata.incarnation.clone(),
            )
            .unwrap();
        let hub = OutboundHub::default();
        let (tx, mut rx) = hub.channel();
        for _ in 0..127 {
            tx.send(&"occupied").await.unwrap();
        }
        let before = tx.pending_bytes();
        let task = tokio::spawn(
            Pump {
                journal,
                owner: owner.clone(),
                attachment: attachment.clone(),
                descriptor: Descriptor {
                    metadata: snapshot.metadata,
                    clock_epoch: snapshot.clock_epoch,
                },
                kind: AttachOutcome::ReplayFromStart,
                cursor: Sequence::default(),
                cut: Sequence::default(),
                archive: None,
            }
            .run(tx.clone()),
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while tx.pending_bytes() == before {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            owner.lock().acknowledge(&attachment, Sequence::default()),
            Err(Denied::InvalidCut),
            "StreamBegin exposes the cut but cannot authorize an early acknowledgement"
        );
        drop(rx.recv().await.unwrap());
        for _ in 0..126 {
            drop(rx.recv().await.unwrap());
        }
        assert!(rx.recv().await.unwrap().text.contains("StreamBegin"));
        assert!(rx.recv().await.unwrap().text.contains("StreamCaughtUp"));
        assert_eq!(
            owner.lock().acknowledge(&attachment, Sequence::default()),
            Ok(())
        );
        tx.close(SendError::Closed);
        task.await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_slow_consumer_overflows_at_the_production_cap_without_stopping_the_child() {
        if isolated("a_slow_consumer_overflows_at_the_production_cap_without_stopping_the_child") {
            return;
        }
        let session = PtySession::create(
            "slow-consumer".into(),
            80,
            24,
            None,
            Some("/bin/cat".into()),
        )
        .unwrap();
        let journal = session.stream();
        for _ in 0..72 {
            journal
                .append(StreamPayload::Event(doom_term_pty::DemuxEvent::Output {
                    data: "x".repeat(60_000),
                }))
                .unwrap();
        }
        let snapshot = journal.snapshot();
        assert!(snapshot.retained_bytes < 8 * 1024 * 1024);

        let owner = Arc::new(Mutex::new(Ownership::default()));
        let attachment = owner
            .lock()
            .acquire(
                Identity::random().unwrap(),
                snapshot.metadata.incarnation.clone(),
            )
            .unwrap();
        let hub = OutboundHub::default();
        let (tx, inbox) = hub.channel();
        let task = tokio::spawn(
            Pump {
                journal: journal.clone(),
                owner,
                attachment,
                descriptor: Descriptor {
                    metadata: snapshot.metadata,
                    clock_epoch: snapshot.clock_epoch,
                },
                kind: AttachOutcome::ReplayFromStart,
                cursor: Sequence::default(),
                cut: snapshot.high_water,
                archive: None,
            }
            .run(tx.clone()),
        );

        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), tx.closed())
                .await
                .expect("the undrained attachment must reach its byte cap"),
            SendError::Overflow
        );
        assert!(tx.pending_bytes() <= 4 * 1024 * 1024);
        assert!(
            tx.pending_bytes() > 4 * 1024 * 1024 - 65_536,
            "whole-frame admission should stop within one maximum record of the cap"
        );
        assert!(
            session.is_alive(),
            "attachment overflow must not stop the PTY"
        );

        session.write(b"CHILD_STILL_RUNNING\n").unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let mut cursor = snapshot.high_water;
                while let Some(record) = journal.read_after(cursor).unwrap() {
                    cursor = record.sequence;
                    if matches!(record.payload, StreamPayload::Event(doom_term_pty::DemuxEvent::Output { ref data }) if data.contains("CHILD_STILL_RUNNING")) {
                        return;
                    }
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the child must still accept and emit input after its consumer is dropped");

        drop(inbox);
        task.await.unwrap();
        session.kill().unwrap();
    }
}
#[derive(Default)]
struct Catalog {
    sockets: HashSet<Identity>,
    creating: HashMap<String, Identity>,
    owners: HashMap<String, Arc<Mutex<Ownership>>>,
    tombstones: Tombstones,
}
struct Reservation {
    server: Arc<RecoveryServer>,
    id: String,
    token: Identity,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut catalog = self.server.catalog.lock();
        if catalog.creating.get(&self.id) == Some(&self.token) {
            catalog.creating.remove(&self.id);
        }
    }
}
struct ConnectionLease {
    server: Arc<RecoveryServer>,
    socket: Identity,
}
impl Drop for ConnectionLease {
    fn drop(&mut self) {
        self.server.catalog.lock().sockets.remove(&self.socket);
        let owners: Vec<_> = self
            .server
            .catalog
            .lock()
            .owners
            .values()
            .cloned()
            .collect();
        for owner in owners {
            owner.lock().release_socket(&self.socket);
        }
    }
}

fn denied_code(error: Denied) -> &'static str {
    match error {
        Denied::Busy => "busy",
        Denied::Stale => "stale",
        Denied::NotReady => "not-ready",
        Denied::InvalidCut => "invalid-cut",
        Denied::Unavailable => "unavailable",
    }
}
fn operation_error(id: &str, action: &str, code: &str) -> Value {
    json!({"event":"OperationError","data":{"session_id":id,"action":action,"code":code}})
}

struct Pump {
    journal: StreamJournal,
    owner: Arc<Mutex<Ownership>>,
    attachment: Attachment,
    descriptor: Descriptor,
    kind: AttachOutcome,
    cursor: Sequence,
    cut: Sequence,
    archive: Option<Result<doom_term_pty::tmux::CapturedArchive, String>>,
}
impl Pump {
    async fn run(mut self, tx: Outbound) {
        let id = self.descriptor.metadata.session_id.clone();
        let envelope = |event: &str, sequence: Sequence| {
            json!({"event":event,"data":{"session_id":id,
            "incarnation":self.attachment.incarnation,"attachment_id":self.attachment.attachment_id,"sequence":sequence}})
        };
        let begin = json!({"event":"StreamBegin","data":{"session_id":id,"incarnation":self.attachment.incarnation,
            "attachment_id":self.attachment.attachment_id,"descriptor":self.descriptor,"kind":self.kind,"cut":self.cut}});
        if tx.send(&begin).await.is_err() {
            return;
        }
        if let Some(archive) = self.archive.take() {
            if !history::transfer(&tx, &id, &self.attachment, archive).await {
                return;
            }
        }
        let mut caught_up = false;
        loop {
            if self
                .owner
                .lock()
                .authorize(&self.attachment, false)
                .is_err()
            {
                return;
            }
            if !caught_up && self.cursor == self.cut {
                let Ok(pending) = tx.prepare(&envelope("StreamCaughtUp", self.cut)).await else {
                    return;
                };
                // Capacity and encoding are acquired before offering the cut.
                // Queue commit and ownership publication are one synchronous
                // critical section; neither socket I/O nor an await is inside.
                let mut owner = self.owner.lock();
                if owner.offer_cut(&self.attachment, self.cut).is_err() {
                    return;
                }
                pending.enqueue();
                drop(owner);
                caught_up = true;
            }
            match self.journal.read_after(self.cursor) {
                Ok(Some(record)) => {
                    let ended = matches!(
                        &record.payload,
                        StreamPayload::Closed { .. }
                            | StreamPayload::Fault { .. }
                            | StreamPayload::Event(doom_term_pty::DemuxEvent::StreamFault { .. })
                    );
                    if ended {
                        self.owner.lock().invalidate_stream(&self.attachment);
                    }
                    let sequence = record.sequence;
                    let event = json!({"event":"StreamRecord","data":{"attachment_id":self.attachment.attachment_id,
                        "phase":if caught_up {"live"} else {"catch-up"},"record":record}});
                    if tx.send(&event).await.is_err() {
                        return;
                    }
                    self.cursor = sequence;
                    if ended {
                        return;
                    }
                }
                Ok(None) => {
                    let journal = self.journal.clone();
                    let cursor = self.cursor;
                    tokio::select! {
                        _ = tx.closed() => return,
                        _ = tokio::task::spawn_blocking(move || journal.wait_for_change(cursor, Duration::from_millis(250))) => {},
                    }
                }
                Err(_) => {
                    self.owner.lock().invalidate_stream(&self.attachment);
                    let _ = tx.send(&json!({"event":"StreamUnavailable","data":{"session_id":id,
                        "incarnation":self.attachment.incarnation,"attachment_id":self.attachment.attachment_id,"reason":"Stream gap; reconstruction is required"}})).await;
                    return;
                }
            }
        }
    }
}
impl RecoveryServer {
    pub async fn maintain(self: Arc<Self>) {
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tick.tick().await;
            let now = Instant::now();
            let observed: Vec<_> = self
                .sessions
                .read()
                .iter()
                .map(|(id, session)| (id.clone(), session.clone()))
                .collect();
            self.catalog.lock().tombstones.prune(now);
            for (id, session) in observed {
                let journal = session.stream();
                if journal.snapshot().process_exit.is_none() {
                    continue;
                }
                let mut catalog = self.catalog.lock();
                let mut sessions = self.sessions.write();
                // Late lifecycle observations belong to this exact adapter,
                // not a replacement under the same logical workspace id.
                if sessions
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
                {
                    catalog.tombstones.insert(journal, now);
                    sessions.remove(&id);
                    catalog.owners.remove(&id);
                }
            }
        }
    }
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            usage: Arc::new(crate::usage::service::UsageService::new()),
            hooks: Arc::new(crate::hooks::HookHub::default()),
            epoch: Identity::random()?,
            outbound: OutboundHub::default(),
            catalog: Mutex::new(Catalog::default()),
            metadata_workers: Arc::new(tokio::sync::Semaphore::new(8)),
        })
    }

    async fn metadata(
        &self,
        timeout: Duration,
        fallback: Value,
        work: impl FnOnce() -> Value + Send + 'static,
    ) -> Value {
        // A blocked filesystem may not support cancellation. Its worker keeps
        // the admission permit even after the socket/deadline disappears, so
        // repeated requests cannot grow a detached blocking backlog.
        let Ok(permit) = self.metadata_workers.clone().try_acquire_owned() else {
            return fallback;
        };
        let task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        });
        tokio::time::timeout(timeout, task)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(fallback)
    }

    fn dispatch_metadata(
        self: Arc<Self>,
        workers: &mut tokio::task::JoinSet<()>,
        tx: Outbound,
        timeout: Duration,
        fallback: Value,
        work: impl FnOnce() -> Value + Send + 'static,
    ) {
        workers.spawn(async move {
            let reply = tokio::select! {
                biased;
                _ = tx.closed() => return,
                reply = self.metadata(timeout, fallback, work) => reply,
            };
            let _ = tx.send(&reply).await;
        });
    }
    pub async fn accept(
        self: Arc<Self>,
        stream: TcpStream,
        port: u16,
        required_token: Option<String>,
    ) {
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(protocol::MAX_WIRE_BYTES))
            .max_frame_size(Some(protocol::MAX_WIRE_BYTES));
        let upgrade = tokio_tungstenite::accept_hdr_async_with_config(
            stream,
            move |request: &_, response| crate::security::validate_upgrade(request, response, port),
            Some(config),
        );
        if let Ok(Ok(ws)) = tokio::time::timeout(Duration::from_secs(5), upgrade).await {
            self.connection(ws, required_token).await;
        }
    }
    async fn connection(
        self: Arc<Self>,
        ws: WebSocketStream<TcpStream>,
        required_token: Option<String>,
    ) {
        let Ok(socket) = Identity::random() else {
            return;
        };
        let lease = ConnectionLease {
            server: self.clone(),
            socket: socket.clone(),
        };
        self.catalog.lock().sockets.insert(socket.clone());
        let (mut sink, mut source) = ws.split();
        let (tx, mut inbox) = self.outbound.channel();
        // One empty transport ping may wait for the writer. Native browser
        // pong handling stays active even when page timers are throttled.
        let (control_tx, mut control_rx) = tokio::sync::mpsc::channel(1);
        let (last_seen, mut seen) = tokio::sync::watch::channel(tokio::time::Instant::now());
        let auth_state = Arc::new(AtomicBool::new(required_token.is_none()));
        // JoinSet owns cancellation: dropping a connection future cannot leave
        // a detached writer holding the socket or its charged frames forever.
        let mut workers = tokio::task::JoinSet::new();
        // Socket reads must remain live while a PTY operation is blocked. The
        // ordered dispatcher holds each admission charge through execution;
        // neither item-count nor byte overflow becomes an offline input queue.
        let (commands, mut incoming) = tokio::sync::mpsc::channel(128);
        let input_bytes = Arc::new(tokio::sync::Semaphore::new(8 * 1024 * 1024));
        {
            let sender = tx.clone();
            workers.spawn(async move {
                loop {
                    let message = tokio::select! {
                        _ = sender.closed() => return,
                        message = source.next() => message,
                    };
                    let Some(Ok(message)) = message else {
                        break;
                    };
                    last_seen.send_replace(tokio::time::Instant::now());
                    if matches!(message, Message::Close(_)) {
                        break;
                    }
                    let Message::Text(text) = message else {
                        continue;
                    };
                    let Ok(bytes) = u32::try_from(text.len()) else {
                        sender.close(SendError::InboundOverflow);
                        return;
                    };
                    let Ok(charge) = input_bytes.clone().try_acquire_many_owned(bytes) else {
                        sender.close(SendError::InboundOverflow);
                        return;
                    };
                    if commands.try_send((text, charge)).is_err() {
                        sender.close(SendError::InboundOverflow);
                        return;
                    }
                }
                sender.close(SendError::Closed);
            });
        }
        let sender = tx.clone();
        workers.spawn(async move {
            let reason = loop {
                let mut held_frame = None;
                let message = tokio::select! {
                    reason = sender.closed() => break reason,
                    control = control_rx.recv() => match control { Some(message) => message, None => break SendError::Closed },
                    frame = inbox.recv() => {
                        let Some(mut frame) = frame else { break SendError::Closed; };
                        let message = Message::Text(std::mem::take(&mut frame.text).into());
                        held_frame = Some(frame);
                        message
                    },
                };
                let result = tokio::select! {
                    reason = sender.closed() => break reason,
                    result = tokio::time::timeout(Duration::from_secs(10), sink.send(message)) => result,
                };
                // frame retains its byte charge throughout the await above.
                drop(held_frame);
                if !matches!(result, Ok(Ok(()))) { break SendError::Closed; }
            };
            sender.close(reason);
            // The heartbeat may have closed its control channel in the same
            // tick as expiry. Preserve the first recorded failure, regardless
            // of which ready select branch the writer happened to observe.
            let reason = sender.closed().await;
            let reason = match reason {
                SendError::Overflow => "Outbound overflow; process remains alive",
                SendError::Timeout => "Liveness deadline expired; process remains alive",
                SendError::Serialization => "Outbound encoding failed; process remains alive",
                SendError::Closed => "Attachment connection closed",
                SendError::InboundOverflow => "Inbound overflow; pending operations discarded",
            };
            let _ = tokio::time::timeout(Duration::from_millis(250), sink.send(Message::Close(Some(CloseFrame {
                code: CloseCode::Policy, reason: reason.into(),
            })))).await;
        });
        {
            let sender = tx.clone();
            let auth_state = auth_state.clone();
            workers.spawn(async move {
                let started = tokio::time::Instant::now();
                let mut heartbeat = tokio::time::interval_at(
                    started + Duration::from_secs(10),
                    Duration::from_secs(10),
                );
                heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    // Expiry is a deadline from the last observed frame, not
                    // rounded up to the next ten-second heartbeat tick.
                    let mut expiry = *seen.borrow_and_update() + Duration::from_secs(30);
                    if !auth_state.load(Ordering::Relaxed) { expiry = expiry.min(started + Duration::from_secs(60)); }
                    tokio::select! {
                        _ = sender.closed() => return,
                        _ = tokio::time::sleep_until(expiry) => { sender.close(SendError::Timeout); return; }
                        changed = seen.changed() => { if changed.is_err() { return; } continue; }
                        _ = heartbeat.tick() => {},
                    }
                    if control_tx
                        .try_send(Message::Ping(Vec::new().into()))
                        .is_err()
                    {
                        sender.close(SendError::Overflow);
                        return;
                    }
                }
            });
        }
        let mut authenticated = required_token.is_none();
        let mut negotiated = false;
        let advertised = json!({"event":"Protocol","data":{"version":2,"daemon_epoch":self.epoch}});
        let initial = if authenticated {
            advertised.clone()
        } else {
            json!({"event":"AuthResult","data":{"success":false,"message":"Authentication required"}})
        };
        if tx.send(&initial).await.is_err() {
            return;
        }
        loop {
            let next = tokio::select! {
                _ = tx.closed() => break,
                next = incoming.recv() => next,
                _ = workers.join_next(), if !workers.is_empty() => continue,
            };
            let Some((text, _input_charge)) = next else {
                break;
            };
            let command = if !authenticated && text.len() > 65536 {
                Err("Authentication required")
            } else {
                protocol::parse(&text)
            };
            if !authenticated {
                authenticated = matches!(&command, Ok(Client::Auth { token }) if required_token.as_ref() == Some(token));
                auth_state.store(authenticated, Ordering::Relaxed);
                let reply = json!({"event":"AuthResult","data":{"success":authenticated,"message":if authenticated {"Authenticated"} else {"Authentication required"}}});
                if tx.send(&reply).await.is_err() {
                    break;
                }
                if authenticated && tx.send(&advertised).await.is_err() {
                    break;
                }
                continue;
            }
            let dispatch = async {
                let mut pump = None;
                let mut hooks = None;
                let reply = match command {
                    Ok(Client::Negotiate { version: 2 }) if !negotiated => {
                        negotiated = true;
                        hooks = Some(self.hooks.subscribe());
                        json!({"event":"Negotiated","data":{"version":2,"daemon_epoch":self.epoch}})
                    }
                    Ok(Client::ListSessions { request_id }) if negotiated => {
                        let server = self.clone();
                        let failed = json!({"event":"SessionListing","data":{"request_id":request_id,"sessions":[],"discovery_error":"Discovery failed; inventory is unknown"}});
                        tokio::task::spawn_blocking(move || server.listing(request_id))
                            .await
                            .unwrap_or(failed)
                    }
                    Ok(Client::Ping) if negotiated => json!({"event":"Pong"}),
                    Ok(Client::BrowseDirectory { request_id, path }) if negotiated => {
                        let fallback = json!({"event":"DirectoryListing","data":{"request_id":request_id,"current_path":path,"parent_path":null,"entries":[],"truncated":true,"error":"Directory unavailable; inventory is unknown"}});
                        self.clone().dispatch_metadata(
                            &mut workers,
                            tx.clone(),
                            Duration::from_secs(3),
                            fallback,
                            move || crate::metadata::browse(request_id, path),
                        );
                        return None;
                    }
                    Ok(Client::GetTelemetry {
                        cwd,
                        session_id,
                        incarnation,
                    }) if negotiated => {
                        let session = session_id
                            .as_ref()
                            .and_then(|id| self.sessions.read().get(id).cloned())
                            .filter(|session| {
                                Some(&session.stream().snapshot().metadata.incarnation)
                                    == incarnation.as_ref()
                            });
                        let usage = self.usage.clone();
                        let fallback = json!({"event":"TelemetryUnavailable","data":{"session_id":session_id,"incarnation":incarnation}});
                        self.clone().dispatch_metadata(
                            &mut workers,
                            tx.clone(),
                            Duration::from_secs(3),
                            fallback,
                            move || {
                                let mut reply = serde_json::to_value(crate::metadata::telemetry(
                                    cwd, session_id, session, &usage,
                                ))
                                .unwrap();
                                reply["data"]["incarnation"] = json!(incarnation);
                                reply
                            },
                        );
                        return None;
                    }
                    Ok(Client::CreateWorktree {
                        request_id,
                        cwd,
                        branch,
                    }) if negotiated => {
                        let fallback = json!({"event":"WorktreeCreated","data":{"request_id":request_id,"path":null,"branch":null,"error":"Worktree outcome unknown; inspect the repository before retrying"}});
                        self.clone().dispatch_metadata(
                            &mut workers,
                            tx.clone(),
                            Duration::from_secs(25),
                            fallback,
                            move || crate::metadata::create_worktree(request_id, cwd, branch),
                        );
                        return None;
                    }
                    Ok(Client::Create {
                        request_id,
                        id,
                        cols,
                        rows,
                        cwd,
                        shell,
                    }) if negotiated => {
                        let server = self.clone();
                        match tokio::task::spawn_blocking(move || {
                            server.create(request_id, id, cols, rows, cwd, shell)
                        })
                        .await
                        {
                            Ok(reply) => reply,
                            Err(_) => {
                                json!({"event":"Error","data":{"message":"Create outcome unknown; do not retry automatically"}})
                            }
                        }
                    }
                    Ok(Client::RecoverLegacy {
                        request_id,
                        id,
                        pane,
                        root_pid,
                    }) if negotiated => {
                        let server = self.clone();
                        let failure = json!({"event":"RecoverLegacyResult","data":{"request_id":request_id,
                            "session_id":id,"incarnation":null,"error":{"code":"failed-unknown"}}});
                        tokio::task::spawn_blocking(move || {
                            server.recover_legacy(request_id, id, pane, root_pid)
                        })
                        .await
                        .unwrap_or(failure)
                    }
                    Ok(Client::Attach {
                        request_id,
                        id,
                        incarnation,
                        resume,
                    }) if negotiated => {
                        let server = self.clone();
                        let socket = socket.clone();
                        let failure = json!({"event":"AttachResult","data":{"request_id":request_id,"session_id":id,"outcome":"failed","attachment_id":null,"descriptor":null}});
                        let (reply, planned) = tokio::task::spawn_blocking(move || {
                            server.attach(&socket, request_id, id, incarnation, resume)
                        })
                        .await
                        .unwrap_or((failure, None));
                        pump = planned;
                        reply
                    }
                    Ok(Client::StreamApplied {
                        id,
                        incarnation,
                        attachment_id,
                        sequence,
                    }) if negotiated => {
                        let attachment = Attachment {
                            socket_id: socket.clone(),
                            incarnation,
                            attachment_id,
                        };
                        match self.authorized(&id, &attachment, false).and_then(
                            |(session, owner)| {
                                if session.stream().snapshot().ended || !session.is_alive() {
                                    owner.lock().invalidate_stream(&attachment);
                                    return Err(Denied::NotReady);
                                }
                                owner.lock().acknowledge(&attachment, sequence)
                            },
                        ) {
                            Ok(()) => {
                                json!({"event":"AttachmentReady","data":{"session_id":id,"incarnation":attachment.incarnation,
                            "attachment_id":attachment.attachment_id,"sequence":sequence}})
                            }
                            Err(error) => operation_error(&id, "StreamApplied", denied_code(error)),
                        }
                    }
                    Ok(Client::Write {
                        id,
                        incarnation,
                        attachment_id,
                        data,
                    }) if negotiated => {
                        let attachment = Attachment {
                            socket_id: socket.clone(),
                            incarnation,
                            attachment_id,
                        };
                        let server = self.clone();
                        let target_id = id.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            // Execution-time lookup and authorization, not merely
                            // admission before this blocking operation was queued.
                            let (session, _) = server
                                .authorized(&target_id, &attachment, true)
                                .map_err(denied_code)?;
                            session
                                .write_checked(data.as_bytes(), || {
                                    server
                                        .authorized(&target_id, &attachment, true)
                                        .map(|_| ())
                                        .map_err(|error| anyhow::anyhow!(denied_code(error)))
                                })
                                .map_err(|_| "failed-unknown")
                        })
                        .await;
                        match result {
                            Ok(Ok(())) => return None,
                            Ok(Err(code)) => operation_error(&id, "Write", code),
                            Err(_) => operation_error(&id, "Write", "failed-unknown"),
                        }
                    }
                    Ok(Client::Paste {
                        request_id,
                        id,
                        incarnation,
                        attachment_id,
                        text,
                    }) if negotiated => {
                        let attachment = Attachment {
                            socket_id: socket.clone(),
                            incarnation,
                            attachment_id,
                        };
                        let server = self.clone();
                        let target = id.clone();
                        let error = if text.len() > doom_term_pty::paste::MAX_PASTE_BYTES {
                            Some("Paste exceeds the 1 MiB limit".to_string())
                        } else {
                            match tokio::task::spawn_blocking(move || {
                                let (session, _) =
                                    server.authorized(&target, &attachment, true).map_err(
                                        |error| format!("Paste refused: {}", denied_code(error)),
                                    )?;
                                session
                                    .paste_checked(&text, || {
                                        server
                                            .authorized(&target, &attachment, true)
                                            .map(|_| ())
                                            .map_err(|error| {
                                                anyhow::anyhow!(
                                                    "Paste refused: {}",
                                                    denied_code(error)
                                                )
                                            })
                                    })
                                    .map_err(|error| error.to_string())
                            })
                            .await
                            {
                                Ok(result) => result.err(),
                                Err(_) => {
                                    Some("Paste outcome unknown; do not retry automatically".into())
                                }
                            }
                        };
                        json!({"event":"PasteResult","data":{"request_id":request_id,"session_id":id,"error":error}})
                    }
                    Ok(Client::Resize {
                        id,
                        incarnation,
                        attachment_id,
                        cols,
                        rows,
                    }) if negotiated => {
                        let attachment = Attachment {
                            socket_id: socket.clone(),
                            incarnation,
                            attachment_id,
                        };
                        let server = self.clone();
                        let target = id.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            let (session, _) = server
                                .authorized(&target, &attachment, true)
                                .map_err(denied_code)?;
                            session
                                .resize_checked(cols, rows, || {
                                    server
                                        .authorized(&target, &attachment, true)
                                        .map(|_| ())
                                        .map_err(|error| anyhow::anyhow!(denied_code(error)))
                                })
                                .map_err(|_| "failed-unknown")
                        })
                        .await;
                        match result {
                            Ok(Ok(())) => return None,
                            Ok(Err(code)) => operation_error(&id, "Resize", code),
                            Err(_) => operation_error(&id, "Resize", "failed-unknown"),
                        }
                    }
                    Ok(Client::Signal {
                        id,
                        incarnation,
                        attachment_id,
                        signal,
                    }) if negotiated => {
                        let attachment = Attachment {
                            socket_id: socket.clone(),
                            incarnation,
                            attachment_id,
                        };
                        let server = self.clone();
                        let target = id.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            let (session, _) = server
                                .authorized(&target, &attachment, true)
                                .map_err(denied_code)?;
                            session
                                .send_signal_checked(&signal, || {
                                    server
                                        .authorized(&target, &attachment, true)
                                        .map(|_| ())
                                        .map_err(|error| anyhow::anyhow!(denied_code(error)))
                                })
                                .map_err(|_| "failed-unknown")
                        })
                        .await;
                        match result {
                            Ok(Ok(())) => return None,
                            Ok(Err(code)) => operation_error(&id, "Signal", code),
                            Err(_) => operation_error(&id, "Signal", "failed-unknown"),
                        }
                    }
                    Ok(Client::Kill {
                        request_id,
                        id,
                        incarnation,
                        attachment_id,
                    }) if negotiated => {
                        let attachment = Attachment {
                            socket_id: socket.clone(),
                            incarnation,
                            attachment_id,
                        };
                        let server = self.clone();
                        let target = id.clone();
                        let result = tokio::task::spawn_blocking(move || {
                            let (session, _) = server
                                .authorized(&target, &attachment, false)
                                .map_err(denied_code)?;
                            if session.stream().snapshot().process_exit.is_some() {
                                return Err("closed");
                            }
                            session.kill().map_err(|_| "failed-unknown")
                        })
                        .await;
                        let error = match result {
                            Ok(result) => result.err(),
                            Err(_) => Some("failed-unknown"),
                        };
                        json!({"event":"KillResult","data":{"request_id":request_id,"session_id":id,"error":error}})
                    }
                    _ => {
                        json!({"event":"Incompatible","data":{"message":"Negotiated protocol v2 is required; legacy commands are refused"}})
                    }
                };
                Some((reply, pump, hooks))
            };
            let result = tokio::select! {
                biased;
                _ = tx.closed() => break,
                result = dispatch => result,
            };
            let Some((reply, pump, hooks)) = result else {
                continue;
            };
            if tx.send(&reply).await.is_err() {
                break;
            }
            if let Some(hooks) = hooks {
                workers.spawn(crate::hooks::forward(hooks, tx.clone()));
            }
            if let Some(pump) = pump {
                workers.spawn(pump.run(tx.clone()));
            }
        }
        tx.close(SendError::Closed);
        // Release before waiting for writers/pumps. Accepted blocking work may
        // have an unknown outcome, but queued commands lose this lease now.
        drop(lease);
        drop(incoming);
        // Allow a bounded explicit close; cancellation still drops JoinSet and
        // aborts every owned writer/pump. Neither path kills a user process.
        let _ = tokio::time::timeout(Duration::from_millis(500), async {
            while workers.join_next().await.is_some() {}
        })
        .await;
    }

    fn create(
        self: Arc<Self>,
        request_id: String,
        id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
    ) -> Value {
        let failure = |code: &str| {
            json!({"event":"CreateResult","data":{"request_id":request_id,"session_id":id,
            "incarnation":null,"error":{"code":code}}})
        };
        let reservation = {
            let mut catalog = self.catalog.lock();
            if catalog.creating.contains_key(&id) || self.sessions.read().contains_key(&id) {
                return failure("conflict");
            }
            let Ok(token) = Identity::random() else {
                return failure("unavailable");
            };
            catalog.creating.insert(id.clone(), token.clone());
            Reservation {
                server: self.clone(),
                id: id.clone(),
                token,
            }
        };
        let session = match PtySession::create(id.clone(), cols, rows, cwd, shell) {
            Ok(session) => Arc::new(session),
            Err(_) => return failure("failed-unknown"),
        };
        let incarnation = session.stream().snapshot().metadata.incarnation;
        {
            let mut catalog = self.catalog.lock();
            // Reservation lives in this worker, even when its socket disappears.
            // A lost reply never implies permission to discard or rerun creation.
            catalog
                .owners
                .insert(id.clone(), Arc::new(Mutex::new(Ownership::default())));
            self.sessions.write().insert(id.clone(), session);
        }
        drop(reservation);
        json!({"event":"CreateResult","data":{"request_id":request_id,"session_id":id,"incarnation":incarnation,"error":null}})
    }

    fn authorized(
        &self,
        id: &str,
        attachment: &Attachment,
        ready: bool,
    ) -> Result<(Arc<PtySession>, Arc<Mutex<Ownership>>), Denied> {
        let owner = self
            .catalog
            .lock()
            .owners
            .get(id)
            .cloned()
            .ok_or(Denied::Stale)?;
        let session = self.sessions.read().get(id).cloned().ok_or(Denied::Stale)?;
        if session.stream().snapshot().metadata.incarnation != attachment.incarnation {
            return Err(Denied::Stale);
        }
        owner.lock().authorize(attachment, ready)?;
        if ready && (!session.is_alive() || session.stream().snapshot().ended) {
            owner.lock().invalidate_stream(attachment);
            return Err(Denied::NotReady);
        }
        Ok((session, owner))
    }
}
