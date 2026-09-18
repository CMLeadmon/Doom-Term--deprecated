//! Exact attach/rebuild admission. Reservations live through cancelled awaits.
use super::*;
use doom_term_pty::tmux::AttachError;

impl Gateway {
    pub(super) fn listing(&self, request_id: String) -> Value {
        let (mut sessions, discovery_error) = match PtySession::discover_durable() {
            Ok(panes) => (
                panes
                    .into_iter()
                    .map(|pane| {
                        let mut value = json!(pane);
                        value["durable"] = json!(true);
                        value["stream"] = Value::Null;
                        value
                    })
                    .collect::<Vec<_>>(),
                None,
            ),
            Err(_) => (
                Vec::new(),
                Some("Durable discovery unavailable; inventory may be incomplete"),
            ),
        };
        // No tmux helper runs under a shared session/catalog lock.
        for (id, session) in self.sessions.read().iter() {
            let snapshot = session.stream().snapshot();
            if snapshot.process_exit.is_some() {
                continue;
            }
            let incarnation = snapshot.metadata.incarnation.as_str();
            let stream = json!(Descriptor {
                metadata: snapshot.metadata.clone(),
                clock_epoch: snapshot.clock_epoch
            });
            if let Some(discovered) = sessions
                .iter_mut()
                .find(|row| row["id"] == *id && row["incarnation"] == incarnation)
            {
                discovered["stream"] = stream;
            } else {
                sessions.push(json!({"id":id,"incarnation":incarnation,"durable":snapshot.metadata.durable,"stream":stream}));
            }
        }
        json!({"event":"SessionListing","data":{"request_id":request_id,"sessions":sessions,"discovery_error":discovery_error}})
    }
    pub(super) fn attach(
        self: Arc<Self>,
        socket: &Identity,
        request_id: String,
        id: String,
        incarnation: Identity,
        resume: Option<ResumeCursor>,
    ) -> (Value, Option<Pump>) {
        let refused = |outcome: AttachOutcome| {
            (
                json!({"event":"AttachResult","data":{
            "request_id":request_id,"session_id":id,"outcome":outcome,"attachment_id":null,"descriptor":null}}),
                None,
            )
        };
        let closed = |exit_code: Option<i32>| {
            (
                json!({"event":"AttachResult","data":{
            "request_id":request_id,"session_id":id,"incarnation":incarnation,"outcome":AttachOutcome::Closed,
            "exit_code":exit_code,"attachment_id":null,"descriptor":null}}),
                None,
            )
        };
        // Acquire a lifecycle lease AND a bootstrap reservation before any
        // subprocess work. A disconnected worker may finish its accepted
        // rebuild, but cannot invent a new socket lease after disconnection.
        let (reservation, owner, attachment, existing) = {
            let mut catalog = self.catalog.lock();
            if !catalog.sockets.contains(socket) {
                return refused(AttachOutcome::Failed);
            }
            if catalog.creating.contains_key(&id) {
                return refused(AttachOutcome::Busy);
            }
            let existing = self.sessions.read().get(&id).cloned();
            if let Some(session) = &existing {
                let snapshot = session.stream().snapshot();
                if snapshot.metadata.incarnation != incarnation {
                    return refused(AttachOutcome::Replaced);
                }
                if let Some(ProcessExit { exit_code }) = snapshot.process_exit {
                    return closed(exit_code);
                }
            }
            let owner = catalog.owners.entry(id.clone()).or_default().clone();
            let attachment = match owner.lock().acquire(socket.clone(), incarnation.clone()) {
                Ok(attachment) => attachment,
                Err(Denied::Busy) => return refused(AttachOutcome::Busy),
                Err(_) => return refused(AttachOutcome::Failed),
            };
            let token = attachment.attachment_id.clone();
            catalog.creating.insert(id.clone(), token.clone());
            let reservation = Reservation {
                server: self.clone(),
                id: id.clone(),
                token,
            };
            (reservation, owner, attachment, existing)
        };
        let failure = |outcome| {
            owner.lock().release_socket(socket);
            // Failed unknown ids must not accumulate unbounded owner slots.
            let mut catalog = self.catalog.lock();
            if !self.sessions.read().contains_key(&id) {
                catalog.owners.remove(&id);
            }
            refused(outcome)
        };
        let mut cursor = Sequence::default();
        let mut kind = AttachOutcome::Rebuild;
        if let Some(session) = &existing {
            let journal = session.stream();
            let snapshot = journal.snapshot();
            let same_epoch = resume
                .as_ref()
                .is_some_and(|cursor| cursor.stream_epoch == snapshot.metadata.stream_epoch);
            if same_epoch {
                cursor = resume.as_ref().unwrap().after_sequence;
            }
            if cursor > snapshot.high_water {
                return failure(AttachOutcome::Failed);
            }
            if !snapshot.ended && journal.read_after(cursor).is_ok() && session.is_alive() {
                kind = if same_epoch {
                    AttachOutcome::Resume
                } else {
                    AttachOutcome::ReplayFromStart
                };
            } else if !snapshot.metadata.durable {
                kind = AttachOutcome::Unreconstructable;
            }
        }
        let session = if kind == AttachOutcome::Rebuild {
            match PtySession::rebuild_durable(id.clone(), &incarnation, existing.as_deref()) {
                Ok(rebuilt) => {
                    let session = Arc::new(rebuilt.session);
                    // The reservation excludes create/attach replacement. A
                    // late old-adapter close is fenced by Arc identity in maintain.
                    self.sessions.write().insert(id.clone(), session.clone());
                    cursor = Sequence::default();
                    session
                }
                Err(error) => {
                    return failure(match error.downcast_ref::<AttachError>() {
                        Some(AttachError::Missing) => AttachOutcome::Missing,
                        Some(AttachError::Replaced) => AttachOutcome::Replaced,
                        Some(AttachError::Unidentified) => AttachOutcome::Incompatible,
                        _ => AttachOutcome::Failed,
                    })
                }
            }
        } else {
            existing.expect("non-rebuild attaches require a current adapter")
        };
        let journal = session.stream();
        let snapshot = journal.snapshot();
        let descriptor = Descriptor {
            metadata: snapshot.metadata,
            clock_epoch: snapshot.clock_epoch,
        };
        let reply = json!({"event":"AttachResult","data":{"request_id":request_id,"session_id":id,
            "outcome":kind,"attachment_id":attachment.attachment_id,"descriptor":descriptor}});
        let pump = (kind != AttachOutcome::Unreconstructable).then_some(Pump {
            journal,
            owner,
            attachment,
            descriptor,
            kind,
            cursor,
            cut: snapshot.high_water,
        });
        drop(reservation);
        (reply, pump)
    }
}
