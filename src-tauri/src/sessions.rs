use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const SCHEMA_VERSION: u32 = 1;
const MAX_MESSAGES: usize = 1_000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(0);

fn default_true() -> bool {
    true
}

fn default_compaction_threshold() -> f64 {
    0.8
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionUsage {
    #[serde(default)]
    pub(crate) input_tokens: u64,
    #[serde(default)]
    pub(crate) output_tokens: u64,
    #[serde(default)]
    pub(crate) reasoning_tokens: u64,
    #[serde(default)]
    pub(crate) cached_tokens: u64,
    #[serde(default)]
    pub(crate) total_tokens: u64,
    #[serde(default)]
    pub(crate) current_context_tokens: u64,
    #[serde(default)]
    pub(crate) api_calls: u64,
    #[serde(default)]
    pub(crate) source: String,
    #[serde(default)]
    pub(crate) cost_usd: Option<f64>,
    #[serde(default)]
    pub(crate) rate_limits: Option<Value>,
    #[serde(default)]
    pub(crate) last_request: Option<Value>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompactionState {
    #[serde(default = "default_true")]
    pub(crate) auto_enabled: bool,
    #[serde(default = "default_compaction_threshold")]
    pub(crate) threshold: f64,
    #[serde(default)]
    pub(crate) summary: String,
    #[serde(default)]
    pub(crate) compacted_through: usize,
    #[serde(default)]
    pub(crate) count: u64,
    #[serde(default)]
    pub(crate) last_at: Option<u64>,
    #[serde(default)]
    pub(crate) last_mode: Option<String>,
    #[serde(default)]
    pub(crate) tokens_before: u64,
    #[serde(default)]
    pub(crate) tokens_after: u64,
    #[serde(default)]
    pub(crate) tokens_saved: u64,
}

impl Default for CompactionState {
    fn default() -> Self {
        Self {
            auto_enabled: true,
            threshold: default_compaction_threshold(),
            summary: String::new(),
            compacted_through: 0,
            count: 0,
            last_at: None,
            last_mode: None,
            tokens_before: 0,
            tokens_after: 0,
            tokens_saved: 0,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionRecord {
    pub(crate) schema_version: u32,
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) workspace: String,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) title_generated: bool,
    #[serde(default)]
    pub(crate) context_limit: Option<u64>,
    #[serde(default)]
    pub(crate) context_ratio: Option<f64>,
    #[serde(default)]
    pub(crate) usage: SessionUsage,
    #[serde(default)]
    pub(crate) compaction: CompactionState,
    #[serde(default)]
    pub(crate) messages: Vec<Value>,
    #[serde(default)]
    pub(crate) draft: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    id: String,
    title: String,
    provider: String,
    model: String,
    workspace: String,
    updated_at: u64,
    status: String,
    message_count: usize,
    has_draft: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn sessions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Oturum dizini çözülemedi: {error}"))?
        .join("sessions");
    fs::create_dir_all(&path).map_err(|error| format!("Oturum dizini oluşturulamadı: {error}"))?;
    Ok(path)
}

fn checkpoints_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = sessions_dir(app)?.join("checkpoints");
    fs::create_dir_all(&path)
        .map_err(|error| format!("Checkpoint dizini oluşturulamadı: {error}"))?;
    Ok(path)
}

fn checkpoint_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !safe_id(id) {
        return Err("Geçersiz oturum kimliği".to_string());
    }
    Ok(checkpoints_dir(app)?.join(format!("{id}.json")))
}

fn session_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !safe_id(id) {
        return Err("Geçersiz oturum kimliği".to_string());
    }
    Ok(sessions_dir(app)?.join(format!("{id}.json")))
}

fn sanitize_title(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = compact.chars().take(64).collect();
    if title.is_empty() {
        "Yeni konuşma".to_string()
    } else {
        title
    }
}

