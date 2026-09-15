use super::*;

fn metadata(id: &str) -> StreamMetadata {
    StreamMetadata::new(id.into(), Identity::random().unwrap(), 80, 24, false).unwrap()
}

fn output(text: &str) -> StreamPayload {
    StreamPayload::Event(DemuxEvent::Output { data: text.into() })
}

#[test]
fn wire_sequences_do_not_lose_precision_or_accept_noncanonical_values() {
    for value in [0, 1, 9_007_199_254_740_993, u64::MAX] {
        let json = format!("\"{value}\"");
        let sequence: Sequence = serde_json::from_str(&json).unwrap();
        assert_eq!(sequence.get(), value);
        assert_eq!(serde_json::to_string(&sequence).unwrap(), json);
    }
    for value in [
        "1",
        "null",
        "\"\"",
        "\"01\"",
        "\"+1\"",
        "\"-1\"",
        "\"1.0\"",
        "\"1e2\"",
        "\" 1\"",
        "\"18446744073709551616\"",
    ] {
        assert!(serde_json::from_str::<Sequence>(value).is_err(), "{value}");
    }
}

#[test]
fn identity_validation_does_not_accept_empty_truncated_or_non_hex_tokens() {
    for value in [
        "",
        "x",
        "0123456789abcdef0123456789abcde",
        "0123456789abcdef0123456789abcdef0",
        "0123456789abcdef0123456789abcdeg",
        "0123456789abcdef0123456789abcdeF",
    ] {
        assert!(Identity::try_from(value.to_string()).is_err());
    }
    let first = Identity::random().unwrap();
    let second = Identity::random().unwrap();
    assert_ne!(first, second);
    assert_eq!(
        Identity::try_from(first.as_str().to_string()).unwrap(),
        first
    );
}

#[test]
fn record_limit_includes_the_identity_envelope_not_only_the_payload() {
    let stream = JournalHub::default()
        .open(metadata("bounded-envelope"))
        .unwrap();
    stream.append(output(&"x".repeat(65536 - 1024))).unwrap();
    // The output payload alone fits, but its complete record does not.
    let payload = output(&"x".repeat(65536 - 100));
    assert!(serde_json::to_vec(&payload).unwrap().len() < 65536);
    assert_eq!(stream.append(payload), Err(StreamError::RecordTooLarge));
    let fault = stream.read_after(Sequence::new(1)).unwrap().unwrap();
    assert!(matches!(
        fault.payload,
        StreamPayload::Fault {
            reason: StreamFault::RecordTooLarge
        }
    ));
    assert!(serde_json::to_vec(&fault).unwrap().len() <= 65536);
    assert!(stream.snapshot().ended);
}

#[test]
fn terminal_outcome_survives_total_payload_eviction_without_turning_faults_into_exits() {
    let hub = JournalHub::with_limits(Limits {
        session_bytes: 1,
        session_records: 1,
        global_bytes: 1,
    });
    for (index, payload, expected) in [
        (
            "known",
            StreamPayload::Closed { exit_code: Some(7) },
            StreamEnd::Closed { exit_code: Some(7) },
        ),
        (
            "unknown",
            StreamPayload::Closed { exit_code: None },
            StreamEnd::Closed { exit_code: None },
        ),
        (
            "fault",
            StreamPayload::Fault {
                reason: StreamFault::ControlTooLong,
            },
            StreamEnd::Fault {
                reason: StreamFault::ControlTooLong,
            },
        ),
    ] {
        let stream = hub.open(metadata(index)).unwrap();
        assert_eq!(stream.snapshot().termination, None);
        stream.append(payload).unwrap();
        assert_eq!(
            stream.read_after(Sequence::new(0)).unwrap_err(),
            StreamError::Gap
        );
        assert_eq!(stream.snapshot().retained_bytes, 0);
        assert_eq!(stream.snapshot().termination, Some(expected));
        assert_eq!(
            stream.append(StreamPayload::Closed { exit_code: Some(0) }),
            Err(StreamError::Ended)
        );
        assert_eq!(stream.snapshot().termination, Some(expected));
    }
}

#[test]
fn epochs_do_not_alias_and_reopening_an_epoch_cannot_replace_its_records() {
    let hub = JournalHub::default();
    let meta = metadata("logical-id");
    let stream = hub.open(meta.clone()).unwrap();
    stream.append(output("original")).unwrap();
    assert!(matches!(hub.open(meta), Err(StreamError::DuplicateEpoch)));
    let replacement = hub.open(metadata("logical-id")).unwrap();
    assert_eq!(replacement.snapshot().high_water, Sequence::new(0));
    assert!(
        matches!(stream.read_after(Sequence::new(0)).unwrap().unwrap().payload,
        StreamPayload::Event(DemuxEvent::Output { data }) if data == "original")
    );
}

