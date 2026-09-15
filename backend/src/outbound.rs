//! Serialized byte ownership extends through socket-send completion.
use parking_lot::Mutex;
use serde::Serialize;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

#[derive(Clone, Default)]
pub struct OutboundHub(Arc<Mutex<usize>>);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    Closed,
    Overflow,
    Serialization,
    Timeout,
    InboundOverflow,
}

#[derive(Clone)]
pub struct Outbound {
    budget: Arc<ConnectionBudget>,
    tx: mpsc::Sender<Frame>,
}
pub struct Inbox {
    rx: mpsc::Receiver<Frame>,
    budget: Arc<ConnectionBudget>,
}
pub struct Frame {
    pub text: String,
    _charge: Charge,
}
pub struct PreparedFrame<'a> {
    permit: mpsc::Permit<'a, Frame>,
    frame: Frame,
}
impl PreparedFrame<'_> {
    /// Synchronous queue commit: callers may atomically publish an offered
    /// cursor under an ownership lock without doing socket I/O under that lock.
    pub fn enqueue(self) {
        self.permit.send(self.frame);
    }
}

struct ConnectionBudget {
    hub: OutboundHub,
    bytes: AtomicUsize,
    closed: watch::Sender<Option<SendError>>,
}
impl ConnectionBudget {
    fn close(&self, error: SendError) {
        self.closed.send_if_modified(|reason| {
            if reason.is_some() {
                return false;
            }
            *reason = Some(error);
            true
        });
    }
}
struct Charge {
    budget: Arc<ConnectionBudget>,
    bytes: usize,
}
impl Drop for Charge {
    fn drop(&mut self) {
        let mut global = self.budget.hub.0.lock();
        *global -= self.bytes;
        self.budget.bytes.fetch_sub(self.bytes, Ordering::Relaxed);
    }
}
struct Encoding {
    data: Vec<u8>,
    charge: Charge,
    error: Option<SendError>,
}
impl Write for Encoding {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut global = self.charge.budget.hub.0.lock();
        let local = self.charge.budget.bytes.load(Ordering::Relaxed);
        if bytes.len() > (4 * 1024 * 1024_usize).saturating_sub(local)
            || bytes.len() > (32 * 1024 * 1024_usize).saturating_sub(*global)
        {
            self.error = Some(SendError::Overflow);
            return Err(std::io::Error::other("Outbound byte budget exceeded"));
        }
        // Reserve before allocating, including in-progress serialization on
        // other connections. No uncharged copy of a huge message is made.
        *global += bytes.len();
        self.charge
            .budget
            .bytes
            .fetch_add(bytes.len(), Ordering::Relaxed);
        self.charge.bytes += bytes.len();
        drop(global);
        self.data.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl OutboundHub {
    pub fn channel(&self) -> (Outbound, Inbox) {
        let (tx, rx) = mpsc::channel(128);
        let (closed, _) = watch::channel(None);
        let budget = Arc::new(ConnectionBudget {
            hub: self.clone(),
            bytes: AtomicUsize::new(0),
            closed,
        });
        (
            Outbound {
                budget: budget.clone(),
                tx,
            },
            Inbox { rx, budget },
        )
    }
    pub fn retained_bytes(&self) -> usize {
        *self.0.lock()
    }
}
impl Outbound {
    pub async fn send(&self, value: &impl Serialize) -> Result<(), SendError> {
        self.prepare(value).await?.enqueue();
        Ok(())
    }
    pub async fn prepare(&self, value: &impl Serialize) -> Result<PreparedFrame<'_>, SendError> {
        if self.budget.closed.borrow().is_some() {
            return Err(SendError::Closed);
        }
        // Cursor pumps await one slot, never copy a whole journal into a queue.
        let permit = tokio::select! {
            _ = self.closed() => return Err(SendError::Closed),
            permit = self.tx.reserve() => permit.map_err(|_| SendError::Closed)?,
        };
        let mut encoding = Encoding {
            data: Vec::new(),
            charge: Charge {
                budget: self.budget.clone(),
                bytes: 0,
            },
            error: None,
        };
        if serde_json::to_writer(&mut encoding, value).is_err() {
            let error = encoding.error.unwrap_or(SendError::Serialization);
            self.budget.close(error);
            return Err(error); // partial encoding's charge drops here
        }
        if self.budget.closed.borrow().is_some() {
            return Err(SendError::Closed);
        }
        let Encoding { data, charge, .. } = encoding;
        let text = String::from_utf8(data).expect("JSON serializer emits UTF-8");
        Ok(PreparedFrame {
            permit,
            frame: Frame {
                text,
                _charge: charge,
            },
        })
    }
    pub fn pending_bytes(&self) -> usize {
        self.budget.bytes.load(Ordering::Relaxed)
    }
    pub fn close(&self, error: SendError) {
        self.budget.close(error);
    }
    pub async fn closed(&self) -> SendError {
        let mut closed = self.budget.closed.subscribe();
        loop {
            if let Some(reason) = *closed.borrow_and_update() {
                return reason;
            }
            if closed.changed().await.is_err() {
                return SendError::Closed;
            }
        }
    }
}
impl Inbox {
    pub async fn recv(&mut self) -> Option<Frame> {
        self.rx.recv().await
    }
}
impl Drop for Inbox {
    fn drop(&mut self) {
        self.budget.close(SendError::Closed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn popped_frames_remain_charged_until_the_socket_finishes_or_cancels_them() {
        let hub = OutboundHub::default();
        let (tx, mut rx) = hub.channel();
        tx.send(&"三\n").await.unwrap();
        // JSON quotes (2), UTF-8 glyph (3), escaped newline (2).
        assert_eq!(hub.retained_bytes(), 7);
        let frame = rx.recv().await.unwrap();
        assert_eq!(frame.text, "\"三\\n\"");
        assert_eq!(tx.pending_bytes(), 7);
        assert_eq!(hub.retained_bytes(), 7);
        drop(frame);
        assert_eq!(hub.retained_bytes(), 0);
        tx.send(&"pending").await.unwrap();
        drop(rx);
        assert_eq!(hub.retained_bytes(), 0);
        assert_eq!(tx.send(&"must not leak").await, Err(SendError::Closed));
        assert_eq!(hub.retained_bytes(), 0);
    }

    #[tokio::test]
    async fn connection_overflow_refuses_further_output_and_does_not_leak_failed_serialization() {
        let hub = OutboundHub::default();
        let (tx, rx) = hub.channel();
        let packet = "x".repeat(65534); // Exactly 64 KiB serialized.
        for _ in 0..64 {
            tx.send(&packet).await.unwrap();
        }
        assert_eq!(tx.pending_bytes(), 4 * 1024 * 1024);
        assert_eq!(tx.send(&"overflow").await, Err(SendError::Overflow));
        assert_eq!(tx.pending_bytes(), 4 * 1024 * 1024);
        assert_eq!(tx.send(&"later").await, Err(SendError::Closed));
        drop(rx);
        assert_eq!(hub.retained_bytes(), 0);
    }

    #[tokio::test]
    async fn global_cap_includes_other_connections_and_releases_on_connection_drop() {
        let hub = OutboundHub::default();
        let mut connections = Vec::new();
        let packet = "x".repeat(65534);
        for _ in 0..8 {
            let (tx, rx) = hub.channel();
            for _ in 0..64 {
                tx.send(&packet).await.unwrap();
            }
            connections.push((tx, rx));
        }
        assert_eq!(hub.retained_bytes(), 32 * 1024 * 1024);
        let (overflow, rejected_rx) = hub.channel();
        assert_eq!(overflow.send(&"too much").await, Err(SendError::Overflow));
        drop(rejected_rx);
        drop(connections.pop());
        assert_eq!(hub.retained_bytes(), 28 * 1024 * 1024);
        let (next, next_rx) = hub.channel();
        next.send(&"accepted").await.unwrap();
        drop(next_rx);
        drop(connections);
        assert_eq!(hub.retained_bytes(), 0);
    }
}
