use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use zeroize::Zeroize;

mod config_store;
mod diagnostics;
mod permissions;
mod providers;
mod secrets;
mod sessions;
mod streaming;
mod themes;

#[cfg(test)]
use config_store::LinkedProvider;
use config_store::{
    config_path, default_mode, read_stored_config, request_timeout, resolve_secret,
    save_stored_config, sync_active_provider, write_sanitized_config, AppConfig,
};

const MODEL_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const MODEL_CACHE_STALE_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60);

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct ModelCacheKey {
    provider: String,
    endpoint: String,
    protocol: Option<String>,
    auth_scheme: Option<String>,
    secret_ref: Option<String>,
    models_path: Option<String>,
    header_names: Vec<String>,
}

#[derive(Clone)]
struct CachedModels {
    fetched_at: std::time::Instant,
    items: Vec<providers::ModelInfo>,
}

fn model_cache() -> &'static std::sync::Mutex<std::collections::HashMap<ModelCacheKey, CachedModels>>
{
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<ModelCacheKey, CachedModels>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[derive(Serialize)]
struct DirEntry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
struct CommandResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

fn model_cache_key(config: &AppConfig) -> ModelCacheKey {
    let mut header_names = config
        .header_names
        .iter()
        .map(|name| name.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();
    header_names.sort_unstable();
    header_names.dedup();
    ModelCacheKey {
        provider: config.provider.clone(),
        endpoint: providers::normalize_base_url(&config.provider, &config.base_url),
        protocol: config.protocol.clone(),
        auth_scheme: config.auth_scheme.clone(),
        secret_ref: config.secret_ref.clone(),
        models_path: config.models_path.clone(),
        header_names,
    }
}

fn cached_models(
    key: &ModelCacheKey,
    max_age: std::time::Duration,
) -> Option<Vec<providers::ModelInfo>> {
    let cache = model_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache
        .get(key)
        .filter(|entry| entry.fetched_at.elapsed() <= max_age)
        .map(|entry| entry.items.clone())
}

fn store_models(key: ModelCacheKey, items: Vec<providers::ModelInfo>) {
    let mut cache = model_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.insert(
        key,
        CachedModels {
            fetched_at: std::time::Instant::now(),
            items,
        },
    );
}

fn invalidate_model_cache(provider: &str) {
    let mut cache = model_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache.retain(|key, _| key.provider != provider);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConnectionInput {
    provider: String,
    #[serde(default)]
    api_key: String,
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    auth_scheme: Option<String>,
    #[serde(default)]
    models_path: Option<String>,
    #[serde(default)]
    chat_path: Option<String>,
    #[serde(default)]
    headers: Vec<secrets::SecretHeader>,
    #[serde(default)]
    replace_headers: bool,
    #[serde(default)]
    request_timeout_secs: Option<u64>,
    #[serde(default)]
    allow_local_network: bool,
}

impl Drop for ProviderConnectionInput {
    fn drop(&mut self) {
        self.api_key.zeroize();
        for header in &mut self.headers {
            header.value.zeroize();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConnectionResult {
    validation: providers::ProviderValidation,
    secret_ref: Option<String>,
    header_names: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    provider_id: String,
    connected: bool,
    message: String,
}

/// Returns stored configuration without secret values.
#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Result<Option<AppConfig>, String> {
    read_stored_config(&app)
}

/// Stores only secret references and public configuration metadata.
#[tauri::command]
fn save_config(app: tauri::AppHandle, mut config: AppConfig) -> Result<(), String> {
    save_stored_config(&app, &mut config)
}

/// Builds the model request with provider-specific authentication, endpoint, and safe headers.
fn build_models_request(
    config: &AppConfig,
    secret: &secrets::SecretBundle,
) -> Result<ureq::Request, String> {
    providers::models_request(
        &config.provider,
        &config.base_url,
        &secret.api_key,
        config.protocol.as_deref(),
        config.auth_scheme.as_deref(),
        config.models_path.as_deref(),
        &secret.headers,
        request_timeout(config, 15),
        config.allow_local_network,
    )
}

#[tauri::command]
fn provider_catalog() -> Vec<providers::ProviderInfo> {
    providers::catalog()
}

fn validate_provider_connection(
    config: &AppConfig,
    secret: &secrets::SecretBundle,
) -> Result<providers::ProviderValidation, String> {
    let resp = call_with_retry(|| build_models_request(config, secret))?;
    let body = resp.into_string().map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let models = providers::parse_models(&config.provider, config.protocol.as_deref(), &json);
    let recommended_model = providers::recommended_model(&config.provider, &models);
    Ok(providers::ProviderValidation {
        provider_id: config.provider.clone(),
        model_count: models.len(),
        recommended_model,
        message: format!("{} current agent models found", models.len()),
    })
}

fn connection_config(input: &ProviderConnectionInput) -> AppConfig {
    AppConfig {
        provider: input.provider.clone(),
        api_key: String::new(),
        base_url: input.base_url.clone(),
        model: input.model.clone(),
        mode: default_mode(),
        allow_list: Vec::new(),
        providers: Vec::new(),
        context_limit: None,
        context_ratio: None,
        max_output_tokens: None,
        input_price_per_million: None,
        output_price_per_million: None,
        cached_input_price_per_million: None,
        protocol: input.protocol.clone(),
        auth_scheme: input.auth_scheme.clone(),
        secret_ref: None,
        models_path: input.models_path.clone(),
        chat_path: input.chat_path.clone(),
        header_names: input
            .headers
            .iter()
            .map(|header| header.name.clone())
            .collect(),
        request_timeout_secs: input.request_timeout_secs,
        allow_local_network: input.allow_local_network,
        thinking_mode: None,
        thinking_budget: None,
    }
}

#[tauri::command]
async fn connect_provider_secure(
    mut connection: ProviderConnectionInput,
) -> Result<ProviderConnectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let candidate_ref = secrets::provider_reference(&connection.provider)?;
        if connection.headers.is_empty() && !connection.replace_headers {
            if let Ok(existing) = secrets::read(&candidate_ref) {
                connection.headers = existing.headers.clone();
            }
        }
        providers::validate_headers(&connection.headers)?;
        let config = connection_config(&connection);
        let secret = secrets::SecretBundle {
            api_key: connection.api_key.clone(),
            headers: connection.headers.clone(),
        };
        let validation = validate_provider_connection(&config, &secret)?;
        let auth = providers::effective_auth(&config.provider, config.auth_scheme.as_deref());
        let needs_secret = auth != providers::AuthScheme::None || !secret.headers.is_empty();
        let secret_ref = if needs_secret {
            secrets::store(&candidate_ref, &secret)?;
            Some(candidate_ref)
        } else {
            None
        };
        invalidate_model_cache(&config.provider);
        Ok(ProviderConnectionResult {
            validation,
            secret_ref,
            header_names: config.header_names,
        })
    })
    .await
    .map_err(|e| format!("Worker thread error: {}", e))?
}

#[tauri::command]
async fn test_provider_connection(
    config: AppConfig,
) -> Result<providers::ProviderValidation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let secret = resolve_secret(&config)?;
        validate_provider_connection(&config, &secret)
    })
    .await
    .map_err(|e| format!("Worker thread error: {}", e))?
}

#[tauri::command]
fn credential_status(config: AppConfig) -> CredentialStatus {
    let auth = providers::effective_auth(&config.provider, config.auth_scheme.as_deref());
    let connected = if auth == providers::AuthScheme::None && config.header_names.is_empty() {
        true
    } else {
        config
            .secret_ref
            .as_deref()
            .map(secrets::exists)
            .unwrap_or(false)
    };
    CredentialStatus {
        provider_id: config.provider,
        connected,
        message: if connected {
            "Credentials are available in the secure vault".to_string()
        } else {
            "Credentials are missing; reconnect the provider".to_string()
        },
    }
}

#[tauri::command]
fn disconnect_provider(
    app: tauri::AppHandle,
    provider_id: String,
) -> Result<Option<AppConfig>, String> {
    let mut config = match read_stored_config(&app)? {
        Some(config) => config,
        None => return Ok(None),
    };
    let provider = config
        .providers
        .iter()
        .find(|provider| provider.id == provider_id)
        .cloned()
        .ok_or_else(|| "Provider connection was not found".to_string())?;
    if let Some(secret_ref) = provider.secret_ref.as_deref() {
        secrets::delete(secret_ref)?;
    }
    config
        .providers
        .retain(|provider| provider.id != provider_id);
    if config.provider == provider_id {
        if let Some(next) = config.providers.first() {
            config.provider = next.id.clone();
            sync_active_provider(&mut config);
        } else {
            config.provider.clear();
            config.base_url.clear();
            config.model.clear();
            config.secret_ref = None;
            config.protocol = None;
            config.auth_scheme = None;
            config.models_path = None;
            config.chat_path = None;
            config.header_names.clear();
        }
    }
    write_sanitized_config(&config_path(&app)?, &config)?;
    invalidate_model_cache(&provider_id);
    Ok(Some(config))
}

/// Returns the model list for the stored provider configuration.
#[tauri::command]
async fn list_models(
    config: AppConfig,
    refresh: Option<bool>,
) -> Result<Vec<providers::ModelInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache_key = model_cache_key(&config);
        if !refresh.unwrap_or(false) {
            if let Some(items) = cached_models(&cache_key, MODEL_CACHE_TTL) {
                return Ok(items);
            }
        }
        let stale = cached_models(&cache_key, MODEL_CACHE_STALE_TTL);
        let secret = resolve_secret(&config)?;
        let fetched = (|| {
            let resp = call_with_retry(|| build_models_request(&config, &secret))?;
            let body = resp.into_string().map_err(|e| e.to_string())?;
            let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
            Ok::<_, String>(providers::parse_models(
                &config.provider,
                config.protocol.as_deref(),
                &json,
            ))
        })();
        match fetched {
            Ok(items) => {
                if !items.is_empty() {
                    store_models(cache_key, items.clone());
                }
                Ok(items)
            }
            Err(_) if stale.is_some() => Ok(stale.unwrap_or_default()),
            Err(error) => Err(error),
        }
    })
    .await
    .map_err(|e| format!("Worker thread error: {}", e))?
}

/// Returns the current working directory.
#[tauri::command]
fn pwd() -> String {
    std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "/".to_string())
}

/// Returns the user home directory.
#[tauri::command]
fn home() -> String {
    dirs_home()
}

fn validate_external_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err("Invalid link.".to_string());
    }
    let parsed = url::Url::parse(value).map_err(|_| "Invalid link.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Yalnizca HTTP ve HTTPS baglantilari acilabilir.".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Links containing credentials cannot be opened.".to_string());
    }
    Ok(parsed.to_string())
}

fn resolve_reveal_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return Err("Invalid file path.".to_string());
    }
    if value.starts_with("\\\\") || value.starts_with("//") {
        return Err("Network paths cannot be opened for security reasons.".to_string());
    }
    let expanded = PathBuf::from(expand_path(value));
    let candidate = if expanded.is_absolute() {
        expanded
    } else {
        std::env::current_dir()
            .map_err(|e| format!("Could not read working directory: {e}"))?
            .join(expanded)
    };
    candidate
        .canonicalize()
        .map_err(|_| "Path was not found or is inaccessible.".to_string())
}

/// Markdown yanitindaki harici baglantiyi yalnizca acik kullanici tiklamasiyla acar.
#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let safe_url = validate_external_url(&url)?;
    app.opener()
        .open_url(safe_url, None::<&str>)
        .map_err(|e| format!("Could not open link: {e}"))
}

/// Reveals files in Explorer without executing them and opens directories in the default shell.
#[tauri::command]
fn reveal_local_path(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let canonical = resolve_reveal_path(&path)?;
    if canonical.is_dir() {
        app.opener()
            .open_path(canonical.to_string_lossy().into_owned(), None::<&str>)
            .map_err(|e| format!("Could not open directory: {e}"))?;
    } else {
        app.opener()
            .reveal_item_in_dir(&canonical)
            .map_err(|e| format!("Could not reveal file: {e}"))?;
    }
    Ok(canonical.display().to_string())
}