fn contains_secret_key(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "apikey" | "api_key" | "authorization" | "secret" | "secretref" | "secret_ref"
            ) || contains_secret_key(value)
        }),
        Value::Array(values) => values.iter().any(contains_secret_key),
        _ => false,
    }
}

fn validate(record: &SessionRecord) -> Result<(), String> {
    if !safe_id(&record.id) {
        return Err("Geçersiz oturum kimliği".to_string());
    }
    if record.schema_version != SCHEMA_VERSION {
        return Err("Desteklenmeyen oturum şeması".to_string());
    }
    if record.messages.len() > MAX_MESSAGES {
        return Err("Oturum mesaj sınırını aşıyor".to_string());
    }
    if !(0.5..=0.95).contains(&record.compaction.threshold) {
        return Err("Geçersiz auto-compact eşiği".to_string());
    }
    if record.compaction.compacted_through > record.messages.len() {
        return Err("Compact sınırı mesaj geçmişini aşıyor".to_string());
    }
    if record.compaction.summary.len() > 256 * 1024 {
        return Err("Compact özeti boyut sınırını aşıyor".to_string());
    }
    if record.messages.iter().any(contains_secret_key)
        || record.draft.as_ref().is_some_and(contains_secret_key)
    {
        return Err("Oturum verisi gizli anahtar alanı içeremez".to_string());
    }
    if !matches!(
        record.status.as_str(),
        "active" | "interrupted" | "complete"
    ) {
        return Err("Geçersiz oturum durumu".to_string());
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("json.new");
    let backup = path.with_extension("json.bak");
    {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("Oturum geçici dosyası açılamadı: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Oturum diske yazılamadı: {error}"))?;
    }
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| format!("Eski oturum yedeklenemedi: {error}"))?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!("Oturum atomik olarak değiştirilemedi: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn read_record(path: &Path) -> Result<SessionRecord, String> {
    let bytes = fs::read(path)
        .or_else(|_| fs::read(path.with_extension("json.bak")))
        .map_err(|error| format!("Oturum okunamadı: {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("Oturum dosyası boyut sınırını aşıyor".to_string());
    }
    let record: SessionRecord = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Oturum JSON verisi bozuk: {error}"))?;
    validate(&record)?;
    Ok(record)
}

pub(crate) fn create(
    app: &tauri::AppHandle,
    title: String,
    provider: String,
    model: String,
    workspace: String,
) -> Result<SessionRecord, String> {
    let now = now_ms();
    let serial = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    let record = SessionRecord {
        schema_version: SCHEMA_VERSION,
        id: format!("s-{now:x}-{:x}-{serial:x}", std::process::id()),
        title: sanitize_title(&title),
        provider,
        model,
        workspace,
        created_at: now,
        updated_at: now,
        status: "active".to_string(),
        title_generated: false,
        context_limit: None,
        context_ratio: None,
        usage: SessionUsage::default(),
        compaction: CompactionState::default(),
        messages: Vec::new(),
        draft: None,
    };
    save(app, record.clone())?;
    Ok(record)
}

pub(crate) fn save(
    app: &tauri::AppHandle,
    mut record: SessionRecord,
) -> Result<SessionRecord, String> {
    record.title = sanitize_title(&record.title);
    record.updated_at = now_ms();
    validate(&record)?;
    let bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("Oturum serileştirilemedi: {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("Oturum dosyası boyut sınırını aşıyor".to_string());
    }
    write_atomic(&session_path(app, &record.id)?, &bytes)?;
    Ok(record)
}

pub(crate) fn load(app: &tauri::AppHandle, id: &str) -> Result<SessionRecord, String> {
    read_record(&session_path(app, id)?)
}

pub(crate) fn checkpoint(app: &tauri::AppHandle, record: SessionRecord) -> Result<(), String> {
    validate(&record)?;
    let bytes = serde_json::to_vec_pretty(&record)
        .map_err(|error| format!("Checkpoint serileştirilemedi: {error}"))?;
    if bytes.len() > MAX_BYTES {
        return Err("Checkpoint boyut sınırını aşıyor".to_string());
    }
    write_atomic(&checkpoint_path(app, &record.id)?, &bytes)
}

pub(crate) fn list(app: &tauri::AppHandle) -> Result<Vec<SessionSummary>, String> {
    let mut summaries = Vec::new();
    for entry in fs::read_dir(sessions_dir(app)?)
        .map_err(|error| format!("Oturum listesi okunamadı: {error}"))?
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Ok(record) = read_record(&path) {
            summaries.push(SessionSummary {
                id: record.id,
                title: record.title,
                provider: record.provider,
                model: record.model,
                workspace: record.workspace,
                updated_at: record.updated_at,
                status: record.status,
                message_count: record.messages.len(),
                has_draft: record.draft.is_some(),
            });
        }
    }
    summaries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(summaries)
}

