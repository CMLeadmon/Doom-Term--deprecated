//! Explicit adoption of an observed unlabelled root, never automatic recovery.
use super::*;

impl RecoveryServer {
    pub(super) fn recover_legacy(
        self: Arc<Self>,
        request_id: String,
        id: String,
        pane: String,
        root_pid: u32,
    ) -> Value {
        let failure = |code: &str| {
            json!({"event":"RecoverLegacyResult","data":{
            "request_id":request_id,"session_id":id,"incarnation":null,"error":{"code":code}}})
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
        // This worker retains the reservation even if its caller disconnects.
        // A lost reply can leave an identified pane; read-only discovery finds
        // it. Retrying adoption never overwrites an existing identity.
        let incarnation = match PtySession::identify_legacy(&id, &pane, root_pid) {
            Ok(identity) => identity,
            Err(_) => return failure("failed-unknown"),
        };
        drop(reservation);
        json!({"event":"RecoverLegacyResult","data":{
            "request_id":request_id,"session_id":id,"incarnation":incarnation,"error":null}})
    }
}