/// Changes the current working directory.
#[tauri::command]
fn change_dir(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    let path_obj = Path::new(&path);

    if !path_obj.exists() {
        return Err(format!("Path not found: {}", path));
    }
    if !path_obj.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    std::env::set_current_dir(path_obj).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Runs a system command for the legacy `/run` path.
#[tauri::command]
fn run_command(command: &str, args: Vec<String>) -> Result<CommandResult, String> {
    let output = Command::new(command)
        .args(&args)
        .output()
        .map_err(|e| format!("Could not run command: {}", e))?;

    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Quits the application.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Expands path shorthand such as `~` and `.`.
fn expand_path(path: &str) -> String {
    if path == "~" {
        return dirs_home();
    }
    if path.starts_with("~/") {
        return format!("{}/{}", dirs_home(), &path[2..]);
    }
    if path.starts_with("~\\") {
        return format!("{}\\{}", dirs_home(), &path[2..]);
    }
    path.to_string()
}

fn dirs_home() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeMessage {
    role: String, // system | user | assistant | tool
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallMsg>>,
    /// Preserves reasoning content across tool rounds for OpenAI-compatible
    /// providers such as DeepSeek and Fireworks.
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    thinking_signature: Option<String>,
    #[serde(default)]
    attachments: Vec<NativeAttachment>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeAttachment {
    name: String,
    mime_type: String,
    kind: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    data_url: Option<String>,
}

fn split_data_url(value: &str) -> Option<(&str, &str)> {
    let (header, data) = value.split_once(',')?;
    let media_type = header.strip_prefix("data:")?.strip_suffix(";base64")?;
    (!media_type.is_empty() && !data.is_empty()).then_some((media_type, data))
}

fn validate_native_messages(
    protocol: providers::ProviderProtocol,
    messages: &[NativeMessage],
) -> Result<(), String> {
    let mut encoded_total = 0usize;
    for message in messages {
        if message.attachments.len() > 4 {
            return Err("A message can contain at most 4 attachments".into());
        }
        for attachment in &message.attachments {
            if message.role != "user" {
                return Err("Attachments are only allowed on user messages".into());
            }
            if attachment.name.is_empty() || attachment.name.chars().count() > 180 {
                return Err("Attachment name is invalid".into());
            }
            if attachment.mime_type.is_empty() || attachment.mime_type.len() > 100 {
                return Err("Attachment media type is invalid".into());
            }
            match attachment.kind.as_str() {
                "text" => {
                    let text = attachment.text.as_deref().unwrap_or_default();
                    if text.is_empty() || text.len() > 256 * 1024 {
                        return Err("Text attachments must be between 1 byte and 256 KB".into());
                    }
                    encoded_total = encoded_total.saturating_add(text.len());
                }
                "image" => {
                    let value = attachment.data_url.as_deref().unwrap_or_default();
                    let (media_type, data) = split_data_url(value)
                        .ok_or_else(|| "Image attachment must use a base64 data URL".to_string())?;
                    if !media_type.starts_with("image/") || media_type != attachment.mime_type {
                        return Err(
                            "Image attachment media type does not match its data URL".into()
                        );
                    }
                    if data.len() > 4 * 1024 * 1024 {
                        return Err("Image attachments must be 3 MB or smaller".into());
                    }
                    encoded_total = encoded_total.saturating_add(data.len());
                }
                "document" => {
                    if protocol == providers::ProviderProtocol::OpenAiChat {
                        return Err("PDF attachments are not supported by the active Chat Completions protocol".into());
                    }
                    let value = attachment.data_url.as_deref().unwrap_or_default();
                    let (media_type, data) = split_data_url(value)
                        .ok_or_else(|| "PDF attachment must use a base64 data URL".to_string())?;
                    if media_type != "application/pdf" || attachment.mime_type != "application/pdf"
                    {
                        return Err("Document attachments must be application/pdf".into());
                    }
                    if data.len() > 4 * 1024 * 1024 {
                        return Err("PDF attachments must be 3 MB or smaller".into());
                    }
                    encoded_total = encoded_total.saturating_add(data.len());
                }
                _ => return Err("Unsupported attachment kind".into()),
            }
        }
    }
    if encoded_total > 6 * 1024 * 1024 {
        return Err("Attachments are too large for a single request".into());
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolCallMsg {
    id: String,
    name: String,
    arguments: serde_json::Value,
    #[serde(default)]
    thought_signature: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ToolCallData {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: serde_json::Value,
    #[serde(rename = "thoughtSignature")]
    pub(crate) thought_signature: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ChatResult {
    pub(crate) text: String,
    pub(crate) tool_calls: Vec<ToolCallData>,
    pub(crate) reasoning: Option<String>,
    pub(crate) thinking_signature: Option<String>,
    pub(crate) usage: TokenUsage,
    pub(crate) model: Option<String>,
    pub(crate) finish_reason: Option<String>,
    pub(crate) rate_limits: Option<RateLimitInfo>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) reasoning_tokens: u64,
    pub(crate) cached_tokens: u64,
    pub(crate) total_tokens: u64,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RateLimitInfo {
    pub(crate) requests_limit: Option<String>,
    pub(crate) requests_remaining: Option<String>,
    pub(crate) tokens_limit: Option<String>,
    pub(crate) tokens_remaining: Option<String>,
    pub(crate) requests_reset: Option<String>,
    pub(crate) tokens_reset: Option<String>,
    pub(crate) input_tokens_limit: Option<String>,
    pub(crate) input_tokens_remaining: Option<String>,
    pub(crate) input_tokens_reset: Option<String>,
    pub(crate) output_tokens_limit: Option<String>,
    pub(crate) output_tokens_remaining: Option<String>,
    pub(crate) output_tokens_reset: Option<String>,
    pub(crate) cached_input_tokens_limit: Option<String>,
    pub(crate) cached_input_tokens_remaining: Option<String>,
    pub(crate) cached_input_tokens_reset: Option<String>,
    pub(crate) project_tokens_limit: Option<String>,
    pub(crate) project_tokens_remaining: Option<String>,
    pub(crate) project_tokens_reset: Option<String>,
    pub(crate) retry_after: Option<String>,
}

fn first_rate_header<F>(header: &F, names: &[&str]) -> Option<String>
where
    F: Fn(&str) -> Option<String>,
{
    names.iter().find_map(|name| header(name))
}

fn rate_limits_from_headers<F>(header: F) -> Option<RateLimitInfo>
where
    F: Fn(&str) -> Option<String>,
{
    let info = RateLimitInfo {
        requests_limit: first_rate_header(
            &header,
            &[
                "x-ratelimit-limit-requests",
                "anthropic-ratelimit-requests-limit",
                "x-ratelimit-limit",
                "x-ratelimit-limit-dynamic",
            ],
        ),
        requests_remaining: first_rate_header(
            &header,
            &[
                "x-ratelimit-remaining-requests",
                "anthropic-ratelimit-requests-remaining",
                "x-ratelimit-remaining",
                "x-ratelimit-remaining-dynamic",
            ],
        ),
        tokens_limit: first_rate_header(
            &header,
            &[
                "x-ratelimit-limit-tokens",
                "anthropic-ratelimit-tokens-limit",
                "anthropic-ratelimit-unified-tokens-limit",
                "x-tokenlimit-limit",
                "x-tokenlimit-limit-dynamic",
            ],
        ),
        tokens_remaining: first_rate_header(
            &header,
            &[
                "x-ratelimit-remaining-tokens",
                "anthropic-ratelimit-tokens-remaining",
                "anthropic-ratelimit-unified-tokens-remaining",
                "x-tokenlimit-remaining",
                "x-tokenlimit-remaining-dynamic",
            ],
        ),
        requests_reset: first_rate_header(
            &header,
            &[
                "x-ratelimit-reset-requests",
                "anthropic-ratelimit-requests-reset",
                "x-ratelimit-reset",
            ],
        ),
        tokens_reset: first_rate_header(
            &header,
            &[
                "x-ratelimit-reset-tokens",
                "anthropic-ratelimit-tokens-reset",
                "anthropic-ratelimit-unified-tokens-reset",
                "x-tokenlimit-reset",
            ],
        ),
        input_tokens_limit: first_rate_header(
            &header,
            &[
                "anthropic-ratelimit-input-tokens-limit",
                "x-ratelimit-limit-tokens-prompt",
            ],
        ),
        input_tokens_remaining: first_rate_header(
            &header,
            &["anthropic-ratelimit-input-tokens-remaining"],
        ),
        input_tokens_reset: first_rate_header(&header, &["anthropic-ratelimit-input-tokens-reset"]),
        output_tokens_limit: first_rate_header(
            &header,
            &[
                "anthropic-ratelimit-output-tokens-limit",
                "x-ratelimit-limit-tokens-generated",
            ],
        ),
        output_tokens_remaining: first_rate_header(
            &header,
            &["anthropic-ratelimit-output-tokens-remaining"],
        ),
        output_tokens_reset: first_rate_header(
            &header,
            &["anthropic-ratelimit-output-tokens-reset"],
        ),
        cached_input_tokens_limit: first_rate_header(
            &header,
            &[
                "anthropic-ratelimit-cache-creation-input-tokens-limit",
                "x-ratelimit-limit-tokens-cache-adjusted-prompt",
            ],
        ),
        cached_input_tokens_remaining: first_rate_header(
            &header,
            &["anthropic-ratelimit-cache-creation-input-tokens-remaining"],
        ),
        cached_input_tokens_reset: first_rate_header(
            &header,
            &["anthropic-ratelimit-cache-creation-input-tokens-reset"],
        ),
        project_tokens_limit: first_rate_header(&header, &["x-ratelimit-limit-project-tokens"]),
        project_tokens_remaining: first_rate_header(
            &header,
            &["x-ratelimit-remaining-project-tokens"],
        ),
        project_tokens_reset: first_rate_header(&header, &["x-ratelimit-reset-project-tokens"]),
        retry_after: first_rate_header(&header, &["retry-after"]),
    };
    (info.requests_limit.is_some()
        || info.requests_remaining.is_some()
        || info.tokens_limit.is_some()
        || info.tokens_remaining.is_some()
        || info.requests_reset.is_some()
        || info.tokens_reset.is_some()
        || info.input_tokens_limit.is_some()
        || info.input_tokens_remaining.is_some()
        || info.input_tokens_reset.is_some()
        || info.output_tokens_limit.is_some()
        || info.output_tokens_remaining.is_some()
        || info.output_tokens_reset.is_some()
        || info.cached_input_tokens_limit.is_some()
        || info.cached_input_tokens_remaining.is_some()
        || info.cached_input_tokens_reset.is_some()
        || info.project_tokens_limit.is_some()
        || info.project_tokens_remaining.is_some()
        || info.project_tokens_reset.is_some()
        || info.retry_after.is_some())
    .then_some(info)
}

pub(crate) fn rate_limits_from_response(response: &ureq::Response) -> Option<RateLimitInfo> {
    rate_limits_from_headers(|name| response.header(name).map(str::to_string))
}

/// Native tool schemas in OpenAI-compatible format.
fn native_tools() -> &'static serde_json::Value {
    static TOOLS: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    TOOLS.get_or_init(|| serde_json::json!([
        {"type":"function","function":{"name":"read_file","description":"Reads file content with line numbers. Supports optional line range.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Target file path"},"start_line":{"type":"number","description":"Optional start line"},"end_line":{"type":"number","description":"Optional end line"}},"required":["path"]}}},
        {"type":"function","function":{"name":"list_dir","description":"Lists files and subdirectories within a given folder path.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Directory path (default .)"}},"required":[]}}},
        {"type":"function","function":{"name":"search_code","description":"Searches for text pattern across project files.","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"Search query"},"path":{"type":"string","description":"Directory scope"}},"required":["pattern"]}}},
        {"type":"function","function":{"name":"glob_files","description":"Finds files matching a glob pattern (e.g. src/**/*.ts).","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}},
        {"type":"function","function":{"name":"write_file","description":"Creates a new file or completely overwrites an existing file.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Target file path"},"content":{"type":"string","description":"File content to write"}},"required":["path","content"]}}},
        {"type":"function","function":{"name":"edit_file","description":"Replaces a specific code snippet within a file using search and replace.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Target file path"},"old_string":{"type":"string","description":"Exact code block to replace"},"new_string":{"type":"string","description":"New replacement code block"}},"required":["path","old_string","new_string"]}}},
        {"type":"function","function":{"name":"apply_diff","description":"Applies a git-compatible unified diff patch to the repository.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Repository directory"},"diff_content":{"type":"string","description":"Unified diff content"}},"required":["path","diff_content"]}}},
        {"type":"function","function":{"name":"create_dir","description":"Creates a new directory (and parents if needed).","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Directory path to create"}},"required":["path"]}}},
        {"type":"function","function":{"name":"delete_file","description":"Deletes a file or directory recursively.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"File or directory to delete"}},"required":["path"]}}},
        {"type":"function","function":{"name":"execute_command","description":"Executes terminal commands (npm, git, build, tests) in the OS shell.","parameters":{"type":"object","properties":{"command":{"type":"string","description":"Shell command to run"},"timeout":{"type":"number","description":"Timeout in ms (default 30000)"}},"required":["command"]}}},
        {"type":"function","function":{"name":"manage_background_process","description":"Starts, stops, checks or reads logs of a background process.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["start","stop","status","logs"],"description":"Operation"},"command":{"type":"string","description":"Command to start"},"process_id":{"type":"string","description":"Process id"}},"required":["action"]}}},
        {"type":"function","function":{"name":"web_fetch","description":"Fetches webpage content and converts it to clean Markdown text.","parameters":{"type":"object","properties":{"url":{"type":"string","description":"URL to fetch"}},"required":["url"]}}},
        {"type":"function","function":{"name":"browser_automation","description":"Controls Edge headless browser: navigate, extract text, take screenshot.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["navigate","extract_text","take_screenshot"],"description":"Operation"},"url":{"type":"string","description":"Target URL"},"selector":{"type":"string","description":"CSS selector"}},"required":["action"]}}},
        {"type":"function","function":{"name":"github_action","description":"Git operations: commit, create PR, view issues, repo status.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["commit","create_pr","view_issues","repo_status"],"description":"Operation"},"message":{"type":"string","description":"Commit/PR message"},"branch":{"type":"string","description":"Branch name"}},"required":["action"]}}},
        {"type":"function","function":{"name":"analyze_codebase","description":"Analyzes code: symbol definition, references or directory structure.","parameters":{"type":"object","properties":{"symbol":{"type":"string","description":"Symbol to analyze"},"type":{"type":"string","enum":["definition","references","structure"],"description":"Analysis type"},"path":{"type":"string","description":"Directory scope"}},"required":[]}}},
        {"type":"function","function":{"name":"manage_memory","description":"Reads, adds or clears project memory at ~/.agent/MEMORIES.md.","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["read","add","clear"],"description":"Operation"},"key":{"type":"string","description":"Memory key"},"value":{"type":"string","description":"Memory value"}},"required":["action"]}}},
        {"type":"function","function":{"name":"spawn_sub_agent","description":"Delegates a complex subtask to an independent sub-agent and returns its report.","parameters":{"type":"object","properties":{"sub_task_prompt":{"type":"string","description":"Subtask description"},"model":{"type":"string","description":"Optional model override"},"timeout_seconds":{"type":"number","description":"Timeout in seconds"}},"required":["sub_task_prompt"]}}},
        {"type":"function","function":{"name":"enter_plan_mode","description":"Presents a concrete implementation plan for user review before any mutating work. Wait for the tool result before continuing.","parameters":{"type":"object","properties":{"title":{"type":"string","description":"Short plan title"},"rationale":{"type":"string","description":"Why planning is useful for this task"},"steps":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":12,"description":"Concrete ordered implementation steps"}},"required":["title","steps"]}}}
    ]))
}

/// Keeps core coding tools stable and adds optional remote capabilities only
/// when the request needs them instead of sending every schema on every turn.
fn last_user_request(messages: &[NativeMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|message| message.role == "user")
        .and_then(|message| message.content.as_deref())
        .unwrap_or_default()
        .to_lowercase()
}

fn request_mentions(request: &str, words: &[&str]) -> bool {
    words.iter().any(|word| request.contains(word))
}

/// Groq's free tier has a tight per-minute token budget. Sending the complete
/// tool library on conversational turns wastes most of it before generation
/// starts, so route only the tools that match the current user intent.
fn groq_tool_names(messages: &[NativeMessage]) -> Vec<&'static str> {
    let request = last_user_request(messages);
    let mut selected = Vec::new();
    let mut add = |names: &[&'static str]| {
        for name in names {
            if selected.len() >= 5 {
                break;
            }
            if !selected.contains(name) {
                selected.push(*name);
            }
        }
    };

    let web = request_mentions(
        &request,
        &[
            "web",
            "internet",
            "site",
            "url",
            "http",
            "araştır",
            "güncel",
            "browse",
        ],
    );
    let github = request_mentions(
        &request,
        &[
            "github",
            "git ",
            "commit",
            "push",
            "pull request",
            "repo",
            "issue",
        ],
    );
    let memory = request_mentions(&request, &["hafıza", "memory", "hatırla"]);
    let delegation = request_mentions(
        &request,
        &[
            "alt ajan",
            "sub-agent",
            "sub agent",
            "delege",
            "paralel ajan",
        ],
    );
    let command = request_mentions(
        &request,
        &[
            "komut",
            "command",
            "terminal",
            "çalıştır",
            "run ",
            "build",
            "test",
            "npm",
            "cargo",
        ],
    );
    let process = request_mentions(
        &request,
        &[
            "server",
            "sunucu",
            "process",
            "süreç",
            "background",
            "arka plan",
        ],
    );
    let delete = request_mentions(&request, &["sil", "delete", "remove", "kaldır"]);
    let create = request_mentions(
        &request,
        &[
            "oluştur",
            "yarat",
            "create",
            "new file",
            "yeni dosya",
            "klasör aç",
        ],
    );
    let edit = request_mentions(
        &request,
        &[
            "kod",
            "code",
            "düzelt",
            "fix",
            "değiştir",
            "edit",
            "uygula",
            "implement",
            "refactor",
            "tasarım",
            "ui",
            "uygulama",
            "app",
            "proje",
            "project",
        ],
    );
    let inspect = request_mentions(
        &request,
        &[
            "dosya", "file", "klasör", "folder", "oku", "read", "liste", "list", "ara ", "search",
            "incele", "bak ", "analyze", "masaüst", "desktop", "path",
        ],
    );

    if web {
        add(&["web_fetch", "browser_automation"]);
    }
    if github {
        add(&["github_action", "execute_command", "read_file"]);
    }
    if memory {
        add(&["manage_memory"]);
    }
    if delegation {
        add(&["spawn_sub_agent"]);
    }
    if delete {
        add(&["list_dir", "delete_file"]);
    } else if create {
        add(&["list_dir", "read_file", "write_file", "create_dir"]);
    } else if edit {
        add(&[
            "read_file",
            "search_code",
            "edit_file",
            "execute_command",
            "list_dir",
        ]);
    } else if inspect {
        add(&[
            "read_file",
            "list_dir",
            "search_code",
            "glob_files",
            "analyze_codebase",
        ]);
    }
    if command {
        add(&["execute_command", "read_file"]);
    }
    if process {
        add(&["manage_background_process", "execute_command"]);
    }

    selected
}

fn native_tools_for(provider: &str, messages: &[NativeMessage]) -> serde_json::Value {
    const CORE_TOOLS: &[&str] = &[
        "read_file",
        "list_dir",
        "search_code",
        "glob_files",
        "write_file",
        "edit_file",
        "apply_diff",
        "create_dir",
        "delete_file",
        "execute_command",
        "manage_background_process",
        "analyze_codebase",
    ];
    let request = last_user_request(messages);
    let mut selected: std::collections::HashSet<&str> = if provider == "groq" {
        groq_tool_names(messages).into_iter().collect()
    } else {
        CORE_TOOLS.iter().copied().collect()
    };
    let explicit_plan = request_mentions(
        &request,
        &[
            "plan",
            "roadmap",
            "yol haritas",
            "mimari",
            "architecture",
            "refactor",
            "implement",
            "uygula",
            "yeniden",
            "phase",
            "faz ",
            "multiple",
            "several",
        ],
    );
    let forced_plan_mode = messages.iter().any(|message| {
        message.role == "system"
            && message
                .content
                .as_deref()
                .is_some_and(|content| content.contains("Current composer mode: PLAN"))
    });
    if provider != "groq" || explicit_plan || forced_plan_mode {
        if provider == "groq" && selected.len() >= 5 {
            for optional in ["list_dir", "analyze_codebase", "glob_files"] {
                if selected.remove(optional) {
                    break;
                }
            }
        }
        selected.insert("enter_plan_mode");
    }
    let mentions = |words: &[&str]| request_mentions(&request, words);

    if mentions(&[
        "web",
        "internet",
        "site",
        "url",
        "http",
        "araştır",
        "güncel",
    ]) {
        selected.extend(["web_fetch", "browser_automation"]);
    }
    if mentions(&["github", "git ", "commit", "pull request", "repo", "issue"]) {
        selected.insert("github_action");
    }
    if mentions(&["hafıza", "memory", "hatırla"]) {
        selected.insert("manage_memory");
    }
    if mentions(&[
        "alt ajan",
        "sub-agent",
        "sub agent",
        "delege",
        "paralel ajan",
    ]) {
        selected.insert("spawn_sub_agent");
    }

    serde_json::Value::Array(
        native_tools()
            .as_array()
            .into_iter()
            .flatten()
            .filter(|tool| {
                tool.pointer("/function/name")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|name| selected.contains(name))
            })
            .cloned()
            .collect(),
    )
}

fn effective_max_output_tokens(provider: &str, configured: Option<u64>) -> u64 {
    let requested = configured.unwrap_or(4096).clamp(256, 16384);
    if provider == "groq" {
        // Leaves enough of the common 8K TPM free-tier bucket for prompt tokens
        // and a second interactive turn instead of reserving 4K+ every request.
        requested.min(1536)
    } else {
        requested
    }
}

fn attach_openai_tools(payload: &mut serde_json::Value, tools: serde_json::Value) {
    if tools.as_array().is_some_and(|items| !items.is_empty()) {
        payload["tools"] = tools;
        payload["tool_choice"] = serde_json::json!("auto");
    }
}

/// Sends a blocking LLM request through the active provider protocol.
/// Maps common 429/404/503 responses to safe, actionable errors.
fn redact_sensitive(input: &str) -> String {
    let mut output = input.to_string();
    for prefix in [
        "Bearer ", "?key=", "&key=", "sk-ant-", "sk-", "gsk_", "AIza", "nvapi-", "api_key=",
        "apiKey=",
    ] {
        let mut search_from = 0;
        while let Some(relative) = output[search_from..].find(prefix) {
            let start = search_from + relative + prefix.len();
            let end = output[start..]
                .char_indices()
                .find_map(|(offset, ch)| {
                    (ch.is_whitespace() || matches!(ch, '&' | '"' | '\'' | ',' | '}' | ']'))
                        .then_some(start + offset)
                })
                .unwrap_or(output.len());
            if end > start {
                output.replace_range(start..end, "***");
            }
            search_from = (start + 3).min(output.len());
        }
    }
    output
}

fn parse_error_response(response: ureq::Response) -> (Option<String>, Option<String>) {
    let header = response
        .header("retry-after")
        .or_else(|| response.header("x-ratelimit-reset"))
        .map(str::to_string);
    let body: Option<serde_json::Value> = response.into_json().ok();

    let retry_delay = header.or_else(|| {
        let b = body.as_ref()?;
        b.pointer("/error/details")
            .and_then(serde_json::Value::as_array)?
            .iter()
            .find_map(|detail| {
                let kind = detail
                    .get("@type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default();
                kind.ends_with("RetryInfo")
                    .then(|| {
                        detail
                            .get("retryDelay")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                    })
                    .flatten()
            })
    });

    let message = body.and_then(|b| {
        b.pointer("/error/message")
            .or_else(|| b.pointer("/message"))
            .or_else(|| b.pointer("/error"))
            .and_then(serde_json::Value::as_str)
            .map(|s| redact_sensitive(s).trim().to_string())
            .filter(|s| !s.is_empty())
    });

    (retry_delay, message)
}

fn safe_retry_hint(value: Option<String>) -> Option<String> {
    value.map(|raw| {
        redact_sensitive(&raw)
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | ':' | '-' | ' '))
            .take(48)
            .collect::<String>()
    })
}

fn map_ureq_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let (retry_after_raw, error_msg) = parse_error_response(resp);
            let retry_after = safe_retry_hint(retry_after_raw);
            if let Some(msg) = error_msg {
                return msg;
            }
            match code {
                400 => {
                    "Invalid request (400) — check the model, endpoint, or protocol settings"
                        .to_string()
                }
                402 => "Insufficient credit (402) — check the provider balance or spending limit"
                    .to_string(),
                429 => retry_after
                    .map(|delay| format!("Rate limit (429) — try again after {delay}"))
                    .unwrap_or_else(|| {
                        "Rate limit (429) — wait for the quota window to refresh".to_string()
                    }),
                503 => retry_after
                    .map(|delay| format!("Server overloaded (503) — try again after {delay}"))
                    .unwrap_or_else(|| {
                        "Server overloaded (503) — wait briefly and try again".to_string()
                    }),
                404 => {
                    "Not found (404) — the model may be invalid; choose another with /model".to_string()
                }
                401 | 403 => "Authorization denied — the API key may be invalid".to_string(),
                405 => {
                    "Endpoint not allowed (405) — check the Custom Server endpoint setting"
                        .to_string()
                }
                408 => "Provider request timed out (408)".to_string(),
                409 => "Provider request conflicted with the current state (409) — try again shortly"
                    .to_string(),
                413 => "Provider request is too large (413) — reduce the context with /compact"
                    .to_string(),
                422 => "Provider rejected the request (422) — check payload/protocol compatibility"
                    .to_string(),
                498 => "Provider capacity is full (498) — try again shortly"
                    .to_string(),
                502 => "Provider upstream/model error (502) — the model or provider is temporarily unavailable"
                    .to_string(),
                529 => "Provider overloaded (529) — try again shortly".to_string(),
                500..=599 => format!("Provider server error ({})", code),
                _ => format!("Provider HTTP error ({})", code),
            }
        }
        ureq::Error::Transport(t) => {
            format!("Connection error: {}", redact_sensitive(&t.to_string()))
        }
    }
}

/// Never retries 429 because retrying consumes the same quota window twice.
/// Retries one 503 response after three seconds.
fn send_with_retry<F>(build: F, body: &str) -> Result<ureq::Response, String>
where
    F: Fn() -> Result<ureq::Request, String>,
{
    let send = |body: &str| -> Result<ureq::Response, String> {
        build()?.send_string(body).map_err(map_ureq_err)
    };
    match send(body) {
        Err(message) if message.starts_with("Rate limit") => Err(message),
        Err(message) if message.starts_with("Server overloaded") => {
            std::thread::sleep(std::time::Duration::from_secs(3));
            send(body)
        }
        other => other,
    }
}

/// Never retries 429; retries one 503 response after three seconds.
fn call_with_retry<F>(build: F) -> Result<ureq::Response, String>
where
    F: Fn() -> Result<ureq::Request, String>,
{
    let call = || -> Result<ureq::Response, String> {
        let req = build()?;
        req.call().map_err(map_ureq_err)
    };
    match call() {
        Err(e) if e.starts_with("Rate limit") => Err(e),
        Err(e) if e.starts_with("Server overloaded") => {
            std::thread::sleep(std::time::Duration::from_secs(3));
            call()
        }
        other => other,
    }
}

/// Blocking chat path shared by normal completion and delegated agents.
/// Converts history to the OpenAI-compatible message shape.
fn openai_messages(provider: &str, messages: &[NativeMessage]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| match m.role.as_str() {
            "tool" => serde_json::json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content.clone().unwrap_or_default()
            }),
            "assistant" => {
                if let Some(tcs) = &m.tool_calls {
                    let mut message = serde_json::json!({
                        "role": "assistant",
                        "content": m.content.clone().unwrap_or_default(),
                        "tool_calls": tcs.iter().map(|tc| serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".into())
                            }
                        })).collect::<Vec<_>>()
                    });
                    if matches!(provider, "deepseek" | "fireworks") {
                        if let Some(reasoning) = &m.reasoning_content {
                            message["reasoning_content"] = serde_json::Value::String(reasoning.clone());
                        }
                    }
                    message
                } else {
                    serde_json::json!({
                        "role": "assistant",
                        "content": m.content.clone().unwrap_or_default()
                    })
                }
            }
            _ if m.role == "user" && !m.attachments.is_empty() => {
                let mut content = vec![serde_json::json!({
                    "type": "text",
                    "text": m.content.clone().unwrap_or_default()
                })];
                for attachment in &m.attachments {
                    match attachment.kind.as_str() {
                        "text" => content.push(serde_json::json!({
                            "type": "text",
                            "text": format!(
                                "\n\n--- attached file: {} ---\n{}\n--- end file ---",
                                attachment.name,
                                attachment.text.as_deref().unwrap_or_default()
                            )
                        })),
                        "image" => content.push(serde_json::json!({
                            "type": "image_url",
                            "image_url": {"url": attachment.data_url.as_deref().unwrap_or_default()}
                        })),
                        _ => {}
                    }
                }
                serde_json::json!({"role": "user", "content": content})
            }
            _ => serde_json::json!({
                "role": m.role,
                "content": m.content.clone().unwrap_or_default()
            }),
        })
        .collect()
}