pub(crate) fn latest(app: &tauri::AppHandle) -> Result<Option<SessionRecord>, String> {
    let Some(summary) = list(app)?.into_iter().next() else {
        return Ok(None);
    };
    load(app, &summary.id).map(Some)
}

pub(crate) fn delete(app: &tauri::AppHandle, id: &str) -> Result<bool, String> {
    let path = session_path(app, id)?;
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(path).map_err(|error| format!("Oturum silinemedi: {error}"))?;
    if let Ok(checkpoint) = checkpoint_path(app, id) {
        let _ = fs::remove_file(checkpoint);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_titles_are_bounded() {
        assert!(safe_id("s-abc_123"));
        assert!(!safe_id("../escape"));
        assert_eq!(sanitize_title("  bir   iki  "), "bir iki");
        assert_eq!(sanitize_title(""), "Yeni konuşma");
    }

    #[test]
    fn secret_shaped_fields_are_rejected() {
        assert!(contains_secret_key(
            &serde_json::json!({"nested":{"apiKey":"nope"}})
        ));
        assert!(!contains_secret_key(
            &serde_json::json!({"role":"user","content":"apiKey kelimesi metinde güvenli"})
        ));
    }

    #[test]
    fn atomic_snapshot_round_trips_without_temp_residue() {
        let root = std::env::temp_dir().join(format!(
            "cli-terminal-session-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("s-test.json");
        let record = SessionRecord {
            schema_version: SCHEMA_VERSION,
            id: "s-test".to_string(),
            title: "Test".to_string(),
            provider: "openai".to_string(),
            model: "test-model".to_string(),
            workspace: "C:\\work".to_string(),
            created_at: 1,
            updated_at: 2,
            status: "active".to_string(),
            title_generated: false,
            context_limit: Some(128_000),
            context_ratio: Some(0.8),
            usage: SessionUsage::default(),
            compaction: CompactionState::default(),
            messages: vec![serde_json::json!({"role":"user","content":"merhaba"})],
            draft: None,
        };
        let bytes = serde_json::to_vec_pretty(&record).unwrap();
        write_atomic(&path, &bytes).unwrap();
        let loaded = read_record(&path).unwrap();
        assert_eq!(loaded.id, record.id);
        assert_eq!(loaded.messages, record.messages);
        assert!(!path.with_extension("json.new").exists());
        assert!(!path.with_extension("json.bak").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_session_defaults_usage_and_compaction() {
        let value = serde_json::json!({
            "schemaVersion": 1,
            "id": "s-legacy",
            "title": "Legacy",
            "provider": "gemini",
            "model": "gemini-test",
            "workspace": "C:\\work",
            "createdAt": 1,
            "updatedAt": 2,
            "status": "complete",
            "messages": []
        });
        let record: SessionRecord = serde_json::from_value(value).unwrap();
        assert_eq!(record.usage.total_tokens, 0);
        assert!(record.compaction.auto_enabled);
        assert_eq!(record.compaction.threshold, 0.8);
    }
}
