//! Bounded hook state with one atomic snapshot/live handoff. A retained ask
//! keeps its source identity and is never reissued as a new live transition.
use crate::{
    outbound::{Outbound, SendError},
    ServerMessage,
};
use doom_term_pty::stream::Identity;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Arc};
use tokio::sync::broadcast;

const MAX_EVENTS: usize = 256;
const MAX_BYTES: usize = 1024 * 1024;

pub struct HookRecord {
    pub key: String,
    value: Value,
    bytes: usize,
}
impl HookRecord {
    pub fn wire(&self, phase: &str) -> Value {
        let mut value = self.value.clone();
        value["data"]["phase"] = json!(phase);
        value
    }
}
#[derive(Default)]
struct State {
    retained: VecDeque<Arc<HookRecord>>,
    bytes: usize,
}
pub struct HookHub {
    state: Mutex<State>,
    bus: broadcast::Sender<Arc<HookRecord>>,
}
pub type Subscription = (Vec<Arc<HookRecord>>, broadcast::Receiver<Arc<HookRecord>>);
impl Default for HookHub {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::default()),
            bus: broadcast::channel(64).0,
        }
    }
}
impl HookHub {
    pub fn publish(&self, message: ServerMessage, incarnation: Option<Identity>) {
        let ServerMessage::AgentEvent {
            agent,
            event,
            cwd,
            doom_session_id,
            agent_session_id,
        } = &message
        else {
            return;
        };
        if agent.len() > 64
            || event.len() > 256
            || cwd.as_ref().is_some_and(|v| v.len() > 4096)
            || doom_session_id
                .as_ref()
                .is_some_and(|v| !crate::protocol::valid_id(v))
            || agent_session_id.as_ref().is_some_and(|v| v.len() > 256)
        {
            return;
        }
        let key = if let Some(id) = doom_session_id {
            // Unknown legacy provenance must not replace known process state.
            format!(
                "session:{id}:{}",
                incarnation
                    .as_ref()
                    .map(Identity::as_str)
                    .unwrap_or("unidentified")
            )
        } else if let Some(cwd) = cwd {
            format!("{agent}:{cwd}")
        } else {
            return;
        };
        let retained = matches!(event.as_str(), "PermissionRequest" | "Stop");
        let Ok(event_id) = Identity::random() else {
            return;
        };
        let Ok(mut value) = serde_json::to_value(message) else {
            return;
        };
        value["data"]["event_id"] = json!(event_id);
        value["data"]["incarnation"] = json!(incarnation);
        let bytes = serde_json::to_vec(&value).unwrap().len() + 32;
        if bytes > 65536 {
            return;
        }
        let record = Arc::new(HookRecord { key, value, bytes });
        let mut state = self.state.lock();
        if retained {
            if let Some(index) = state.retained.iter().position(|old| old.key == record.key) {
                state.bytes -= state.retained.remove(index).unwrap().bytes;
            }
            state.bytes += bytes;
            state.retained.push_back(record.clone());
            while state.retained.len() > MAX_EVENTS || state.bytes > MAX_BYTES {
                state.bytes -= state.retained.pop_front().unwrap().bytes;
            }
        }
        // Publication shares the state lock: two HTTP posters cannot invert
        // their transition order between updating memory and broadcasting.
        let _ = self.bus.send(record);
    }
    pub fn subscribe(&self) -> Subscription {
        let state = self.state.lock();
        let receiver = self.bus.subscribe();
        (state.retained.iter().cloned().collect(), receiver)
    }
}

pub async fn forward((retained, mut live): Subscription, tx: Outbound) {
    for record in retained {
        if tx.send(&record.wire("catch-up")).await.is_err() {
            return;
        }
    }
    loop {
        let record = tokio::select! {
            _ = tx.closed() => return,
            record = live.recv() => record,
        };
        match record {
            Ok(record) => {
                if tx.send(&record.wire("live")).await.is_err() {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                tx.close(SendError::Overflow);
                return;
            }
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}