/// Converts history to Gemini content and maps tool-call IDs back to names.
fn gemini_contents(messages: &[NativeMessage]) -> Vec<serde_json::Value> {
    // Build the tool-call ID to name map from assistant tool calls.
    let mut id_to_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for m in messages {
        if m.role == "assistant" {
            if let Some(tcs) = &m.tool_calls {
                for tc in tcs {
                    id_to_name.insert(tc.id.clone(), tc.name.clone());
                }
            }
        }
    }

    let mut out: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => {} // Sent separately as system_instruction.
            "tool" => {
                let name = m
                    .tool_call_id
                    .as_ref()
                    .and_then(|id| id_to_name.get(id))
                    .cloned()
                    .unwrap_or_else(|| "tool".to_string());
                out.push(serde_json::json!({
                    "role": "user",
                    "parts": [{"functionResponse": {"name": name, "response": {"result": m.content.clone().unwrap_or_default()}}}]
                }));
            }
            "assistant" => {
                let mut parts = Vec::new();
                if let Some(t) = &m.content {
                    if !t.is_empty() {
                        parts.push(serde_json::json!({"text": t}));
                    }
                }
                if let Some(tcs) = &m.tool_calls {
                    for tc in tcs {
                        // Gemini 3.x keeps the call ID and thought signature at part level.
                        let mut fc = serde_json::json!({
                            "functionCall": {"name": tc.name, "args": tc.arguments, "id": tc.id}
                        });
                        if let Some(sig) = &tc.thought_signature {
                            fc["thoughtSignature"] = serde_json::Value::String(sig.clone());
                        }
                        parts.push(fc);
                    }
                }
                out.push(serde_json::json!({"role": "model", "parts": parts}));
            }
            _ => {
                let mut parts =
                    vec![serde_json::json!({"text": m.content.clone().unwrap_or_default()})];
                for attachment in &m.attachments {
                    if attachment.kind == "text" {
                        parts.push(serde_json::json!({
                            "text": format!(
                                "\n\n--- attached file: {} ---\n{}\n--- end file ---",
                                attachment.name,
                                attachment.text.as_deref().unwrap_or_default()
                            )
                        }));
                    } else if let Some((_, data)) =
                        attachment.data_url.as_deref().and_then(split_data_url)
                    {
                        parts.push(serde_json::json!({
                            "inlineData": {"mimeType": attachment.mime_type, "data": data}
                        }));
                    }
                }
                out.push(serde_json::json!({"role": "user", "parts": parts}));
            }
        }
    }
    out
}

