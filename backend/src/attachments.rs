//! Connection-scoped ownership. No transport or subprocess work in this module.
use doom_term_pty::stream::{Identity, Sequence};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub socket_id: Identity,
    pub incarnation: Identity,
    pub attachment_id: Identity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Denied {
    Busy,
    Stale,
    NotReady,
    InvalidCut,
    Unavailable,
}

#[derive(Default)]
pub struct Ownership {
    current: Option<Lease>,
}

struct Lease {
    attachment: Attachment,
    cut: Option<Sequence>,
    ready: bool,
    invalidated: bool,
}

impl Ownership {
    pub fn acquire(
        &mut self,
        socket: Identity,
        incarnation: Identity,
    ) -> Result<Attachment, Denied> {
        if self.current.is_some() {
            return Err(Denied::Busy);
        }
        let attachment = Attachment {
            socket_id: socket,
            incarnation,
            attachment_id: Identity::random().map_err(|_| Denied::Unavailable)?,
        };
        self.current = Some(Lease {
            attachment: attachment.clone(),
            cut: None,
            ready: false,
            invalidated: false,
        });
        Ok(attachment)
    }
    pub fn offer_cut(&mut self, attachment: &Attachment, cut: Sequence) -> Result<(), Denied> {
        self.authorize(attachment, false)?;
        let lease = self.current.as_mut().unwrap();
        if lease.invalidated || lease.cut.is_some_and(|offered| offered != cut) {
            return Err(Denied::InvalidCut);
        }
        lease.cut = Some(cut);
        Ok(())
    }
    pub fn acknowledge(&mut self, attachment: &Attachment, cut: Sequence) -> Result<(), Denied> {
        self.authorize(attachment, false)?;
        let lease = self.current.as_mut().unwrap();
        if lease.invalidated || lease.cut != Some(cut) {
            return Err(Denied::InvalidCut);
        }
        lease.ready = true;
        Ok(())
    }
    pub fn authorize(&self, attachment: &Attachment, ready: bool) -> Result<(), Denied> {
        let lease = self
            .current
            .as_ref()
            .filter(|lease| &lease.attachment == attachment)
            .ok_or(Denied::Stale)?;
        if ready && !lease.ready {
            return Err(Denied::NotReady);
        }
        Ok(())
    }
    pub fn release_socket(&mut self, socket: &Identity) {
        if self
            .current
            .as_ref()
            .is_some_and(|lease| &lease.attachment.socket_id == socket)
        {
            self.current = None;
        }
    }
    pub fn invalidate_stream(&mut self, attachment: &Attachment) {
        if let Some(lease) = self
            .current
            .as_mut()
            .filter(|lease| &lease.attachment == attachment)
        {
            lease.ready = false;
            lease.cut = None;
            lease.invalidated = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(digit: char) -> Identity {
        Identity::try_from(digit.to_string().repeat(32)).unwrap()
    }

    #[test]
    fn second_controller_cannot_steal_or_release_current_ownership() {
        let mut owner = Ownership::default();
        let first = owner.acquire(id('1'), id('a')).unwrap();
        assert_eq!(owner.acquire(id('2'), id('a')), Err(Denied::Busy));
        owner.release_socket(&id('2'));
        assert_eq!(owner.authorize(&first, false), Ok(()));
        owner.release_socket(&id('1'));
        let next = owner.acquire(id('2'), id('a')).unwrap();
        assert_ne!(next.attachment_id, first.attachment_id);
        owner.release_socket(&id('1'));
        assert_eq!(owner.authorize(&first, false), Err(Denied::Stale));
        assert_eq!(owner.authorize(&next, false), Ok(()));
    }

    #[test]
    fn input_requires_exact_offered_cut_not_receipt_or_future_sequence() {
        let mut owner = Ownership::default();
        let attachment = owner.acquire(id('1'), id('a')).unwrap();
        assert_eq!(owner.authorize(&attachment, false), Ok(())); // lifecycle allowed
        assert_eq!(owner.authorize(&attachment, true), Err(Denied::NotReady));
        assert_eq!(
            owner.acknowledge(&attachment, Sequence::new(0)),
            Err(Denied::InvalidCut)
        );
        owner.offer_cut(&attachment, Sequence::new(600)).unwrap();
        for cut in [0, 599, 601, u64::MAX] {
            assert_eq!(
                owner.acknowledge(&attachment, Sequence::new(cut)),
                Err(Denied::InvalidCut)
            );
            assert_eq!(owner.authorize(&attachment, true), Err(Denied::NotReady));
        }
        owner.acknowledge(&attachment, Sequence::new(600)).unwrap();
        owner.acknowledge(&attachment, Sequence::new(600)).unwrap();
        assert_eq!(owner.authorize(&attachment, true), Ok(()));
        owner.invalidate_stream(&attachment);
        assert_eq!(owner.authorize(&attachment, true), Err(Denied::NotReady));
        assert_eq!(owner.authorize(&attachment, false), Ok(()));
        assert_eq!(
            owner.acknowledge(&attachment, Sequence::new(600)),
            Err(Denied::InvalidCut)
        );
    }

    #[test]
    fn each_identity_is_checked_again_at_execution_and_old_stream_callbacks_are_inert() {
        let mut owner = Ownership::default();
        let old = owner.acquire(id('1'), id('a')).unwrap();
        owner.release_socket(&id('1'));
        let current = owner.acquire(id('2'), id('b')).unwrap();
        owner.offer_cut(&current, Sequence::new(0)).unwrap();
        owner.acknowledge(&current, Sequence::new(0)).unwrap();
        for stale in [
            Attachment {
                socket_id: old.socket_id.clone(),
                ..current.clone()
            },
            Attachment {
                incarnation: old.incarnation.clone(),
                ..current.clone()
            },
            Attachment {
                attachment_id: old.attachment_id.clone(),
                ..current.clone()
            },
        ] {
            assert_eq!(owner.authorize(&stale, false), Err(Denied::Stale));
            assert_eq!(
                owner.acknowledge(&stale, Sequence::new(0)),
                Err(Denied::Stale)
            );
            owner.invalidate_stream(&stale);
        }
        assert_eq!(owner.authorize(&current, true), Ok(()));
        assert_eq!(owner.authorize(&old, false), Err(Denied::Stale));
    }
}
