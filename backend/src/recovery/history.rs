//! Archive transport is separate from sequenced live terminal records.
use super::*;
use doom_term_pty::tmux::CapturedArchive;

pub(super) async fn transfer(
    tx: &Outbound,
    id: &str,
    attachment: &Attachment,
    archive: Result<CapturedArchive, String>,
) -> bool {
    let envelope = |event: &str, data: Value| {
        let mut data = data;
        data["session_id"] = json!(id);
        data["incarnation"] = json!(attachment.incarnation);
        data["attachment_id"] = json!(attachment.attachment_id);
        json!({"event":event,"data":data})
    };
    let archive = match archive {
        Ok(archive) => archive,
        Err(reason) => {
            return tx
                .send(&envelope("HistoryUnavailable", json!({"reason":reason})))
                .await
                .is_ok()
        }
    };
    // UTF-8 boundaries are preserved. Even worst-case JSON escaping remains
    // below 64 KiB per chunk, without copying the complete 8 MiB archive.
    let mut chunks = Vec::new();
    let mut remaining = archive.data.as_str();
    while !remaining.is_empty() {
        let mut end = remaining.len().min(8192);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&remaining[..end]);
        remaining = &remaining[end..];
    }
    let count = chunks.len();
    let bytes = archive.data.len();
    let begin = envelope(
        "HistoryBegin",
        json!({"capture_id":archive.capture_id,
        "cols":archive.cols,"rows":archive.rows,"lines":archive.lines,"bytes":bytes,"chunks":count,
        "history_at_limit":archive.history_at_limit,"potentially_overlapping":archive.potentially_overlapping,
        "potentially_incomplete":archive.potentially_incomplete}),
    );
    if tx.send(&begin).await.is_err() {
        return false;
    }
    for (ordinal, data) in chunks.into_iter().enumerate() {
        if tx
            .send(&envelope(
                "HistoryChunk",
                json!({"capture_id":archive.capture_id,"ordinal":ordinal,"data":data}),
            ))
            .await
            .is_err()
        {
            return false;
        }
    }
    tx.send(&envelope(
        "HistoryComplete",
        json!({"capture_id":archive.capture_id,"chunks":count,"bytes":bytes}),
    ))
    .await
    .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn multibyte_and_escaped_archive_chunks_have_exact_ordinals_and_completion() {
        let expected = format!("{}{}", "三\n\x1b[31m".repeat(9000), "🦀".repeat(10000));
        let archive = CapturedArchive {
            capture_id: Identity::random().unwrap(),
            incarnation: Identity::random().unwrap(),
            cols: 91,
            rows: 27,
            lines: 5000,
            history_at_limit: true,
            potentially_overlapping: true,
            potentially_incomplete: true,
            data: expected.clone(),
        };
        let attachment = Attachment {
            socket_id: Identity::random().unwrap(),
            incarnation: archive.incarnation.clone(),
            attachment_id: Identity::random().unwrap(),
        };
        let capture = archive.capture_id.clone();
        let hub = OutboundHub::default();
        let (tx, mut rx) = hub.channel();
        let task =
            tokio::spawn(async move { transfer(&tx, "archive", &attachment, Ok(archive)).await });
        let begin: Value = serde_json::from_str(&rx.recv().await.unwrap().text).unwrap();
        assert_eq!(begin["event"], "HistoryBegin");
        assert_eq!(begin["data"]["capture_id"], capture.as_str());
        assert_eq!(begin["data"]["bytes"], expected.len());
        let mut received = String::new();
        let mut ordinal = 0;
        loop {
            let frame = rx.recv().await.unwrap();
            assert!(
                frame.text.len() <= 65536,
                "complete serialized chunk exceeds its bound"
            );
            let message: Value = serde_json::from_str(&frame.text).unwrap();
            assert_eq!(message["data"]["capture_id"], capture.as_str());
            match message["event"].as_str().unwrap() {
                "HistoryChunk" => {
                    assert_eq!(message["data"]["ordinal"], ordinal);
                    received.push_str(message["data"]["data"].as_str().unwrap());
                    ordinal += 1;
                }
                "HistoryComplete" => {
                    assert_eq!(message["data"]["chunks"], ordinal);
                    assert_eq!(message["data"]["bytes"], received.len());
                    break;
                }
                event => panic!("history became an unexpected {event} event"),
            }
        }
        assert_eq!(received, expected);
        assert_eq!(begin["data"]["chunks"], ordinal);
        assert!(task.await.unwrap());
        drop(rx);
        assert_eq!(hub.retained_bytes(), 0);
    }
}