/// Converts history to Anthropic messages.
fn anthropic_messages(messages: &[NativeMessage]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => {} // Sent separately in the system field.
            "tool" => {
                out.push(serde_json::json!({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": m.tool_call_id.clone().unwrap_or_default(), "content": m.content.clone().unwrap_or_default()}]
                }));
            }
            "assistant" => {
                let mut content = Vec::new();
                if let (Some(thinking), Some(signature)) =
                    (&m.reasoning_content, &m.thinking_signature)
                {
                    if !thinking.is_empty() && !signature.is_empty() {
                        content.push(serde_json::json!({
                            "type": "thinking",
                            "thinking": thinking,
                            "signature": signature
                        }));
                    }
                }
                if let Some(t) = &m.content {
                    if !t.is_empty() {
                        content.push(serde_json::json!({"type": "text", "text": t}));
                    }
                }
                if let Some(tcs) = &m.tool_calls {
                    for tc in tcs {
                        content.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name,
                            "input": tc.arguments
                        }));
                    }
                }
                out.push(serde_json::json!({"role": "assistant", "content": content}));
            }
            _ => {
                if m.attachments.is_empty() {
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": m.content.clone().unwrap_or_default()
                    }));
                } else {
                    let mut content = vec![serde_json::json!({
                        "type": "text",
                        "text": m.content.clone().unwrap_or_default()
                    })];
                    for attachment in &m.attachments {
                        if attachment.kind == "text" {
                            content.push(serde_json::json!({
                                "type": "text",
                                "text": format!(
                                    "\n\n--- attached file: {} ---\n{}\n--- end file ---",
                                    attachment.name,
                                    attachment.text.as_deref().unwrap_or_default()
                                )
                            }));
                        } else if let Some((_, data)) =
                            attachment.data_url.as_deref().and_then(split_data_url)
                        {
                            let block_type = if attachment.kind == "document" {
                                "document"
                            } else {
                                "image"
                            };
                            content.push(serde_json::json!({
                                "type": block_type,
                                "source": {
                                    "type": "base64",
                                    "media_type": attachment.mime_type,
                                    "data": data
                                }
                            }));
                        }
                    }
                    out.push(serde_json::json!({"role": "user", "content": content}));
                }
            }
        }
    }
    out
}