#[test]
fn byte_limits_evict_whole_records_oldest_first_across_streams() {
    let hub = JournalHub::with_limits(Limits {
        session_bytes: 2500,
        session_records: 8192,
        global_bytes: 3000,
    });
    let a = hub.open(metadata("a")).unwrap();
    let b = hub.open(metadata("b")).unwrap();
    a.append(output(&"a".repeat(1000))).unwrap();
    b.append(output(&"b".repeat(1000))).unwrap();
    a.append(output(&"c".repeat(1000))).unwrap();
    // Three records cost more than 3,000; the first append is evicted, not
    // whichever stream was most recently active.
    assert_eq!(
        a.read_after(Sequence::new(0)).unwrap_err(),
        StreamError::Gap
    );
    assert!(
        matches!(a.read_after(Sequence::new(1)).unwrap().unwrap().payload,
        StreamPayload::Event(DemuxEvent::Output { data }) if data == "c".repeat(1000))
    );
    assert!(b.read_after(Sequence::new(0)).unwrap().is_some());
    assert!(hub.retained_bytes() <= 3000);
    assert!(a.snapshot().retained_bytes <= 2500);
    assert_eq!(hub.0.state.lock().oldest.len(), 2);
}

#[test]
fn eviction_of_every_record_still_reports_a_gap_and_keeps_high_water() {
    let hub = JournalHub::with_limits(Limits {
        session_bytes: 1,
        session_records: 1,
        global_bytes: 1,
    });
    let stream = hub.open(metadata("empty-retention")).unwrap();
    stream.append(output("not retained")).unwrap();
    assert_eq!(stream.snapshot().high_water, Sequence::new(1));
    assert_eq!(stream.snapshot().retained_records, 0);
    assert_eq!(
        stream.read_after(Sequence::new(0)).unwrap_err(),
        StreamError::Gap
    );
    assert!(stream.read_after(Sequence::new(1)).unwrap().is_none());
    assert_eq!(hub.retained_bytes(), 0);
}

#[test]
fn production_byte_limit_is_independent_of_record_count() {
    let hub = JournalHub::default();
    let stream = hub.open(metadata("bytes")).unwrap();
    for _ in 0..200 {
        stream.append(output(&"x".repeat(60_000))).unwrap();
    }
    assert!(stream.snapshot().retained_records < 200);
    assert!(stream.snapshot().retained_bytes <= 8 * 1024 * 1024);
    assert_eq!(
        stream.read_after(Sequence::new(0)).unwrap_err(),
        StreamError::Gap
    );
}

#[test]
fn production_global_limit_evicts_the_oldest_session_even_if_it_is_quiet() {
    let hub = JournalHub::default();
    let mut streams = Vec::new();
    for i in 0..10 {
        let stream = hub.open(metadata(&format!("global-{i}"))).unwrap();
        for _ in 0..120 {
            stream.append(output(&"x".repeat(60_000))).unwrap();
        }
        streams.push(stream);
    }
    assert!(hub.retained_bytes() <= 64 * 1024 * 1024);
    assert_eq!(
        streams[0].read_after(Sequence::new(0)).unwrap_err(),
        StreamError::Gap
    );
    assert_eq!(streams[9].snapshot().retained_records, 120);
    assert_eq!(streams[0].snapshot().high_water, Sequence::new(120));
}

#[test]
fn oversize_record_ends_the_stream_with_a_fault_not_a_truncated_payload() {
    let stream = JournalHub::default().open(metadata("fault")).unwrap();
    assert_eq!(
        stream.append(output(&"x".repeat(65536))).unwrap_err(),
        StreamError::RecordTooLarge
    );
    assert!(matches!(
        stream
            .read_after(Sequence::new(0))
            .unwrap()
            .unwrap()
            .payload,
        StreamPayload::Fault {
            reason: StreamFault::RecordTooLarge
        }
    ));
    assert_eq!(
        stream.append(output("after fault")).unwrap_err(),
        StreamError::Ended
    );
}

#[test]
fn sequence_exhaustion_is_terminal_never_wraps_or_reuses_zero() {
    let hub = JournalHub::default();
    let meta = metadata("exhausted");
    let stream = hub.open(meta.clone()).unwrap();
    hub.0
        .state
        .lock()
        .streams
        .get_mut(&meta.stream_epoch)
        .unwrap()
        .high_water = Sequence::new(u64::MAX - 1);
    assert_eq!(
        stream.append(output("never rendered")).unwrap_err(),
        StreamError::SequenceExhausted
    );
    assert_eq!(stream.snapshot().high_water, Sequence::new(u64::MAX));
    assert!(matches!(
        stream
            .read_after(Sequence::new(u64::MAX - 1))
            .unwrap()
            .unwrap()
            .payload,
        StreamPayload::Fault {
            reason: StreamFault::SequenceExhausted
        }
    ));
    assert_eq!(
        stream.append(output("late")).unwrap_err(),
        StreamError::Ended
    );
}

#[test]
fn waiting_reader_wakes_on_output_and_never_misses_an_existing_append() {
    let stream = JournalHub::default().open(metadata("wake")).unwrap();
    let writer = stream.clone();
    let worker = std::thread::spawn(move || {
        writer.append(output("ready")).unwrap();
    });
    let start = Instant::now();
    stream.wait_for_change(Sequence::new(0), Duration::from_secs(5));
    worker.join().unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(stream.read_after(Sequence::new(0)).unwrap().is_some());
    let start = Instant::now();
    stream.wait_for_change(Sequence::new(0), Duration::from_secs(5));
    assert!(start.elapsed() < Duration::from_secs(1));
}
