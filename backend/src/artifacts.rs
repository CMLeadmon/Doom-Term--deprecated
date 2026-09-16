//! Bounded artifact store with live WebSocket broadcast and standalone HTTP rendering.
//! An artifact is a rich document (Markdown, HTML, Diff, or Dashboard) published
//! by a CLI agent, developer tool, or user script to provide an interactive,
//! visual alternative to raw terminal scrollback.

use crate::outbound::{Outbound, SendError};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;

const MAX_ARTIFACTS: usize = 64;
const MAX_BYTES: usize = 16 * 1024 * 1024; // 16 MiB total cache

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactRecord {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub artifact_type: String, // "html" | "markdown" | "diff" | "dashboard" | "image"
    pub content: String,
    pub version: u32,
    pub session_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactSummary {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub version: u32,
    pub session_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub content_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactPost {
    pub id: Option<String>,
    pub title: String,
    #[serde(rename = "type", default = "default_artifact_type")]
    pub artifact_type: String,
    pub content: String,
    pub session_id: Option<String>,
    pub open_pane: Option<bool>,
}

fn default_artifact_type() -> String {
    "markdown".to_string()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sanitize_id(raw: &str) -> String {
    let clean: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = clean.trim_matches('-');
    if trimmed.is_empty() {
        format!("art-{}", now_millis() % 1000000)
    } else {
        trimmed.to_string()
    }
}

pub struct ArtifactHub {
    state: Mutex<ArtifactState>,
    bus: broadcast::Sender<(Arc<ArtifactRecord>, bool)>, // (record, open_pane)
}

#[derive(Default)]
struct ArtifactState {
    order: VecDeque<String>,
    records: HashMap<String, Arc<ArtifactRecord>>,
    bytes: usize,
}

impl Default for ArtifactHub {
    fn default() -> Self {
        Self {
            state: Mutex::new(ArtifactState::default()),
            bus: broadcast::channel(64).0,
        }
    }
}

impl ArtifactHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn publish_or_update(
        &self,
        post: ArtifactPost,
        default_session: Option<String>,
    ) -> Result<(Arc<ArtifactRecord>, bool), String> {
        if post.title.trim().is_empty() {
            return Err("Artifact title must not be empty".to_string());
        }
        let content_len = post.content.len();
        if content_len > 4 * 1024 * 1024 {
            return Err("Artifact content exceeds 4 MiB limit".to_string());
        }

        let id = post
            .id
            .as_deref()
            .map(sanitize_id)
            .unwrap_or_else(|| format!("art-{}", now_millis() % 10000000));

        let open_pane = post.open_pane.unwrap_or(true);
        let now = now_millis();
        let session_id = post.session_id.or(default_session);

        let mut state = self.state.lock();

        let existing = state.records.get(&id).cloned();
        let record = if let Some(existing) = existing {
            state.bytes = state.bytes.saturating_sub(existing.content.len());
            Arc::new(ArtifactRecord {
                id: id.clone(),
                title: post.title,
                artifact_type: post.artifact_type,
                content: post.content,
                version: existing.version + 1,
                session_id: session_id.or_else(|| existing.session_id.clone()),
                created_at: existing.created_at,
                updated_at: now,
            })
        } else {
            Arc::new(ArtifactRecord {
                id: id.clone(),
                title: post.title,
                artifact_type: post.artifact_type,
                content: post.content,
                version: 1,
                session_id,
                created_at: now,
                updated_at: now,
            })
        };

        state.bytes += record.content.len();
        if let Some(pos) = state.order.iter().position(|x| x == &id) {
            state.order.remove(pos);
        }
        state.order.push_back(id.clone());
        state.records.insert(id, record.clone());

        // Enforce cache bounds
        while state.order.len() > MAX_ARTIFACTS || state.bytes > MAX_BYTES {
            if let Some(evicted_id) = state.order.pop_front() {
                if let Some(evicted) = state.records.remove(&evicted_id) {
                    state.bytes = state.bytes.saturating_sub(evicted.content.len());
                }
            } else {
                break;
            }
        }

        let _ = self.bus.send((record.clone(), open_pane));
        Ok((record, open_pane))
    }

    pub fn get(&self, id: &str) -> Option<Arc<ArtifactRecord>> {
        self.state.lock().records.get(id).cloned()
    }

    pub fn list(&self) -> Vec<ArtifactSummary> {
        let state = self.state.lock();
        state
            .order
            .iter()
            .rev()
            .filter_map(|id| state.records.get(id))
            .map(|r| ArtifactSummary {
                id: r.id.clone(),
                title: r.title.clone(),
                artifact_type: r.artifact_type.clone(),
                version: r.version,
                session_id: r.session_id.clone(),
                created_at: r.created_at,
                updated_at: r.updated_at,
                content_length: r.content.len(),
            })
            .collect()
    }

    /// A receiver for publish events only. Unlike [`Self::subscribe`] this skips
    /// the retained snapshot: a standalone page is watching for the next change
    /// to one artifact, not replaying every artifact still in the cache.
    pub fn subscribe_events(&self) -> broadcast::Receiver<(Arc<ArtifactRecord>, bool)> {
        self.bus.subscribe()
    }

    pub fn subscribe(&self) -> (Vec<Arc<ArtifactRecord>>, broadcast::Receiver<(Arc<ArtifactRecord>, bool)>) {
        let state = self.state.lock();
        let receiver = self.bus.subscribe();
        let retained = state
            .order
            .iter()
            .filter_map(|id| state.records.get(id).cloned())
            .collect();
        (retained, receiver)
    }

    /// Renders a standalone HTML representation of any artifact.
    ///
    /// Injects a live reload script that subscribes to this artifact's own
    /// Server-Sent Events stream. It deliberately does not reach for the
    /// terminal WebSocket: `security::trusted_origin` refuses the daemon's own
    /// origin, so that socket 403s the handshake and the page never reloads.
    /// Admitting the origin there is not the fix either, because an `html`
    /// artifact is agent-authored JavaScript and that socket drives PTYs.
    pub fn render_standalone_page(&self, record: &ArtifactRecord) -> String {
        let live_script = format!(
            r#"<script>
(function() {{
  try {{
    var version = {version};
    var es = new EventSource({path});
    es.onmessage = function(e) {{
      try {{
        var m = JSON.parse(e.data);
        if (m && typeof m.version === 'number' && m.version !== version) {{
          location.reload();
        }}
      }} catch (err) {{}}
    }};
  }} catch (e) {{}}
}})();
</script>"#,
            version = record.version,
            path = serde_json::to_string(&format!("/artifact/{}/events", record.id))
                .unwrap_or_else(|_| "\"\"".to_string()),
        );

        match record.artifact_type.as_str() {
            "html" => {
                // If the content already contains <html> or <body>, inject the live reload script before </body>
                if record.content.contains("</body>") {
                    record.content.replacen("</body>", &format!("{}\n</body>", live_script), 1)
                } else if record.content.contains("</html>") {
                    record.content.replacen("</html>", &format!("{}\n</html>", live_script), 1)
                } else {
                    format!(
                        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Artifact: {title}</title>
</head>
<body>
{content}
{live_script}
</body>
</html>"#,
                        title = html_escape(&record.title),
                        content = record.content,
                        live_script = live_script
                    )
                }
            }
            "diff" => {
                let formatted_diff = render_diff_html(&record.content);
                format_chrome_page(&record.title, &record.id, record.version, "DIFF", &formatted_diff, &live_script)
            }
            "image" => {
                let formatted_img = render_image_html(&record.content, &record.title);
                format_chrome_page(&record.title, &record.id, record.version, "IMAGE", &formatted_img, &live_script)
            }
            _ => {
                // Markdown or text
                let formatted_md = render_markdown_html(&record.content);
                format_chrome_page(&record.title, &record.id, record.version, "MARKDOWN", &formatted_md, &live_script)
            }
        }
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn format_chrome_page(
    title: &str,
    id: &str,
    version: u32,
    kind: &str,
    body_html: &str,
    live_script: &str,
) -> String {
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>❖ {title} — Doom Term Artifact</title>
  <style>
    :root {{
      --ground: #14120f;
      --ground-2: #1b1814;
      --plate: repeating-linear-gradient(180deg, #767674 0 1px, #6d6d6b 1px 2px, #727270 2px 3px, #666664 3px 4px, #7a7a78 4px 5px, #6a6a68 5px 6px, #747472 6px 7px, #626260 7px 8px);
      --bevel-up: inset 1px 1px 0 #a2a29f, inset -1px -1px 0 #2f2f2e;
      --bevel-dn: inset 1px 1px 0 #171716, inset -1px -1px 0 #8e8e8b;
      --ink: #d8cbb0;
      --ink-dim: #8f8672;
      --ink-plate: #22201b;
      --st-live: #e0a92c;
      --st-pass: #5c9c3a;
      --st-fail: #ef4136;
      --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    }}
    * {{ box-sizing: border-box; border-radius: 0 !important; margin: 0; padding: 0; }}
    body {{ background: var(--ground); color: var(--ink); font-family: var(--mono); font-size: 13px; line-height: 1.5; padding: 16px; }}
    .bar {{ background: var(--plate); box-shadow: var(--bevel-up); padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; color: var(--ink-plate); font-weight: bold; font-size: 12px; }}
    .badge {{ background: var(--ground); color: var(--st-live); box-shadow: var(--bevel-dn); padding: 2px 6px; font-size: 10px; margin-left: 8px; }}
    .content-card {{ background: var(--ground-2); box-shadow: var(--bevel-dn); padding: 20px; overflow-x: auto; }}
    h1, h2, h3, h4 {{ color: var(--ink); margin-top: 16px; margin-bottom: 8px; border-bottom: 1px solid #2f2d29; padding-bottom: 4px; }}
    p {{ margin-bottom: 12px; }}
    code {{ background: #26221c; padding: 2px 5px; font-size: 12px; color: #e8dbbe; }}
    pre {{ background: #100f0d; box-shadow: var(--bevel-dn); padding: 12px; margin: 12px 0; overflow-x: auto; }}
    pre code {{ background: transparent; padding: 0; }}
    ul, ol {{ margin-left: 24px; margin-bottom: 12px; }}
    li {{ margin-bottom: 4px; }}
    table {{ border-collapse: collapse; width: 100%; margin: 16px 0; }}
    th, td {{ border: 1px solid #38342c; padding: 6px 10px; text-align: left; }}
    th {{ background: #221f1a; color: var(--ink); }}
    .diff-add {{ background: rgba(92, 156, 58, 0.15); color: #8cd665; }}
    .diff-del {{ background: rgba(239, 65, 54, 0.15); color: #ff7b72; }}
    .diff-hunk {{ background: #25221c; color: var(--ink-dim); font-weight: bold; }}
    .diff-file {{ background: #2d2922; color: var(--ink); font-weight: bold; padding: 4px 8px; margin-top: 12px; }}
    .btn {{ background: var(--ground); color: var(--ink); box-shadow: var(--bevel-up); text-decoration: none; padding: 4px 10px; font-size: 11px; display: inline-block; cursor: pointer; }}
    .btn:hover {{ background: #221e18; }}
  </style>
</head>
<body>
  <div class="bar">
    <div>
      <span>❖ ARTIFACT: {title}</span>
      <span class="badge">[{kind}]</span>
      <span class="badge">v{version}</span>
    </div>
    <div style="display: flex; gap: 8px;">
      <a class="btn" href="/artifact/{id}/raw" target="_blank">RAW</a>
      <a class="btn" href="/artifacts">ALL ARTIFACTS</a>
    </div>
  </div>
  <div class="content-card">
    {body_html}
  </div>
  {live_script}
</body>
</html>"#,
        title = html_escape(title),
        id = html_escape(id),
        version = version,
        kind = kind,
        body_html = body_html,
        live_script = live_script
    )
}

fn render_diff_html(content: &str) -> String {
    let mut out = String::new();
    out.push_str("<div class=\"diff-container\" style=\"font-family: monospace; white-space: pre;\">");
    for line in content.lines() {
        let escaped = html_escape(line);
        if line.starts_with("diff --git") || line.starts_with("--- ") || line.starts_with("+++ ") {
            out.push_str(&format!("<div class=\"diff-file\">{}</div>", escaped));
        } else if line.starts_with("@@") {
            out.push_str(&format!("<div class=\"diff-hunk\">{}</div>", escaped));
        } else if line.starts_with('+') && !line.starts_with("+++") {
            out.push_str(&format!("<div class=\"diff-add\">{}</div>", escaped));
        } else if line.starts_with('-') && !line.starts_with("---") {
            out.push_str(&format!("<div class=\"diff-del\">{}</div>", escaped));
        } else {
            out.push_str(&format!("<div>{}</div>", escaped));
        }
    }
    out.push_str("</div>");
    out
}

fn render_image_html(src: &str, alt: &str) -> String {
    let escaped_src = html_escape(src.trim());
    let escaped_alt = html_escape(alt);
    format!(
        r#"<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 200px; background: #0e0d0b; box-shadow: var(--bevel-dn); padding: 16px;">
  <img src="{src}" alt="{alt}" style="max-width: 100%; height: auto; border: 1px solid #2f2f2e; display: block;" />
  <div style="margin-top: 8px; font-size: 11px; color: var(--ink-dim);">{alt}</div>
</div>"#,
        src = escaped_src,
        alt = escaped_alt
    )
}

fn render_markdown_html(content: &str) -> String {
    let mut out = String::new();
    let mut in_code_block = false;

    for line in content.lines() {
        if line.starts_with("```") {
            if in_code_block {
                out.push_str("</code></pre>\n");
                in_code_block = false;
            } else {
                out.push_str("<pre><code>");
                in_code_block = true;
            }
            continue;
        }

        if in_code_block {
            out.push_str(&html_escape(line));
            out.push('\n');
            continue;
        }

        let trimmed = line.trim();
        if trimmed.starts_with("![") && trimmed.ends_with(')') && trimmed.contains("](") {
            let inner = &trimmed[2..trimmed.len() - 1];
            if let Some((alt, src)) = inner.split_once("](") {
                out.push_str(&format!(
                    "<div style=\"display: flex; flex-direction: column; align-items: center; margin: 12px 0; padding: 12px; background: #0e0d0b; box-shadow: var(--bevel-dn);\">\
                     <img src=\"{}\" alt=\"{}\" style=\"max-width: 100%; height: auto; border: 1px solid #2f2f2e; display: block;\" />\
                     <div style=\"margin-top: 6px; font-size: 10px; color: var(--ink-dim);\">{}</div>\
                     </div>\n",
                    html_escape(src.trim()),
                    html_escape(alt),
                    html_escape(alt),
                ));
                continue;
            }
        }

        let escaped = html_escape(line);
        if let Some(h1) = line.strip_prefix("# ") {
            out.push_str(&format!("<h1>{}</h1>\n", html_escape(h1)));
        } else if let Some(h2) = line.strip_prefix("## ") {
            out.push_str(&format!("<h2>{}</h2>\n", html_escape(h2)));
        } else if let Some(h3) = line.strip_prefix("### ") {
            out.push_str(&format!("<h3>{}</h3>\n", html_escape(h3)));
        } else if let Some(item) = line.strip_prefix("- ") {
            out.push_str(&format!("<ul><li>{}</li></ul>\n", html_escape(item)));
        } else if let Some(quote) = line.strip_prefix("> ") {
            out.push_str(&format!("<blockquote style=\"border-left: 3px solid var(--st-live); padding-left: 10px; margin: 8px 0; color: var(--ink-dim);\">{}</blockquote>\n", html_escape(quote)));
        } else if line.trim().is_empty() {
            out.push_str("<br/>\n");
        } else {
            out.push_str(&format!("<p>{}</p>\n", escaped));
        }
    }

    if in_code_block {
        out.push_str("</code></pre>\n");
    }
    out
}

pub async fn forward_artifacts(
    (retained, mut live): (
        Vec<Arc<ArtifactRecord>>,
        broadcast::Receiver<(Arc<ArtifactRecord>, bool)>,
    ),
    tx: Outbound,
) {
    for record in retained {
        let msg = json!({
            "event": "ArtifactEvent",
            "data": {
                "artifact": (*record).clone(),
                "open_pane": false,
                "phase": "catch-up"
            }
        });
        if tx.send(&msg).await.is_err() {
            return;
        }
    }
    loop {
        let update = tokio::select! {
            _ = tx.closed() => return,
            item = live.recv() => item,
        };
        match update {
            Ok((record, open_pane)) => {
                let msg = json!({
                    "event": "ArtifactEvent",
                    "data": {
                        "artifact": (*record).clone(),
                        "open_pane": open_pane,
                        "phase": "live"
                    }
                });
                if tx.send(&msg).await.is_err() {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_and_update_increments_version() {
        let hub = ArtifactHub::new();
        let post1 = ArtifactPost {
            id: Some("demo-1".into()),
            title: "Test 1".into(),
            artifact_type: "markdown".into(),
            content: "# Hello".into(),
            session_id: Some("session-a".into()),
            open_pane: Some(true),
        };
        let (rec1, open) = hub.publish_or_update(post1, None).unwrap();
        assert_eq!(rec1.version, 1);
        assert_eq!(rec1.id, "demo-1");
        assert!(open);

        let post2 = ArtifactPost {
            id: Some("demo-1".into()),
            title: "Test 1 Updated".into(),
            artifact_type: "markdown".into(),
            content: "# Hello World".into(),
            session_id: None,
            open_pane: Some(false),
        };
        let (rec2, open2) = hub.publish_or_update(post2, None).unwrap();
        assert_eq!(rec2.version, 2);
        assert_eq!(rec2.title, "Test 1 Updated");
        assert_eq!(rec2.session_id, Some("session-a".into()));
        assert!(!open2);
    }

    #[test]
    fn subscriber_receives_retained_and_live() {
        let hub = ArtifactHub::new();
        hub.publish_or_update(
            ArtifactPost {
                id: Some("art-1".into()),
                title: "One".into(),
                artifact_type: "markdown".into(),
                content: "Content 1".into(),
                session_id: None,
                open_pane: None,
            },
            None,
        )
        .unwrap();

        let (retained, mut receiver) = hub.subscribe();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].id, "art-1");

        hub.publish_or_update(
            ArtifactPost {
                id: Some("art-2".into()),
                title: "Two".into(),
                artifact_type: "html".into(),
                content: "<div>Content 2</div>".into(),
                session_id: None,
                open_pane: None,
            },
            None,
        )
        .unwrap();

        let live = receiver.try_recv().unwrap();
        assert_eq!(live.0.id, "art-2");
        assert!(live.1); // open_pane defaults to true
    }

    #[test]
    fn renders_standalone_pages_with_live_reload() {
        let hub = ArtifactHub::new();
        let record = ArtifactRecord {
            id: "doc-1".into(),
            title: "My Doc".into(),
            artifact_type: "markdown".into(),
            content: "# Overview\nSome text".into(),
            version: 1,
            session_id: None,
            created_at: 0,
            updated_at: 0,
        };
        let html = hub.render_standalone_page(&record);
        assert!(html.contains("ARTIFACT: My Doc"));
        assert!(html.contains("doc-1"));
        // Live reload rides the artifact's own event stream. The terminal
        // WebSocket refuses this page's origin by design, so a page that
        // reaches for it silently never reloads.
        assert!(html.contains("/artifact/doc-1/events"));
        assert!(html.contains("EventSource"));
        assert!(!html.contains("WebSocket"));
    }

    #[test]
    fn html_artifacts_keep_their_own_markup_and_still_get_live_reload() {
        let hub = ArtifactHub::new();
        let record = ArtifactRecord {
            id: "dash-1".into(),
            title: "Dashboard".into(),
            artifact_type: "html".into(),
            content: "<html><body><h1>Metrics</h1></body></html>".into(),
            version: 3,
            session_id: None,
            created_at: 0,
            updated_at: 0,
        };
        let html = hub.render_standalone_page(&record);
        assert!(html.contains("<h1>Metrics</h1>"));
        assert!(html.contains("/artifact/dash-1/events"));
        assert!(html.contains("var version = 3;"));
        assert!(!html.contains("WebSocket"));
    }

    #[test]
    fn publish_image_artifact_and_render_html() {
        let hub = ArtifactHub::new();
        let post = ArtifactPost {
            id: Some("img-1".into()),
            title: "Diagram".into(),
            artifact_type: "image".into(),
            content: "data:image/png;base64,iVBORw0KGgo=".into(),
            session_id: None,
            open_pane: Some(true),
        };
        let (record, open_pane) = hub.publish_or_update(post, None).unwrap();
        assert_eq!(record.artifact_type, "image");
        assert!(open_pane);
        let html = hub.render_standalone_page(&record);
        assert!(html.contains("[IMAGE]"));
        assert!(html.contains("<img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"Diagram\""));
    }

    #[test]
    fn render_markdown_with_embedded_images() {
        let md = "# Title\n\n![Screenshot](https://example.com/shot.png)\n\nParagraph text";
        let html = render_markdown_html(md);
        assert!(html.contains("<img src=\"https://example.com/shot.png\" alt=\"Screenshot\""));
    }
}