fn apply_thinking_params(
    protocol: providers::ProviderProtocol,
    provider: &str,
    config: &AppConfig,
    payload: &mut serde_json::Value,
) {
    let mode = config
        .thinking_mode
        .as_deref()
        .unwrap_or("off")
        .trim()
        .to_ascii_lowercase();

    match protocol {
        providers::ProviderProtocol::AnthropicMessages => {
            if !matches!(mode.as_str(), "off" | "none" | "disabled" | "standard") {
                let budget =
                    config
                        .thinking_budget
                        .unwrap_or(if mode == "deep" || mode == "high" {
                            8192
                        } else {
                            2048
                        });
                payload["thinking"] = serde_json::json!({
                    "type": "enabled",
                    "budget_tokens": budget
                });
                let max_tokens = payload
                    .get("max_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(8192);
                if max_tokens <= budget {
                    payload["max_tokens"] = serde_json::json!(budget + 4096);
                }
            } else {
                payload["thinking"] = serde_json::json!({"type": "disabled"});
            }
        }
        providers::ProviderProtocol::GeminiGenerateContent => {
            let budget = config
                .thinking_budget
                .map(|value| value as i64)
                .unwrap_or_else(|| {
                    mode.parse::<i64>().unwrap_or(match mode.as_str() {
                        "deep" | "high" | "xhigh" => 8192,
                        "balanced" | "medium" => 2048,
                        "fast" | "low" | "minimal" => 1024,
                        _ => 0,
                    })
                });
            if payload.get("generationConfig").is_none() {
                payload["generationConfig"] = serde_json::json!({});
            }
            payload["generationConfig"]["thinkingConfig"] =
                serde_json::json!({ "thinkingBudget": budget });
        }
        providers::ProviderProtocol::OpenAiChat => {
            if provider == "groq" {
                let model = config.model.to_ascii_lowercase();
                let effort = if model.contains("qwen3") {
                    Some(
                        if matches!(mode.as_str(), "off" | "none" | "disabled" | "standard") {
                            "none"
                        } else {
                            "default"
                        },
                    )
                } else if model.contains("gpt-oss") {
                    Some(match mode.as_str() {
                        "deep" | "high" | "xhigh" => "high",
                        "balanced" | "medium" => "medium",
                        _ => "low",
                    })
                } else {
                    None
                };
                if let Some(effort) = effort {
                    payload["reasoning_effort"] = serde_json::json!(effort);
                    let has_tools = payload
                        .get("tools")
                        .and_then(serde_json::Value::as_array)
                        .is_some_and(|tools| !tools.is_empty());
                    if has_tools && effort != "none" {
                        payload["reasoning_format"] = serde_json::json!("parsed");
                    }
                }
            } else {
                let effort = match mode.as_str() {
                    "deep" => "high",
                    "balanced" => "medium",
                    "fast" => "low",
                    other => other,
                };
                if !matches!(effort, "off" | "standard" | "disabled")
                    && (provider == "openai"
                        || provider == "openrouter"
                        || provider == "together"
                        || provider == "deepseek")
                {
                    payload["reasoning_effort"] = serde_json::json!(effort);
                }
            }
        }
    }
}

/// Blocking chat path shared by normal completion and delegated agents.
fn chat_blocking(config: &AppConfig, messages: &[NativeMessage]) -> Result<ChatResult, String> {
    let provider = config.provider.as_str();
    let protocol = providers::effective_protocol(provider, config.protocol.as_deref());
    validate_native_messages(protocol, messages)?;
    let timeout = request_timeout(config, 45);
    let secret = resolve_secret(config)?;
    let tools = native_tools_for(provider, messages);

    // Separate the system prompt for protocols that use a dedicated field.
    let system_text: String = messages
        .iter()
        .filter(|m| m.role == "system")
        .filter_map(|m| m.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let non_system: Vec<NativeMessage> = messages
        .iter()
        .filter(|m| m.role != "system")
        .cloned()
        .collect();

    let max_out = effective_max_output_tokens(provider, config.max_output_tokens);
    let mut payload = match protocol {
        providers::ProviderProtocol::AnthropicMessages => serde_json::json!({
            "model": config.model,
            "max_tokens": max_out,
            "system": system_text,
            "tools": tools.as_array().unwrap_or(&Vec::new()).iter().map(|t| serde_json::json!({
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "input_schema": t["function"]["parameters"]
            })).collect::<Vec<_>>(),
            "messages": anthropic_messages(&non_system)
        }),
        providers::ProviderProtocol::GeminiGenerateContent => serde_json::json!({
            "contents": gemini_contents(&non_system),
            "system_instruction": {"parts": [{"text": system_text}]},
            "generationConfig": {"maxOutputTokens": max_out},
            "tools": {"functionDeclarations": tools.as_array().unwrap_or(&Vec::new()).iter().map(|t| serde_json::json!({
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "parameters": t["function"]["parameters"]
            })).collect::<Vec<_>>()}
        }),
        providers::ProviderProtocol::OpenAiChat => {
            let mut p = serde_json::json!({
                "model": config.model,
                // OpenAI-compatible providers receive the complete message list.
                "messages": openai_messages(provider, messages)
            });
            attach_openai_tools(&mut p, tools);
            if provider == "openai" || provider == "groq" {
                p["max_completion_tokens"] = serde_json::json!(max_out);
                if provider == "openai" {
                    p["store"] = serde_json::json!(false);
                }
            } else {
                p["max_tokens"] = serde_json::json!(max_out);
            }
            p
        }
    };
    apply_thinking_params(protocol, provider, config, &mut payload);
    let body = payload.to_string();

    let build = || {
        providers::chat_request(
            provider,
            &config.base_url,
            &secret.api_key,
            &config.model,
            config.protocol.as_deref(),
            config.auth_scheme.as_deref(),
            config.chat_path.as_deref(),
            &secret.headers,
            timeout,
            config.allow_local_network,
        )
    };

    let resp = send_with_retry(build, &body)?;
    let rate_limits = rate_limits_from_response(&resp);
    let out: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;

    // Parse response text and tool calls.
    let mut text = String::new();
    let mut tool_calls: Vec<ToolCallData> = Vec::new();
    let mut reasoning = None;
    let mut usage = TokenUsage::default();
    let model = out
        .get("model")
        .or_else(|| out.get("modelVersion"))
        .and_then(|value| value.as_str())
        .map(String::from);
    let finish_reason;

    match protocol {
        providers::ProviderProtocol::AnthropicMessages => {
            if let Some(content) = out.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                    if let Some(tu) = block.get("type").and_then(|v| v.as_str()) {
                        if tu == "tool_use" {
                            tool_calls.push(ToolCallData {
                                id: block
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                name: block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                arguments: block
                                    .get("input")
                                    .cloned()
                                    .unwrap_or(serde_json::json!({})),
                                thought_signature: None,
                            });
                        }
                    }
                }
            }
            usage.input_tokens = out
                .pointer("/usage/input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.output_tokens = out
                .pointer("/usage/output_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.cached_tokens = out
                .pointer("/usage/cache_read_input_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.total_tokens = usage.input_tokens.saturating_add(usage.output_tokens);
            finish_reason = out
                .get("stop_reason")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
        providers::ProviderProtocol::GeminiGenerateContent => {
            if let Some(parts) = out
                .pointer("/candidates/0/content/parts")
                .and_then(|p| p.as_array())
            {
                for part in parts {
                    if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                    if let Some(fc) = part.get("functionCall") {
                        // D?KKAT: thoughtSignature functionCall'?n ???NDE de?il ?
                        // part seviyesinde (functionCall ile ayn? hizada)
                        tool_calls.push(ToolCallData {
                            id: fc
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            name: fc
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            arguments: fc.get("args").cloned().unwrap_or(serde_json::json!({})),
                            thought_signature: part
                                .get("thoughtSignature")
                                .and_then(|v| v.as_str())
                                .map(String::from),
                        });
                    }
                }
            }
            usage.input_tokens = out
                .pointer("/usageMetadata/promptTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.output_tokens = out
                .pointer("/usageMetadata/candidatesTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.reasoning_tokens = out
                .pointer("/usageMetadata/thoughtsTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.cached_tokens = out
                .pointer("/usageMetadata/cachedContentTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.total_tokens = out
                .pointer("/usageMetadata/totalTokenCount")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| {
                    usage
                        .input_tokens
                        .saturating_add(usage.output_tokens)
                        .saturating_add(usage.reasoning_tokens)
                });
            finish_reason = out
                .pointer("/candidates/0/finishReason")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
        providers::ProviderProtocol::OpenAiChat => {
            if let Some(msg) = out.pointer("/choices/0/message") {
                if let Some(t) = msg.get("content").and_then(|v| v.as_str()) {
                    text.push_str(t);
                }
                if let Some(tcs) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                    for tc in tcs {
                        let name = tc
                            .pointer("/function/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let args_str = tc
                            .pointer("/function/arguments")
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let arguments = serde_json::from_str(args_str)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        tool_calls.push(ToolCallData {
                            id: tc
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            name,
                            arguments,
                            thought_signature: None,
                        });
                    }
                }
                reasoning = msg
                    .get("reasoning_content")
                    .or_else(|| msg.get("reasoning"))
                    .and_then(|value| value.as_str())
                    .map(String::from);
            }
            usage.input_tokens = out
                .pointer("/usage/prompt_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.output_tokens = out
                .pointer("/usage/completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.reasoning_tokens = out
                .pointer("/usage/completion_tokens_details/reasoning_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.cached_tokens = out
                .pointer("/usage/prompt_tokens_details/cached_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            usage.total_tokens = out
                .pointer("/usage/total_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| usage.input_tokens.saturating_add(usage.output_tokens));
            finish_reason = out
                .pointer("/choices/0/finish_reason")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
    }

    Ok(ChatResult {
        text,
        tool_calls,
        reasoning,
        thinking_signature: None,
        usage,
        model,
        finish_reason,
        rate_limits,
    })
}

/// Keeps long blocking provider calls off the UI thread.
#[tauri::command]
async fn chat_completion(
    config: AppConfig,
    messages: Vec<NativeMessage>,
) -> Result<ChatResult, String> {
    tauri::async_runtime::spawn_blocking(move || chat_blocking(&config, &messages))
        .await
        .map_err(|e| format!("Worker thread error: {}", e))?
}

fn clean_session_title(raw: &str, fallback: &str) -> String {
    let first_line = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let cleaned = first_line
        .trim_matches(|ch: char| {
            ch.is_whitespace() || matches!(ch, '"' | '\'' | '`' | '#' | '*' | '-' | '—' | ':' | '.')
        })
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title: String = cleaned.chars().take(64).collect();
    if title.is_empty() {
        fallback.chars().take(64).collect()
    } else {
        title
    }
}

fn session_title_blocking(
    config: &AppConfig,
    user_message: &str,
    assistant_text: &str,
) -> Result<String, String> {
    let provider = config.provider.as_str();
    let protocol = providers::effective_protocol(provider, config.protocol.as_deref());
    let secret = resolve_secret(config)?;
    let timeout = request_timeout(config, 30);
    let user_excerpt: String = user_message.chars().take(800).collect();
    let assistant_excerpt: String = assistant_text.chars().take(800).collect();
    let instruction = "Write a short, distinctive title for this conversation. Use the user's language. Use 3–7 words. Return only the title, without quotes, Markdown, emoji, or punctuation.";
    let content = format!(
        "User request:\n{}\n\nResponse summary:\n{}",
        user_excerpt, assistant_excerpt
    );
    let body = match protocol {
        providers::ProviderProtocol::AnthropicMessages => serde_json::json!({
            "model": config.model,
            "max_tokens": 64,
            "system": instruction,
            "messages": [{"role":"user", "content": content}]
        })
        .to_string(),
        providers::ProviderProtocol::GeminiGenerateContent => serde_json::json!({
            "contents": [{"role":"user", "parts":[{"text":content}]}],
            "system_instruction": {"parts":[{"text":instruction}]},
            "generationConfig": {"maxOutputTokens":64}
        })
        .to_string(),
        providers::ProviderProtocol::OpenAiChat => {
            let mut payload = serde_json::json!({
                "model": config.model,
                "messages": [
                    {"role":"system", "content":instruction},
                    {"role":"user", "content":content}
                ]
            });
            if provider == "openai" {
                payload["max_completion_tokens"] = serde_json::json!(64);
                payload["store"] = serde_json::json!(false);
            } else {
                payload["max_tokens"] = serde_json::json!(64);
            }
            payload.to_string()
        }
    };
    let build = || {
        providers::chat_request(
            provider,
            &config.base_url,
            &secret.api_key,
            &config.model,
            config.protocol.as_deref(),
            config.auth_scheme.as_deref(),
            config.chat_path.as_deref(),
            &secret.headers,
            timeout,
            config.allow_local_network,
        )
    };
    let output: serde_json::Value = send_with_retry(build, &body)?
        .into_json()
        .map_err(|error| format!("Could not read title response: {error}"))?;
    let raw = match protocol {
        providers::ProviderProtocol::AnthropicMessages => output
            .pointer("/content/0/text")
            .and_then(serde_json::Value::as_str),
        providers::ProviderProtocol::GeminiGenerateContent => output
            .pointer("/candidates/0/content/parts/0/text")
            .and_then(serde_json::Value::as_str),
        providers::ProviderProtocol::OpenAiChat => output
            .pointer("/choices/0/message/content")
            .and_then(serde_json::Value::as_str),
    }
    .unwrap_or_default();
    Ok(clean_session_title(raw, &user_excerpt))
}

#[tauri::command]
async fn generate_session_title(
    config: AppConfig,
    user_message: String,
    assistant_text: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        session_title_blocking(&config, &user_message, &assistant_text)
    })
    .await
    .map_err(|error| format!("Title worker error: {error}"))?
}

fn stream_body(config: &AppConfig, messages: &[NativeMessage]) -> String {
    let provider = config.provider.as_str();
    let protocol = providers::effective_protocol(provider, config.protocol.as_deref());
    let tools = native_tools_for(provider, messages);
    let system_text = messages
        .iter()
        .filter(|message| message.role == "system")
        .filter_map(|message| message.content.clone())
        .collect::<Vec<_>>()
        .join("\n");
    let non_system = messages
        .iter()
        .filter(|message| message.role != "system")
        .cloned()
        .collect::<Vec<_>>();
    let max_out = effective_max_output_tokens(provider, config.max_output_tokens);
    let mut payload = match protocol {
        providers::ProviderProtocol::AnthropicMessages => serde_json::json!({
            "model": config.model,
            "max_tokens": max_out,
            "stream": true,
            "system": system_text,
            "tools": tools.as_array().unwrap_or(&Vec::new()).iter().map(|tool| serde_json::json!({
                "name": tool["function"]["name"],
                "description": tool["function"]["description"],
                "input_schema": tool["function"]["parameters"]
            })).collect::<Vec<_>>(),
            "messages": anthropic_messages(&non_system)
        }),
        providers::ProviderProtocol::GeminiGenerateContent => serde_json::json!({
            "contents": gemini_contents(&non_system),
            "system_instruction": {"parts": [{"text": system_text}]},
            "generationConfig": {"maxOutputTokens": max_out},
            "tools": {"functionDeclarations": tools.as_array().unwrap_or(&Vec::new()).iter().map(|tool| serde_json::json!({
                "name": tool["function"]["name"],
                "description": tool["function"]["description"],
                "parameters": tool["function"]["parameters"]
            })).collect::<Vec<_>>()}
        }),
        providers::ProviderProtocol::OpenAiChat => {
            let mut p = serde_json::json!({
                "model": config.model,
                "stream": true,
                "messages": openai_messages(provider, messages)
            });
            attach_openai_tools(&mut p, tools);
            if provider == "openai" || provider == "groq" {
                p["max_completion_tokens"] = serde_json::json!(max_out);
                if provider == "openai" {
                    p["store"] = serde_json::json!(false);
                    p["stream_options"] = serde_json::json!({"include_usage": true});
                }
            } else {
                p["max_tokens"] = serde_json::json!(max_out);
            }
            p
        }
    };
    apply_thinking_params(protocol, provider, config, &mut payload);
    payload.to_string()
}

#[tauri::command]
async fn chat_completion_stream(
    config: AppConfig,
    messages: Vec<NativeMessage>,
    request_id: String,
    on_event: tauri::ipc::Channel<streaming::StreamEvent>,
    manager: tauri::State<'_, streaming::StreamManager>,
) -> Result<ChatResult, String> {
    let cancelled = manager.register(&request_id)?;
    let manager_id = request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let provider = config.provider.clone();
        let protocol = providers::effective_protocol(&provider, config.protocol.as_deref());
        validate_native_messages(protocol, &messages)?;
        let timeout = request_timeout(&config, 45);
        let secret = resolve_secret(&config)?;
        let body = stream_body(&config, &messages);
        let build = || {
            providers::chat_stream_request(
                &provider,
                &config.base_url,
                &secret.api_key,
                &config.model,
                config.protocol.as_deref(),
                config.auth_scheme.as_deref(),
                config.chat_path.as_deref(),
                &secret.headers,
                timeout,
                config.allow_local_network,
            )
        };
        let response = send_with_retry(build, &body)?;
        streaming::consume(
            response,
            protocol,
            provider,
            config.model.clone(),
            request_id,
            on_event,
            cancelled,
        )
    })
    .await
    .map_err(|error| format!("Worker thread error: {error}"))?;
    manager.finish(&manager_id);
    result
}

#[tauri::command]
fn cancel_chat_stream(
    request_id: String,
    manager: tauri::State<'_, streaming::StreamManager>,
) -> Result<bool, String> {
    manager.cancel(&request_id)
}

#[tauri::command]
fn create_session(
    app: tauri::AppHandle,
    title: String,
    provider: String,
    model: String,
    workspace: String,
) -> Result<sessions::SessionRecord, String> {
    sessions::create(&app, title, provider, model, workspace)
}

#[tauri::command]
fn save_session(
    app: tauri::AppHandle,
    session: sessions::SessionRecord,
) -> Result<sessions::SessionRecord, String> {
    sessions::save(&app, session)
}

#[tauri::command]
fn checkpoint_session(
    app: tauri::AppHandle,
    session: sessions::SessionRecord,
) -> Result<(), String> {
    sessions::checkpoint(&app, session)
}

#[tauri::command]
fn list_sessions(app: tauri::AppHandle) -> Result<Vec<sessions::SessionSummary>, String> {
    sessions::list(&app)
}

#[tauri::command]
fn load_session(app: tauri::AppHandle, id: String) -> Result<sessions::SessionRecord, String> {
    sessions::load(&app, &id)
}

#[tauri::command]
fn latest_session(app: tauri::AppHandle) -> Result<Option<sessions::SessionRecord>, String> {
    sessions::latest(&app)
}

#[tauri::command]
fn delete_session(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    sessions::delete(&app, &id)
}

// ============================================================
// FAZ 3 — PERMISSION ENGINE + TOOL REGISTRY
// ============================================================

/// Evaluates a tool call before the frontend approval surface is shown.
#[tauri::command]
fn check_tool(
    config: AppConfig,
    tool_id: String,
    params: serde_json::Value,
) -> Result<permissions::ToolCheckResult, String> {
    Ok(permissions::evaluate(
        &config.mode,
        &config.allow_list,
        &tool_id,
        &params,
    ))
}

// ---- /undo snapshots captured before file mutations ----

fn snapshot_file(path: &str) {
    let p = Path::new(&path);
    if !p.exists() || p.is_dir() {
        return;
    }
    let backup_dir = format!("{}/.agent/undo", dirs_home());
    let _ = fs::create_dir_all(&backup_dir);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let fname = p
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let backup = format!("{}/{}_{}.bak", backup_dir, ts, fname);
    if fs::copy(p, &backup).is_ok() {
        let manifest_path = format!("{}/undo_manifest.json", backup_dir);
        let mut entries: Vec<serde_json::Value> = if Path::new(&manifest_path).exists() {
            fs::read_to_string(&manifest_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        entries.push(serde_json::json!({
            "ts": ts,
            "original": expand_path(path),
            "backup": backup
        }));
        if let Ok(s) = serde_json::to_string_pretty(&entries) {
            let _ = fs::write(&manifest_path, s);
        }
    }
}

/// Restores the last file change captured for `/undo`.
#[tauri::command]
fn undo_last() -> Result<String, String> {
    let manifest_path = format!("{}/.agent/undo/undo_manifest.json", dirs_home());
    let raw = fs::read_to_string(&manifest_path).map_err(|_| "Nothing to undo".to_string())?;
    let mut entries: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let last = entries.pop().ok_or("Nothing to undo")?;
    let original = last["original"].as_str().unwrap_or("").to_string();
    let backup = last["backup"].as_str().unwrap_or("").to_string();
    if original.is_empty() || backup.is_empty() {
        return Err("Snapshot record is corrupted".into());
    }
    fs::copy(&backup, &original).map_err(|e| format!("Could not undo: {}", e))?;
    let _ = fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&entries).unwrap_or_default(),
    );
    Ok(format!("Undone: {}", original))
}

// ---- Tool implementations ----

fn tool_write_file(path: &str, content: &str) -> Result<String, String> {
    let path = expand_path(path);
    snapshot_file(&path);
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| format!("Could not write {}: {}", path, e))?;
    Ok(format!("Wrote {} ({} bytes)", path, content.len()))
}

fn tool_edit_file(path: &str, old: &str, new: &str) -> Result<String, String> {
    let path = expand_path(path);
    snapshot_file(&path);
    let content =
        fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {}", path, e))?;
    if !content.contains(old) {
        return Err(format!("Search text was not found in {}", path));
    }
    let updated = content.replacen(old, new, 1);
    fs::write(&path, updated).map_err(|e| format!("Could not write {}: {}", path, e))?;
    Ok(format!("Edited {}", path))
}

fn tool_create_dir(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    fs::create_dir_all(&path).map_err(|e| format!("Could not create {}: {}", path, e))?;
    Ok(format!("Created {}", path))
}

fn tool_delete_file(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    let p = Path::new(&path);
    snapshot_file(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())?;
        Ok(format!("Deleted folder {}", path))
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())?;
        Ok(format!("Deleted {}", path))
    }
}

fn tool_search_code(path: &str, pattern: &str) -> Result<serde_json::Value, String> {
    let path = expand_path(path);
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Directory not found: {}", path));
    }

    let mut results: Vec<serde_json::Value> = Vec::new();
    let max_results = 30;
    let mut count = 0;

    fn walk(
        dir: &Path,
        pattern: &str,
        results: &mut Vec<serde_json::Value>,
        max: usize,
        count: &mut usize,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in entries {
            if *count >= max {
                return Ok(());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                // node_modules ve .git atla
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "node_modules" || name == ".git" || name == "target" {
                    continue;
                }
                walk(&path, pattern, results, max, count)?;
            } else {
                // Inspect text files only.
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                for (idx, line) in content.lines().enumerate() {
                    if line.contains(pattern) {
                        results.push(serde_json::json!({
                            "file": path.display().to_string(),
                            "line": idx + 1,
                            "text": line.trim().chars().take(200).collect::<String>(),
                        }));
                        *count += 1;
                        if *count >= max {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    walk(root, pattern, &mut results, max_results, &mut count)?;
    Ok(serde_json::json!({ "matches": results, "total_shown": results.len() }))
}

// ============================================================
// Extended tool ecosystem
// ============================================================

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::{Arc, Mutex as StdMutex};

/// Small glob matcher supporting `*`, `**`, and `?`.
fn glob_match(pattern: &str, path: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = path.chars().collect();
    fn rec(p: &[char], s: &[char]) -> bool {
        if p.is_empty() {
            return s.is_empty();
        }
        match p[0] {
            '*' => {
                if p.len() > 1 && p[1] == '*' {
                    rec(&p[2..], s) || (!s.is_empty() && rec(p, &s[1..]))
                } else {
                    rec(&p[1..], s) || (!s.is_empty() && rec(p, &s[1..]))
                }
            }
            '?' => !s.is_empty() && rec(&p[1..], &s[1..]),
            c => !s.is_empty() && s[0] == c && rec(&p[1..], &s[1..]),
        }
    }
    rec(&p, &s)
}

/// Finds files by glob while skipping node_modules, .git, and target.
fn tool_glob_files(pattern: &str) -> Result<Vec<String>, String> {
    // Use the first directory segment in the pattern as the search root.
    let (root, pat) = if pattern.contains('/') || pattern.contains('\\') {
        let sep = if pattern.contains('\\') { '\\' } else { '/' };
        let idx = pattern.find(sep).unwrap();
        let root = &pattern[..idx];
        let pat = &pattern[idx + 1..];
        (
            if root.is_empty() {
                ".".to_string()
            } else {
                root.to_string()
            },
            pat.to_string(),
        )
    } else {
        (".".to_string(), pattern.to_string())
    };

    let mut results = Vec::new();
    fn walk(
        dir: &Path,
        rel: &str,
        pat: &str,
        results: &mut Vec<String>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 10 {
            return Ok(());
        }
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name == "node_modules" || name == ".git" || name == "target" {
                continue;
            }
            let path = entry.path();
            let rel_path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", rel, name)
            };
            if path.is_dir() {
                walk(&path, &rel_path, pat, results, depth + 1)?;
            } else if glob_match(pat, &rel_path) {
                results.push(path.display().to_string());
            }
        }
        Ok(())
    }
    walk(Path::new(&root), "", &pat, &mut results, 0)?;
    results.sort();
    Ok(results)
}

/// Small bounded HTML-to-Markdown converter.
fn html_to_markdown(html: &str) -> String {
    let mut out = String::new();
    let mut in_pre = false;
    let mut i = 0;
    let chars: Vec<char> = html.chars().collect();
    while i < chars.len() {
        if chars[i] == '<' {
            let end = chars[i..].iter().position(|&c| c == '>').map(|p| i + p + 1);
            let Some(end) = end else { break };
            let tag: String = chars[i + 1..end - 1].iter().collect();
            let tag_lower = tag.to_lowercase();
            let tname: String = tag_lower
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_start_matches('/')
                .to_string();
            match tname.as_str() {
                "h1" => out.push_str("\n\n# "),
                "h2" => out.push_str("\n\n## "),
                "h3" => out.push_str("\n\n### "),
                "p" => out.push_str("\n\n"),
                "li" => out.push_str("\n- "),
                "br" => out.push('\n'),
                "pre" => {
                    if !in_pre {
                        out.push_str("\n\n```\n");
                        in_pre = true;
                    }
                }
                "a" => {
                    if let Some(href_start) = tag_lower.find("href=\"") {
                        let href_start = href_start + 6;
                        let href_end = tag_lower[href_start..]
                            .find('"')
                            .map(|p| href_start + p)
                            .unwrap_or(tag_lower.len());
                        let href = &tag_lower[href_start..href_end];
                        out.push_str("[");
                        i = end;
                        let text_end = chars[i..]
                            .iter()
                            .position(|&c| c == '<')
                            .map(|p| i + p)
                            .unwrap_or(chars.len());
                        let text: String = chars[i..text_end].iter().collect();
                        out.push_str(&text);
                        out.push_str(&format!("]({})", href));
                        i = text_end;
                        continue;
                    }
                }
                "/a" => {}
                "/pre" => {
                    out.push_str("\n```\n");
                    in_pre = false;
                }
                "script" | "style" => {
                    // Skip tag contents.
                    if let Some(close) = html[i..].find(&format!("</{}>", tname)) {
                        i += close + tname.len() + 4;
                        continue;
                    }
                }
                _ => {}
            }
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    // Collapse repeated blank lines.
    let mut cleaned = String::new();
    let mut prev_blank = false;
    for line in out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !prev_blank {
                cleaned.push('\n');
            }
            prev_blank = true;
        } else {
            cleaned.push_str(trimmed);
            cleaned.push('\n');
            prev_blank = false;
        }
    }
    cleaned.trim().to_string()
}

/// Fetches a URL and converts its bounded content to Markdown.
fn tool_web_fetch(url: &str) -> Result<String, String> {
    let resp = ureq::get(url)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(20))
        .call()
        .map_err(map_ureq_err)?;
    let content_type = resp
        .header("content-type")
        .unwrap_or("text/html")
        .to_lowercase();
    let body = resp.into_string().map_err(|e| e.to_string())?;
    if content_type.contains("application/json") {
        Ok(body.chars().take(4000).collect())
    } else if content_type.contains("html") {
        Ok(html_to_markdown(&body).chars().take(6000).collect())
    } else {
        Ok(body.chars().take(4000).collect())
    }
}

/// apply_diff — git apply ile yama uygular
fn tool_apply_diff(path: &str, diff_content: &str) -> Result<String, String> {
    let path = expand_path(path);
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Directory not found: {}", path));
    }
    // Write the diff to a temporary file for the patch process.
    let tmp = std::env::temp_dir().join(format!("diff_{}.patch", std::process::id()));
    fs::write(&tmp, diff_content).map_err(|e| e.to_string())?;
    let output = Command::new("git")
        .current_dir(dir)
        .args(["apply", "--whitespace=nowarn"])
        .arg(&tmp)
        .output()
        .map_err(|e| format!("git was not found: {}", e))?;
    let _ = fs::remove_file(&tmp);
    if output.status.success() {
        Ok("Patch applied successfully".to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Performs a bounded grep-based codebase analysis.
fn tool_analyze_codebase(
    symbol: &str,
    kind: &str,
    path: &str,
) -> Result<serde_json::Value, String> {
    let root = expand_path(path);
    let root = Path::new(&root);
    if !root.is_dir() {
        return Err(format!("Directory not found: {}", root.display()));
    }

    let mut results: Vec<serde_json::Value> = Vec::new();
    let max = 40;

    fn walk(
        dir: &Path,
        symbol: &str,
        kind: &str,
        results: &mut Vec<serde_json::Value>,
        count: &mut usize,
        max: usize,
    ) -> Result<(), String> {
        let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
        for entry in entries {
            if *count >= max {
                return Ok(());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "node_modules" || name == ".git" || name == "target" {
                    continue;
                }
                walk(&path, symbol, kind, results, count, max)?;
            } else {
                let Ok(content) = fs::read_to_string(&path) else {
                    continue;
                };
                for (idx, line) in content.lines().enumerate() {
                    let l = line.trim_start();
                    let hit = match kind {
                        "definition" => {
                            (l.starts_with("fn ")
                                || l.starts_with("function ")
                                || l.starts_with("class ")
                                || l.starts_with("def ")
                                || l.starts_with("const ")
                                || l.starts_with("let ")
                                || l.starts_with("pub fn "))
                                && l.contains(symbol)
                        }
                        _ => l.contains(symbol),
                    };
                    if hit {
                        results.push(serde_json::json!({
                            "file": path.display().to_string(),
                            "line": idx + 1,
                            "text": line.trim().chars().take(150).collect::<String>(),
                        }));
                        *count += 1;
                        if *count >= max {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    let mut count = 0;
    if kind == "structure" {
        // Directory tree, limited to two levels.
        let mut tree: Vec<String> = Vec::new();
        fn tree_walk(dir: &Path, depth: usize, tree: &mut Vec<String>) -> Result<(), String> {
            if depth > 2 {
                return Ok(());
            }
            let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
            for entry in entries {
                let entry = entry.map_err(|e| e.to_string())?;
                let name = entry.file_name().to_string_lossy().to_string();
                if name == "node_modules" || name == ".git" || name == "target" {
                    continue;
                }
                let indent = "  ".repeat(depth);
                let suffix = if entry.path().is_dir() { "/" } else { "" };
                tree.push(format!("{}{}{}", indent, name, suffix));
                if entry.path().is_dir() {
                    tree_walk(&entry.path(), depth + 1, tree)?;
                }
            }
            Ok(())
        }
        tree_walk(root, 0, &mut tree)?;
        return Ok(serde_json::json!({ "tree": tree, "total_shown": tree.len() }));
    }

    walk(root, symbol, kind, &mut results, &mut count, max)?;
    Ok(serde_json::json!({ "matches": results, "total_shown": results.len() }))
}

/// manage_memory — ~/.agent/MEMORIES.md
fn memory_path() -> String {
    format!("{}/.agent/MEMORIES.md", dirs_home())
}

fn tool_manage_memory(action: &str, key: &str, value: &str) -> Result<String, String> {
    let path = memory_path();
    match action {
        "read" => {
            if Path::new(&path).exists() {
                Ok(fs::read_to_string(&path).map_err(|e| e.to_string())?)
            } else {
                Ok("(memory is empty)".to_string())
            }
        }
        "add" => {
            if let Some(parent) = Path::new(&path).parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut content = if Path::new(&path).exists() {
                fs::read_to_string(&path).map_err(|e| e.to_string())?
            } else {
                String::new()
            };
            if !content.ends_with('\n') && !content.is_empty() {
                content.push('\n');
            }
            content.push_str(&format!("- [{}] {}\n", key, value));
            fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(format!("Added to memory: {} → {}", key, value))
        }
        "clear" => {
            if Path::new(&path).exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Ok("Memory cleared".to_string())
        }
        _ => Err("invalid action — read / add / clear".into()),
    }
}

/// Finds the Microsoft Edge executable.
fn find_edge() -> Option<std::path::PathBuf> {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    for c in candidates {
        let p = Path::new(c);
        if p.exists() {
            return Some(p.to_path_buf());
        }
    }
    None
}

/// browser_automation — Edge headless (navigate / extract_text / take_screenshot)
fn tool_browser_automation(action: &str, url: &str, _selector: &str) -> Result<String, String> {
    let edge = find_edge().ok_or("Edge was not found")?;
    match action {
        "navigate" | "extract_text" => {
            let output = Command::new(&edge)
                .args([
                    "--headless=new",
                    "--disable-gpu",
                    "--no-first-run",
                    "--dump-dom",
                    url,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).to_string());
            }
            let dom = String::from_utf8_lossy(&output.stdout).to_string();
            let md = html_to_markdown(&dom);
            Ok(md.chars().take(6000).collect())
        }
        "take_screenshot" => {
            let out_path =
                std::env::temp_dir().join(format!("browser_shot_{}.png", std::process::id()));
            let out_str = out_path.to_string_lossy().to_string();
            let output = Command::new(&edge)
                .args([
                    "--headless=new",
                    "--disable-gpu",
                    "--no-first-run",
                    "--screenshot",
                    &out_str,
                    "--window-size=1280,800",
                    url,
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if output.status.success() && out_path.exists() {
                Ok(format!("Screenshot: {}", out_str))
            } else {
                Err("Could not capture screenshot".into())
            }
        }
        "click" | "type" => Err(format!(
            "{} is not currently supported — use navigate / extract_text / take_screenshot",
            action
        )),
        _ => Err("invalid action".into()),
    }
}

/// github_action — git + gh CLI
fn tool_github_action(action: &str, message: &str, branch: &str) -> Result<String, String> {
    match action {
        "commit" => {
            let add = Command::new("git")
                .args(["add", "-A"])
                .output()
                .map_err(|e| e.to_string())?;
            if !add.status.success() {
                return Err(String::from_utf8_lossy(&add.stderr).to_string());
            }
            let commit = Command::new("git")
                .args(["commit", "-m", message])
                .output()
                .map_err(|e| e.to_string())?;
            if commit.status.success() {
                Ok(String::from_utf8_lossy(&commit.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&commit.stderr).to_string())
            }
        }
        "create_pr" => {
            let pr = Command::new("gh")
                .args(["pr", "create", "--title", message, "--body", message])
                .output()
                .map_err(|e| format!("gh was not found: {}", e))?;
            if pr.status.success() {
                Ok(String::from_utf8_lossy(&pr.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&pr.stderr).to_string())
            }
        }
        "view_issues" => {
            let out = Command::new("gh")
                .args(["issue", "list"])
                .output()
                .map_err(|e| e.to_string())?;
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        }
        "repo_status" => {
            let status = Command::new("git")
                .args(["status", "--short"])
                .output()
                .map_err(|e| e.to_string())?;
            let mut out = String::from_utf8_lossy(&status.stdout).to_string();
            if let Ok(repo) = Command::new("gh")
                .args(["repo", "view", "--json", "nameWithOwner"])
                .output()
            {
                out.push_str(&String::from_utf8_lossy(&repo.stdout));
            }
            if branch.is_empty() {
                if let Ok(b) = Command::new("git")
                    .args(["branch", "--show-current"])
                    .output()
                {
                    out.push_str(&format!(
                        "\nbranch: {}",
                        String::from_utf8_lossy(&b.stdout).trim()
                    ));
                }
            }
            Ok(out)
        }
        _ => Err("invalid action — commit / create_pr / view_issues / repo_status".into()),
    }
}

// ---- Background process management ----
struct ManagedProcess {
    child: std::process::Child,
    log: Arc<StdMutex<Vec<String>>>,
}

#[derive(Default)]
struct ProcessManager {
    processes: Arc<StdMutex<HashMap<String, ManagedProcess>>>,
}

static PROCESS_MANAGER: std::sync::OnceLock<ProcessManager> = std::sync::OnceLock::new();

fn pm() -> &'static ProcessManager {
    PROCESS_MANAGER.get_or_init(ProcessManager::default)
}

fn tool_background_process(
    state: &ProcessManager,
    action: &str,
    command: &str,
    process_id: &str,
) -> Result<serde_json::Value, String> {
    let mut procs = state.processes.lock().map_err(|e| e.to_string())?;
    match action {
        "start" => {
            let mut child = Command::new("cmd")
                .args(["/C", command])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            let id = if process_id.is_empty() {
                format!("proc-{}", child.id())
            } else {
                process_id.to_string()
            };
            let log: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));

            // stdout log thread'i
            if let Some(out) = child.stdout.take() {
                let logc = log.clone();
                std::thread::spawn(move || {
                    let reader = BufReader::new(out);
                    for line in reader.lines().map_while(Result::ok) {
                        if let Ok(mut l) = logc.lock() {
                            l.push(line);
                            if l.len() > 500 {
                                l.remove(0);
                            }
                        }
                    }
                });
            }
            if let Some(err) = child.stderr.take() {
                let logc = log.clone();
                std::thread::spawn(move || {
                    let reader = BufReader::new(err);
                    for line in reader.lines().map_while(Result::ok) {
                        if let Ok(mut l) = logc.lock() {
                            l.push(format!("[stderr] {}", line));
                            if l.len() > 500 {
                                l.remove(0);
                            }
                        }
                    }
                });
            }

            procs.insert(id.clone(), ManagedProcess { child, log });
            Ok(serde_json::json!({ "process_id": id, "status": "started" }))
        }
        "stop" => {
            let p = procs.get_mut(process_id).ok_or("Process was not found")?;
            let _ = p.child.kill();
            Ok(serde_json::json!({ "process_id": process_id, "status": "stopped" }))
        }
        "status" => {
            let p = procs.get_mut(process_id).ok_or("Process was not found")?;
            if let Some(status) = p.child.try_wait().map_err(|e| e.to_string())? {
                Ok(
                    serde_json::json!({ "process_id": process_id, "status": "exited", "code": status.code() }),
                )
            } else {
                Ok(serde_json::json!({ "process_id": process_id, "status": "running" }))
            }
        }
        "logs" => {
            let p = procs.get(process_id).ok_or("Process was not found")?;
            let logs = p.log.lock().map_err(|e| e.to_string())?;
            Ok(
                serde_json::json!({ "logs": logs.iter().rev().take(50).cloned().collect::<Vec<_>>() }),
            )
        }
        _ => Err("invalid action — start / stop / status / logs".into()),
    }
}

/// Executes a tool after the native security policy authorizes it.
#[tauri::command]
async fn execute_approved_tool(
    config: AppConfig,
    tool_id: String,
    params: serde_json::Value,
    approved: bool,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        permissions::authorize_execution(
            &config.mode,
            &config.allow_list,
            &tool_id,
            &params,
            approved,
        )?;

        // Execute the authorized tool.
        match tool_id.as_str() {
            "read_file" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("path is required")?;
                let content = read_file_inner(path)?;
                // Support line numbers and bounded ranges.
                let start = params
                    .get("start_line")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1)
                    .max(1) as usize;
                let end = params
                    .get("end_line")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize);
                let lines: Vec<&str> = content.lines().collect();
                let total = lines.len();
                let end = end.unwrap_or(total).min(total);
                let mut numbered = String::new();
                for (i, line) in lines
                    .iter()
                    .enumerate()
                    .skip(start - 1)
                    .take(end.saturating_sub(start - 1))
                {
                    numbered.push_str(&format!("{:>5} | {}\n", i + 1, line));
                }
                Ok(serde_json::json!({
                    "content": numbered,
                    "path": expand_path(path),
                    "total_lines": total
                }))
            }
            "list_dir" => {
                let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                let entries = list_dir_inner(path)?;
                Ok(serde_json::json!({ "entries": entries }))
            }
            "search_code" => {
                let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                let pattern = params
                    .get("pattern")
                    .and_then(|v| v.as_str())
                    .ok_or("pattern is required")?;
                tool_search_code(path, pattern)
            }
            "glob_files" => {
                let pattern = params
                    .get("pattern")
                    .and_then(|v| v.as_str())
                    .ok_or("pattern is required")?;
                let files = tool_glob_files(pattern)?;
                Ok(serde_json::json!({ "files": files, "total": files.len() }))
            }
            "write_file" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("path is required")?;
                let content = params
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or("content is required")?;
                let msg = tool_write_file(path, content)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "edit_file" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("path is required")?;
                let old = params
                    .get("old_string")
                    .or_else(|| params.get("old"))
                    .and_then(|v| v.as_str())
                    .ok_or("old_string is required")?;
                let new = params
                    .get("new_string")
                    .or_else(|| params.get("new"))
                    .and_then(|v| v.as_str())
                    .ok_or("new_string is required")?;
                let msg = tool_edit_file(path, old, new)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "apply_diff" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("path is required")?;
                let diff = params
                    .get("diff_content")
                    .and_then(|v| v.as_str())
                    .ok_or("diff_content is required")?;
                let msg = tool_apply_diff(path, diff)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "create_dir" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("path is required")?;
                let msg = tool_create_dir(path)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "delete_file" => {
                let path = params
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or("path is required")?;
                let msg = tool_delete_file(path)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "execute_command" => {
                let cmd = params
                    .get("cmd")
                    .or_else(|| params.get("command"))
                    .and_then(|v| v.as_str())
                    .ok_or("cmd is required")?
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'');
                let timeout_ms = params
                    .get("timeout")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(30000);

                // Windows command execution with timeout and separate output readers.
                let mut child = Command::new("cmd")
                    .args(["/C", cmd])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("Could not run command: {}", e))?;

                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                let out_buf: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));
                let err_buf: Arc<StdMutex<String>> = Arc::new(StdMutex::new(String::new()));

                if let Some(out) = stdout {
                    let b = out_buf.clone();
                    std::thread::spawn(move || {
                        let mut s = String::new();
                        let _ = BufReader::new(out).read_to_string(&mut s);
                        if let Ok(mut sb) = b.lock() {
                            *sb = s;
                        }
                    });
                }
                if let Some(err) = stderr {
                    let b = err_buf.clone();
                    std::thread::spawn(move || {
                        let mut s = String::new();
                        let _ = BufReader::new(err).read_to_string(&mut s);
                        if let Ok(mut sb) = b.lock() {
                            *sb = s;
                        }
                    });
                }

                let start = std::time::Instant::now();
                let status = loop {
                    if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
                        break st;
                    }
                    if start.elapsed().as_millis() > timeout_ms as u128 {
                        let _ = child.kill();
                        return Err(format!("Command timed out ({}ms)", timeout_ms));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(80));
                };

                let stdout_text = out_buf.lock().map_err(|e| e.to_string())?.clone();
                let stderr_text = err_buf.lock().map_err(|e| e.to_string())?.clone();
                Ok(serde_json::json!({
                    "stdout": stdout_text,
                    "stderr": stderr_text,
                    "exit_code": status.code().unwrap_or(-1)
                }))
            }
            "manage_background_process" => {
                let action = params
                    .get("action")
                    .and_then(|v| v.as_str())
                    .ok_or("action is required")?;
                let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let process_id = params
                    .get("process_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                tool_background_process(pm(), action, command, process_id)
            }
            "web_fetch" => {
                let url = params
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or("url is required")?;
                let md = tool_web_fetch(url)?;
                Ok(serde_json::json!({ "content": md, "url": url }))
            }
            "browser_automation" => {
                let action = params
                    .get("action")
                    .and_then(|v| v.as_str())
                    .ok_or("action is required")?;
                let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let selector = params
                    .get("selector")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let msg = tool_browser_automation(action, url, selector)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "github_action" => {
                let action = params
                    .get("action")
                    .and_then(|v| v.as_str())
                    .ok_or("action is required")?;
                let message = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
                let branch = params.get("branch").and_then(|v| v.as_str()).unwrap_or("");
                let msg = tool_github_action(action, message, branch)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "analyze_codebase" => {
                let symbol = params.get("symbol").and_then(|v| v.as_str()).unwrap_or("");
                let kind = params
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("references");
                let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");
                tool_analyze_codebase(symbol, kind, path)
            }
            "manage_memory" => {
                let action = params
                    .get("action")
                    .and_then(|v| v.as_str())
                    .ok_or("action is required")?;
                let key = params.get("key").and_then(|v| v.as_str()).unwrap_or("");
                let value = params.get("value").and_then(|v| v.as_str()).unwrap_or("");
                let msg = tool_manage_memory(action, key, value)?;
                Ok(serde_json::json!({ "message": msg }))
            }
            "spawn_sub_agent" => {
                let sub_task = params
                    .get("sub_task_prompt")
                    .and_then(|v| v.as_str())
                    .ok_or("sub_task_prompt is required")?;
                let model = params
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&config.model);
                let timeout_seconds = params
                    .get("timeout_seconds")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(60);

                let mut sub_config = config.clone();
                if !model.is_empty() {
                    sub_config.model = model.to_string();
                }
                let msg = NativeMessage {
                    role: "user".to_string(),
                    content: Some(sub_task.to_string()),
                    tool_call_id: None,
                    tool_calls: None,
                    reasoning_content: None,
                    thinking_signature: None,
                    attachments: Vec::new(),
                };
                // This branch already runs inside spawn_blocking.
                let reply = chat_blocking(&sub_config, &[msg])?;
                Ok(serde_json::json!({
                    "sub_agent_reply": reply.text.chars().take(3000).collect::<String>(),
                    "timeout_seconds": timeout_seconds
                }))
            }
            _ => Err(format!("Unknown tool: {}", tool_id)),
        }
    })
    .await
    .map_err(|e| format!("Worker thread error: {}", e))?
}

/// Shared read implementation for tools and the legacy command.
fn read_file_inner(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    if p.is_dir() {
        return Err(format!("Path is a directory, not a file: {}", path));
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}

/// Shared directory-listing implementation for tools and the legacy command.
fn list_dir_inner(path: &str) -> Result<Vec<DirEntry>, String> {
    let path = expand_path(path);
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let entries = fs::read_dir(p).map_err(|e| e.to_string())?;
    let mut result: Vec<DirEntry> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        result.push(DirEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }
    result.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(result)
}

/// Routes legacy pwd/list_dir/read_file commands through the tool implementations.
#[tauri::command]
fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    list_dir_inner(path)
}

#[tauri::command]
fn read_file(path: &str) -> Result<String, String> {
    read_file_inner(path)
}

#[cfg(test)]
mod performance_tests {
    use super::*;

    fn user_message(content: &str) -> NativeMessage {
        NativeMessage {
            role: "user".to_string(),
            content: Some(content.to_string()),
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
            thinking_signature: None,
            attachments: Vec::new(),
        }
    }

    fn attachment(kind: &str, mime_type: &str, value: &str) -> NativeAttachment {
        NativeAttachment {
            name: if kind == "document" {
                "brief.pdf"
            } else if kind == "image" {
                "screen.png"
            } else {
                "notes.md"
            }
            .to_string(),
            mime_type: mime_type.to_string(),
            kind: kind.to_string(),
            size: value.len() as u64,
            text: (kind == "text").then(|| value.to_string()),
            data_url: (kind != "text").then(|| value.to_string()),
        }
    }

    #[test]
    fn provider_message_shapes_preserve_supported_attachments() {
        let mut openai = user_message("Explain this");
        openai.attachments = vec![
            attachment("text", "text/markdown", "# Notes"),
            attachment("image", "image/png", "data:image/png;base64,YWJj"),
        ];
        let openai_payload = openai_messages("openai", &[openai]);
        assert_eq!(openai_payload[0]["content"][1]["type"], "text");
        assert_eq!(openai_payload[0]["content"][2]["type"], "image_url");

        let mut gemini = user_message("Read this");
        gemini.attachments = vec![attachment(
            "document",
            "application/pdf",
            "data:application/pdf;base64,YWJj",
        )];
        let gemini_payload = gemini_contents(&[gemini.clone()]);
        assert_eq!(
            gemini_payload[0]["parts"][1]["inlineData"]["mimeType"],
            "application/pdf"
        );
        let anthropic_payload = anthropic_messages(&[gemini]);
        assert_eq!(anthropic_payload[0]["content"][1]["type"], "document");
    }

    #[test]
    fn attachment_validation_rejects_protocol_mismatch_and_malformed_media() {
        let mut message = user_message("Read this");
        message.attachments = vec![attachment(
            "document",
            "application/pdf",
            "data:application/pdf;base64,YWJj",
        )];
        assert!(validate_native_messages(
            providers::ProviderProtocol::OpenAiChat,
            &[message.clone()]
        )
        .is_err());
        assert!(validate_native_messages(
            providers::ProviderProtocol::GeminiGenerateContent,
            &[message]
        )
        .is_ok());

        let mut invalid = user_message("Look");
        invalid.attachments = vec![attachment(
            "image",
            "image/png",
            "https://example.com/image.png",
        )];
        assert!(
            validate_native_messages(providers::ProviderProtocol::OpenAiChat, &[invalid]).is_err()
        );
    }

    #[test]
    fn groq_exposes_plan_review_only_when_requested_or_forced_by_plan_mode() {
        let plain = native_tools_for("groq", &[user_message("Hello")]);
        assert!(!tool_names(&plain).contains(&"enter_plan_mode"));
        let explicit = native_tools_for("groq", &[user_message("Create a plan for this refactor")]);
        assert!(tool_names(&explicit).contains(&"enter_plan_mode"));
        let forced = native_tools_for(
            "groq",
            &[
                NativeMessage {
                    role: "system".into(),
                    content: Some("Current composer mode: PLAN".into()),
                    ..user_message("")
                },
                user_message("Refactor the UI"),
            ],
        );
        assert!(tool_names(&forced).contains(&"enter_plan_mode"));
    }

    fn tool_names(tools: &serde_json::Value) -> Vec<&str> {
        tools
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tool| tool.pointer("/function/name")?.as_str())
            .collect()
    }

    #[test]
    fn native_tool_schema_is_built_once() {
        assert!(std::ptr::eq(native_tools(), native_tools()));
    }

    #[test]
    fn optional_remote_tools_only_join_relevant_requests() {
        let local = native_tools_for("openai", &[user_message("src klasöründeki hatayı düzelt")]);
        let local_names = tool_names(&local);
        assert!(local_names.contains(&"read_file"));
        assert!(!local_names.contains(&"web_fetch"));
        assert!(!local_names.contains(&"github_action"));

        let remote = native_tools_for(
            "openai",
            &[user_message(
                "internetten güncel bilgiyi araştır ve github repoya commit hazırla",
            )],
        );
        let remote_names = tool_names(&remote);
        assert!(remote_names.contains(&"web_fetch"));
        assert!(remote_names.contains(&"browser_automation"));
        assert!(remote_names.contains(&"github_action"));
    }

    #[test]
    fn groq_omits_tools_for_conversation_and_routes_small_task_sets() {
        let casual = native_tools_for("groq", &[user_message("Ayak?")]);
        assert!(tool_names(&casual).is_empty());

        let coding = native_tools_for(
            "groq",
            &[user_message("Uygulamadaki kod hatasını bul ve düzelt")],
        );
        let coding_names = tool_names(&coding);
        assert!((3..=5).contains(&coding_names.len()));
        assert!(coding_names.contains(&"read_file"));
        assert!(coding_names.contains(&"edit_file"));
        assert!(!coding_names.contains(&"delete_file"));

        let destructive = native_tools_for(
            "groq",
            &[user_message("Masaüstündeki deneme.txt dosyasını sil")],
        );
        assert!(tool_names(&destructive).contains(&"delete_file"));
    }

    #[test]
    fn groq_tool_payload_and_completion_reservation_stay_bounded() {
        let full_size = native_tools().to_string().len();
        let routed = native_tools_for(
            "groq",
            &[user_message("Projede bu UI hatasını incele ve düzelt")],
        );
        assert!(routed.to_string().len() < full_size / 2);
        assert_eq!(effective_max_output_tokens("groq", Some(65_536)), 1536);
        assert_eq!(effective_max_output_tokens("openai", Some(65_536)), 16_384);
    }
}

#[cfg(test)]
mod rate_limit_tests {
    use super::*;
    use std::collections::HashMap;

    fn snapshot(headers: &[(&str, &str)]) -> Option<RateLimitInfo> {
        let values = headers
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect::<HashMap<_, _>>();
        rate_limits_from_headers(|name| values.get(name).cloned())
    }

    #[test]
    fn parses_openai_and_groq_standard_headers() {
        let info = snapshot(&[
            ("x-ratelimit-limit-requests", "500"),
            ("x-ratelimit-remaining-requests", "499"),
            ("x-ratelimit-limit-tokens", "30000"),
            ("x-ratelimit-remaining-tokens", "28420"),
            ("x-ratelimit-reset-tokens", "1.2s"),
            ("x-ratelimit-limit-project-tokens", "90000"),
        ])
        .unwrap();
        assert_eq!(info.requests_remaining.as_deref(), Some("499"));
        assert_eq!(info.tokens_remaining.as_deref(), Some("28420"));
        assert_eq!(info.tokens_reset.as_deref(), Some("1.2s"));
        assert_eq!(info.project_tokens_limit.as_deref(), Some("90000"));
    }

    #[test]
    fn parses_anthropic_split_token_buckets() {
        let info = snapshot(&[
            ("anthropic-ratelimit-requests-limit", "60"),
            ("anthropic-ratelimit-requests-remaining", "57"),
            ("anthropic-ratelimit-input-tokens-limit", "40000"),
            ("anthropic-ratelimit-input-tokens-remaining", "38200"),
            ("anthropic-ratelimit-output-tokens-limit", "8000"),
            (
                "anthropic-ratelimit-output-tokens-reset",
                "2026-08-14T20:00:00Z",
            ),
        ])
        .unwrap();
        assert_eq!(info.requests_limit.as_deref(), Some("60"));
        assert_eq!(info.input_tokens_remaining.as_deref(), Some("38200"));
        assert_eq!(info.output_tokens_limit.as_deref(), Some("8000"));
        assert_eq!(
            info.output_tokens_reset.as_deref(),
            Some("2026-08-14T20:00:00Z")
        );
    }

    #[test]
    fn parses_together_and_fireworks_special_headers() {
        let info = snapshot(&[
            ("x-ratelimit-limit", "5"),
            ("x-ratelimit-remaining", "4"),
            ("x-tokenlimit-limit", "2000"),
            ("x-tokenlimit-remaining", "1800"),
            ("x-ratelimit-limit-tokens-prompt", "360000"),
            ("x-ratelimit-limit-tokens-cache-adjusted-prompt", "90000"),
            ("x-ratelimit-limit-tokens-generated", "3600"),
            ("retry-after", "2"),
        ])
        .unwrap();
        assert_eq!(info.requests_remaining.as_deref(), Some("4"));
        assert_eq!(info.tokens_remaining.as_deref(), Some("1800"));
        assert_eq!(info.input_tokens_limit.as_deref(), Some("360000"));
        assert_eq!(info.cached_input_tokens_limit.as_deref(), Some("90000"));
        assert_eq!(info.output_tokens_limit.as_deref(), Some("3600"));
        assert_eq!(info.retry_after.as_deref(), Some("2"));
    }

    #[test]
    fn missing_provider_headers_do_not_invent_live_quota() {
        assert!(snapshot(&[]).is_none());
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn markdown_links_accept_only_safe_web_protocols() {
        assert!(validate_external_url("https://docs.rs/tauri").is_ok());
        assert!(validate_external_url("http://example.com/path?q=1").is_ok());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("file:///C:/Windows/System32").is_err());
        assert!(validate_external_url("https://user:pass@example.com").is_err());
    }

    #[test]
    fn markdown_paths_reject_network_and_missing_targets() {
        assert!(resolve_reveal_path(r"\\server\private\file.txt").is_err());
        assert!(resolve_reveal_path("//server/private/file.txt").is_err());
        assert!(resolve_reveal_path("definitely-not-an-existing-phase-five-file").is_err());
        assert!(resolve_reveal_path(".").is_ok());
    }

    fn config_with_legacy_secret() -> AppConfig {
        AppConfig {
            provider: "openai".to_string(),
            api_key: "sk-never-write-this".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            model: "gpt-5.6-terra".to_string(),
            mode: default_mode(),
            allow_list: Vec::new(),
            providers: vec![LinkedProvider {
                id: "openai".to_string(),
                api_key: "sk-linked-secret".to_string(),
                base_url: "https://api.openai.com/v1".to_string(),
                model: "gpt-5.6-terra".to_string(),
                protocol: Some("openai_chat".to_string()),
                auth_scheme: Some("bearer".to_string()),
                secret_ref: Some("provider:openai".to_string()),
                models_path: None,
                chat_path: None,
                header_names: vec!["X-Tenant".to_string()],
                request_timeout_secs: Some(45),
                allow_local_network: false,
                context_limit: None,
                max_output_tokens: None,
                input_price_per_million: None,
                output_price_per_million: None,
                cached_input_price_per_million: None,
                thinking_mode: None,
                thinking_budget: None,
            }],
            context_limit: None,
            context_ratio: None,
            max_output_tokens: None,
            input_price_per_million: None,
            output_price_per_million: None,
            cached_input_price_per_million: None,
            protocol: Some("openai_chat".to_string()),
            auth_scheme: Some("bearer".to_string()),
            secret_ref: Some("provider:openai".to_string()),
            models_path: None,
            chat_path: None,
            header_names: vec!["X-Tenant".to_string()],
            request_timeout_secs: Some(45),
            allow_local_network: false,
            thinking_mode: None,
            thinking_budget: None,
        }
    }

    #[test]
    fn serialized_config_never_contains_api_keys() {
        let mut config = config_with_legacy_secret();
        config.thinking_mode = Some("high".to_string());
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("sk-never-write-this"));
        assert!(!json.contains("sk-linked-secret"));
        assert!(!json.contains("apiKey"));
        assert!(json.contains("provider:openai"));
        assert!(json.contains("X-Tenant"));
        assert!(json.contains("\"thinkingMode\":\"high\""));
        assert!(!json.contains("thinking_mode"));
    }

    #[test]
    fn thinking_mode_forwards_api_effort_and_disables_standard_requests() {
        let mut config = config_with_legacy_secret();
        config.thinking_mode = Some("xhigh".to_string());
        let mut payload = serde_json::json!({});
        apply_thinking_params(
            providers::ProviderProtocol::OpenAiChat,
            "openai",
            &config,
            &mut payload,
        );
        assert_eq!(payload["reasoning_effort"], "xhigh");

        config.thinking_mode = Some("off".to_string());
        let mut standard_payload = serde_json::json!({});
        apply_thinking_params(
            providers::ProviderProtocol::OpenAiChat,
            "openai",
            &config,
            &mut standard_payload,
        );
        assert!(standard_payload.get("reasoning_effort").is_none());
    }

    #[test]
    fn groq_reasoning_modes_follow_each_model_api_contract() {
        let mut config = config_with_legacy_secret();
        config.thinking_mode = Some("off".to_string());
        config.model = "qwen/qwen3.6-27b".to_string();
        let mut qwen = serde_json::json!({});
        apply_thinking_params(
            providers::ProviderProtocol::OpenAiChat,
            "groq",
            &config,
            &mut qwen,
        );
        assert_eq!(qwen["reasoning_effort"], "none");

        config.model = "openai/gpt-oss-120b".to_string();
        let mut gpt_oss = serde_json::json!({
            "tools": [{"type":"function","function":{"name":"read_file"}}]
        });
        apply_thinking_params(
            providers::ProviderProtocol::OpenAiChat,
            "groq",
            &config,
            &mut gpt_oss,
        );
        assert_eq!(gpt_oss["reasoning_effort"], "low");
        assert_eq!(gpt_oss["reasoning_format"], "parsed");
    }

    #[test]
    fn groq_stream_payload_does_not_reserve_the_whole_free_tier_bucket() {
        let mut config = config_with_legacy_secret();
        config.provider = "groq".to_string();
        config.model = "qwen/qwen3.6-27b".to_string();
        config.max_output_tokens = Some(65_536);
        config.thinking_mode = Some("off".to_string());
        let body = stream_body(
            &config,
            &[NativeMessage {
                role: "user".to_string(),
                content: Some("Ayak?".to_string()),
                tool_call_id: None,
                tool_calls: None,
                reasoning_content: None,
                thinking_signature: None,
                attachments: Vec::new(),
            }],
        );
        let payload: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(payload["max_completion_tokens"], 1536);
        assert!(payload.get("max_tokens").is_none());
        assert!(payload.get("tools").is_none());
        assert!(payload.get("tool_choice").is_none());
        assert_eq!(payload["reasoning_effort"], "none");
    }

    #[test]
    fn thinking_budget_reaches_gemini_generation_config() {
        let mut config = config_with_legacy_secret();
        config.thinking_mode = Some("high".to_string());
        config.thinking_budget = Some(4096);
        let mut payload = serde_json::json!({});
        apply_thinking_params(
            providers::ProviderProtocol::GeminiGenerateContent,
            "gemini",
            &config,
            &mut payload,
        );
        assert_eq!(
            payload.pointer("/generationConfig/thinkingConfig/thinkingBudget"),
            Some(&serde_json::json!(4096))
        );
    }

    #[test]
    fn remote_error_redaction_masks_common_secret_shapes() {
        let raw = "Bearer sk-test-token https://x.test?key=AIzaPrivate gsk_private nvapi-private";
        let redacted = redact_sensitive(raw);
        assert!(!redacted.contains("sk-test-token"));
        assert!(!redacted.contains("AIzaPrivate"));
        assert!(!redacted.contains("gsk_private"));
        assert!(!redacted.contains("nvapi-private"));
        assert!(redacted.contains("***"));
    }

    #[test]
    fn generated_session_titles_are_plain_and_bounded() {
        assert_eq!(
            clean_session_title("## `Streaming ve Oturum Yönetimi`\nAçıklama", "yedek"),
            "Streaming ve Oturum Yönetimi"
        );
        assert_eq!(
            clean_session_title("   ", "İlk kullanıcı isteği"),
            "İlk kullanıcı isteği"
        );
        assert!(
            clean_session_title(&"a".repeat(100), "yedek")
                .chars()
                .count()
                <= 64
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // If started from project root, point to src-tauri so Tauri config resolves frontendDist "../src"
    if let Ok(current) = std::env::current_dir() {
        if current.join("src-tauri").is_dir() && current.join("src").is_dir() {
            let _ = std::env::set_current_dir(current.join("src-tauri"));
        }
    }

    tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            // Restore terminal working directory to project root for tool execution
            if let Ok(current) = std::env::current_dir() {
                let is_tauri_dir = current
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("src-tauri"));

                if is_tauri_dir {
                    if let Some(project_root) = current.parent() {
                        if project_root.join("package.json").is_file()
                            && project_root.join("src").is_dir()
                        {
                            let _ = std::env::set_current_dir(project_root);
                        }
                    }
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .manage(streaming::StreamManager::default())
        .invoke_handler(tauri::generate_handler![
            pwd,
            home,
            open_external_url,
            reveal_local_path,
            themes::list_user_themes,
            themes::open_theme_directory,
            change_dir,
            list_dir,
            read_file,
            run_command,
            quit_app,
            get_config,
            save_config,
            provider_catalog,
            diagnostics::diagnose_provider,
            connect_provider_secure,
            test_provider_connection,
            credential_status,
            disconnect_provider,
            list_models,
            chat_completion,
            generate_session_title,
            chat_completion_stream,
            cancel_chat_stream,
            create_session,
            save_session,
            checkpoint_session,
            list_sessions,
            load_session,
            latest_session,
            delete_session,
            check_tool,
            execute_approved_tool,
            undo_last,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
