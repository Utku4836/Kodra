use crate::secrets::SecretHeader;
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::net::{IpAddr, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

/// Provider çağrılarının aynı TLS bağlantılarını yeniden kullanmasını sağlar.
/// Timeout her Request üzerinde ayrıca uygulanır; bu nedenle farklı provider
/// politikaları tek connection pool paylaşırken korunur.
fn shared_http_agent() -> &'static ureq::Agent {
    static HTTP_AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    HTTP_AGENT.get_or_init(|| ureq::AgentBuilder::new().build())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    OpenAiChat,
    AnthropicMessages,
    GeminiGenerateContent,
}

impl ProviderProtocol {
    pub fn from_name(value: &str) -> Self {
        match value {
            "anthropic_messages" | "anthropic" => Self::AnthropicMessages,
            "gemini_generate_content" | "gemini" => Self::GeminiGenerateContent,
            _ => Self::OpenAiChat,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAiChat => "openai_chat",
            Self::AnthropicMessages => "anthropic_messages",
            Self::GeminiGenerateContent => "gemini_generate_content",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthScheme {
    Bearer,
    XApiKey,
    GoogleApiKey,
    QueryKey,
    None,
}

impl AuthScheme {
    pub fn from_name(value: &str) -> Self {
        match value {
            "x_api_key" | "x-api-key" => Self::XApiKey,
            "google_api_key" | "x-goog-api-key" => Self::GoogleApiKey,
            "query_key" | "query" => Self::QueryKey,
            "none" => Self::None,
            _ => Self::Bearer,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bearer => "bearer",
            Self::XApiKey => "x_api_key",
            Self::GoogleApiKey => "google_api_key",
            Self::QueryKey => "query_key",
            Self::None => "none",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapabilities {
    pub model_discovery: bool,
    pub tools: bool,
    pub parallel_tools: bool,
    pub reasoning: bool,
    pub structured_output: bool,
    pub vision: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub default_model: String,
    pub preferred_models: Vec<String>,
    pub requires_api_key: bool,
    pub protocol: String,
    pub auth_scheme: String,
    pub capabilities: ProviderCapabilities,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub provider_id: String,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub input_price_per_million: Option<f64>,
    pub output_price_per_million: Option<f64>,
    pub cached_input_price_per_million: Option<f64>,
    pub supports_tools: Option<bool>,
    pub supports_reasoning: Option<bool>,
    pub supports_vision: Option<bool>,
    pub reasoning_options: Option<Vec<String>>,
    pub status: String,
    pub recommended: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderValidation {
    pub provider_id: String,
    pub model_count: usize,
    pub recommended_model: Option<String>,
    pub message: String,
}

fn capabilities(
    tools: bool,
    parallel_tools: bool,
    reasoning: bool,
    structured_output: bool,
    vision: bool,
) -> ProviderCapabilities {
    ProviderCapabilities {
        model_discovery: true,
        tools,
        parallel_tools,
        reasoning,
        structured_output,
        vision,
    }
}

fn provider(
    id: &str,
    name: &str,
    base_url: &str,
    preferred_models: &[&str],
    requires_api_key: bool,
    protocol: ProviderProtocol,
    auth_scheme: AuthScheme,
    provider_capabilities: ProviderCapabilities,
) -> ProviderInfo {
    ProviderInfo {
        id: id.to_string(),
        name: name.to_string(),
        base_url: base_url.to_string(),
        default_model: preferred_models
            .first()
            .copied()
            .unwrap_or_default()
            .to_string(),
        preferred_models: preferred_models
            .iter()
            .map(|model| (*model).to_string())
            .collect(),
        requires_api_key,
        protocol: protocol.as_str().to_string(),
        auth_scheme: auth_scheme.as_str().to_string(),
        capabilities: provider_capabilities,
    }
}

pub fn catalog() -> Vec<ProviderInfo> {
    vec![
        provider(
            "nvidia",
            "NVIDIA NIM",
            "https://integrate.api.nvidia.com/v1",
            &["nvidia/llama-3.3-nemotron-super-49b-v1"],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "openai",
            "OpenAI",
            "https://api.openai.com/v1",
            &[
                "gpt-5.6-terra",
                "gpt-5.6-sol",
                "gpt-5.6-luna",
                "gpt-5.5",
                "gpt-5.4",
            ],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "anthropic",
            "Anthropic",
            "https://api.anthropic.com/v1",
            &[
                "claude-sonnet-5",
                "claude-opus-5",
                "claude-sonnet-4-6",
                "claude-haiku-4-5-20251001",
            ],
            true,
            ProviderProtocol::AnthropicMessages,
            AuthScheme::XApiKey,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "gemini",
            "Google Gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            &[
                "gemini-3.6-flash",
                "gemini-3.5-flash",
                "gemini-3.5-flash-lite",
            ],
            true,
            ProviderProtocol::GeminiGenerateContent,
            AuthScheme::GoogleApiKey,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "groq",
            "Groq",
            "https://api.groq.com/openai/v1",
            &[
                "qwen/qwen3.6-27b",
                "openai/gpt-oss-120b",
                "openai/gpt-oss-20b",
            ],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "deepseek",
            "DeepSeek",
            "https://api.deepseek.com/v1",
            &["deepseek-v4-flash", "deepseek-v4-pro"],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, true, true, false),
        ),
        provider(
            "together",
            "Together AI",
            "https://api.together.xyz/v1",
            &[
                "zai-org/GLM-5.1",
                "moonshotai/Kimi-K2.6",
                "openai/gpt-oss-120b",
                "Qwen/Qwen3.5-397B-A17B",
            ],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "fireworks",
            "Fireworks AI",
            "https://api.fireworks.ai/inference/v1",
            &[
                "accounts/fireworks/routers/kimi-k2p6-turbo",
                "accounts/fireworks/models/kimi-k2p5",
                "accounts/fireworks/models/llama-v3p3-70b-instruct",
            ],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1",
            &["openrouter/auto", "openrouter/pareto-code"],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "ollama",
            "Ollama (Local)",
            "http://localhost:11434/v1",
            &[],
            false,
            ProviderProtocol::OpenAiChat,
            AuthScheme::None,
            capabilities(true, true, true, true, true),
        ),
        provider(
            "custom",
            "Custom Server",
            "",
            &[],
            true,
            ProviderProtocol::OpenAiChat,
            AuthScheme::Bearer,
            capabilities(true, true, false, false, false),
        ),
    ]
}

pub fn provider_info(provider_id: &str) -> ProviderInfo {
    catalog()
        .into_iter()
        .find(|entry| entry.id == provider_id)
        .unwrap_or_else(|| {
            provider(
                provider_id,
                provider_id,
                "",
                &[],
                true,
                ProviderProtocol::OpenAiChat,
                AuthScheme::Bearer,
                capabilities(true, true, false, false, false),
            )
        })
}

pub fn effective_protocol(provider_id: &str, custom_protocol: Option<&str>) -> ProviderProtocol {
    if provider_id == "custom" {
        return ProviderProtocol::from_name(custom_protocol.unwrap_or("openai_chat"));
    }
    ProviderProtocol::from_name(&provider_info(provider_id).protocol)
}

pub fn effective_auth(provider_id: &str, custom_auth: Option<&str>) -> AuthScheme {
    if provider_id == "custom" {
        return AuthScheme::from_name(custom_auth.unwrap_or("bearer"));
    }
    AuthScheme::from_name(&provider_info(provider_id).auth_scheme)
}

pub fn normalize_base_url(provider_id: &str, raw: &str) -> String {
    let mut base = raw.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        base = provider_info(provider_id).base_url;
    }
    if provider_id == "ollama" && !base.ends_with("/v1") {
        base.push_str("/v1");
    }
    base
}

fn append_path(base_url: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn append_query_key(url: String, api_key: &str) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{}{}key={}", url, separator, api_key)
}

fn safe_endpoint_path(override_path: Option<&str>, fallback: &str) -> Result<String, String> {
    let path = override_path.unwrap_or(fallback).trim();
    if path.is_empty() {
        return Ok(fallback.to_string());
    }
    if path.contains("://")
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path.contains("..")
        || path.chars().any(char::is_control)
    {
        return Err("Endpoint must be a safe relative path".to_string());
    }
    Ok(path.trim_start_matches('/').to_string())
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
        }
        IpAddr::V6(ip) => {
            let first = ip.octets()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || (first & 0xfe) == 0xfc
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

pub fn validate_custom_url(raw: &str, allow_local_network: bool) -> Result<(), String> {
    let parsed = Url::parse(raw).map_err(|_| "Enter a valid Custom Server URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Custom Server can only use HTTP or HTTPS".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("A URL cannot contain a username or password".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Custom Server host is missing".to_string())?;
    let local_name = host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local");
    let literal_private = host.parse::<IpAddr>().map(is_private_ip).unwrap_or(false);

    if (local_name || literal_private) && !allow_local_network {
        return Err(
            "Local/private network access is disabled; you must explicitly allow it".to_string(),
        );
    }
    if parsed.scheme() == "http" && !(allow_local_network && (local_name || literal_private)) {
        return Err("HTTPS is required for a remote Custom Server".to_string());
    }
    if !allow_local_network {
        let port = parsed.port_or_known_default().unwrap_or(443);
        if let Ok(addresses) = (host, port).to_socket_addrs() {
            if addresses
                .into_iter()
                .any(|address| is_private_ip(address.ip()))
            {
                return Err("Custom Server resolves to a private address".to_string());
            }
        }
    }
    Ok(())
}

pub fn validate_headers(headers: &[SecretHeader]) -> Result<(), String> {
    const BLOCKED: &[&str] = &[
        "authorization",
        "x-api-key",
        "x-goog-api-key",
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "cookie",
        "set-cookie",
    ];
    if headers.len() > 16 {
        return Err("At most 16 custom headers can be added".to_string());
    }
    for header in headers {
        let name = header.name.trim();
        if name.is_empty()
            || name.len() > 64
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        {
            return Err("Invalid custom header name".to_string());
        }
        if BLOCKED
            .iter()
            .any(|blocked| name.eq_ignore_ascii_case(blocked))
        {
            return Err(format!("The {} header is managed by the application", name));
        }
        if header.value.len() > 4096 || header.value.contains('\r') || header.value.contains('\n') {
            return Err(format!("The {} header value is invalid", name));
        }
    }
    Ok(())
}

fn apply_extra_headers(
    mut request: ureq::Request,
    headers: &[SecretHeader],
) -> Result<ureq::Request, String> {
    validate_headers(headers)?;
    for header in headers {
        request = request.set(header.name.trim(), &header.value);
    }
    Ok(request)
}

fn apply_auth(
    mut request: ureq::Request,
    provider_id: &str,
    api_key: &str,
    auth_scheme: AuthScheme,
) -> ureq::Request {
    request = request.set("Accept", "application/json");
    match auth_scheme {
        AuthScheme::Bearer => {
            if !api_key.is_empty() {
                request = request.set("Authorization", &format!("Bearer {}", api_key));
            }
        }
        AuthScheme::XApiKey => {
            request = request
                .set("x-api-key", api_key)
                .set("anthropic-version", "2023-06-01");
        }
        AuthScheme::GoogleApiKey => {
            request = request.set("x-goog-api-key", api_key);
        }
        AuthScheme::QueryKey | AuthScheme::None => {}
    }
    if provider_id == "openrouter" {
        request = request.set("X-OpenRouter-Title", "Kodra");
    }
    request
}

pub fn models_request(
    provider_id: &str,
    base_url: &str,
    api_key: &str,
    custom_protocol: Option<&str>,
    custom_auth: Option<&str>,
    custom_models_path: Option<&str>,
    extra_headers: &[SecretHeader],
    timeout: Duration,
    allow_local_network: bool,
) -> Result<ureq::Request, String> {
    let base = normalize_base_url(provider_id, base_url);
    if base.is_empty() {
        return Err("Base URL is required".to_string());
    }
    let protocol = effective_protocol(provider_id, custom_protocol);
    let auth = effective_auth(provider_id, custom_auth);
    if provider_id == "custom" {
        validate_custom_url(&base, allow_local_network)?;
    }
    let default_path = match protocol {
        ProviderProtocol::AnthropicMessages => "models?limit=1000",
        ProviderProtocol::GeminiGenerateContent => "models?pageSize=1000",
        ProviderProtocol::OpenAiChat if provider_id == "openrouter" => {
            "models?supported_parameters=tools"
        }
        ProviderProtocol::OpenAiChat => "models",
    };
    let path = if provider_id == "custom" {
        safe_endpoint_path(custom_models_path, default_path)?
    } else {
        default_path.to_string()
    };
    let mut url = append_path(&base, &path);
    if auth == AuthScheme::QueryKey {
        url = append_query_key(url, api_key);
    }
    let request = shared_http_agent().get(&url).timeout(timeout);
    apply_extra_headers(
        apply_auth(request, provider_id, api_key, auth),
        extra_headers,
    )
}

/// OpenRouter exposes the current key's credit/usage envelope separately from
/// model discovery. This request is read-only and does not create a generation.
pub fn openrouter_key_request(
    base_url: &str,
    api_key: &str,
    extra_headers: &[SecretHeader],
    timeout: Duration,
) -> Result<ureq::Request, String> {
    let base = normalize_base_url("openrouter", base_url);
    if base.is_empty() {
        return Err("Base URL is required".to_string());
    }
    let request = shared_http_agent()
        .get(&append_path(&base, "key"))
        .timeout(timeout);
    apply_extra_headers(
        apply_auth(request, "openrouter", api_key, AuthScheme::Bearer),
        extra_headers,
    )
}

/// Ollama's native version route sits outside its OpenAI-compatible `/v1`
/// surface. Keeping it explicit avoids guessing health from a generation call.
pub fn ollama_version_request(base_url: &str, timeout: Duration) -> Result<ureq::Request, String> {
    let normalized = normalize_base_url("ollama", base_url);
    let native_base = normalized
        .strip_suffix("/v1")
        .unwrap_or(&normalized)
        .trim_end_matches('/');
    if native_base.is_empty() {
        return Err("Ollama URL is required".to_string());
    }
    Ok(shared_http_agent()
        .get(&append_path(native_base, "api/version"))
        .timeout(timeout)
        .set("Accept", "application/json"))
}

pub fn chat_request(
    provider_id: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    custom_protocol: Option<&str>,
    custom_auth: Option<&str>,
    custom_chat_path: Option<&str>,
    extra_headers: &[SecretHeader],
    timeout: Duration,
    allow_local_network: bool,
) -> Result<ureq::Request, String> {
    chat_request_mode(
        provider_id,
        base_url,
        api_key,
        model,
        custom_protocol,
        custom_auth,
        custom_chat_path,
        extra_headers,
        timeout,
        allow_local_network,
        false,
    )
}

pub fn chat_stream_request(
    provider_id: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    custom_protocol: Option<&str>,
    custom_auth: Option<&str>,
    custom_chat_path: Option<&str>,
    extra_headers: &[SecretHeader],
    timeout: Duration,
    allow_local_network: bool,
) -> Result<ureq::Request, String> {
    chat_request_mode(
        provider_id,
        base_url,
        api_key,
        model,
        custom_protocol,
        custom_auth,
        custom_chat_path,
        extra_headers,
        timeout,
        allow_local_network,
        true,
    )
}

fn chat_request_mode(
    provider_id: &str,
    base_url: &str,
    api_key: &str,
    model: &str,
    custom_protocol: Option<&str>,
    custom_auth: Option<&str>,
    custom_chat_path: Option<&str>,
    extra_headers: &[SecretHeader],
    timeout: Duration,
    allow_local_network: bool,
    streaming: bool,
) -> Result<ureq::Request, String> {
    let base = normalize_base_url(provider_id, base_url);
    if base.is_empty() {
        return Err("Base URL is required".to_string());
    }
    let protocol = effective_protocol(provider_id, custom_protocol);
    let auth = effective_auth(provider_id, custom_auth);
    if provider_id == "custom" {
        validate_custom_url(&base, allow_local_network)?;
    }
    let default_path = match protocol {
        ProviderProtocol::AnthropicMessages => "messages".to_string(),
        ProviderProtocol::GeminiGenerateContent => format!(
            "models/{}:{}",
            model.trim_start_matches("models/"),
            if streaming {
                "streamGenerateContent"
            } else {
                "generateContent"
            }
        ),
        ProviderProtocol::OpenAiChat => "chat/completions".to_string(),
    };
    let mut path = if provider_id == "custom" {
        safe_endpoint_path(custom_chat_path, &default_path)?
    } else {
        default_path
    };
    if streaming && protocol == ProviderProtocol::GeminiGenerateContent {
        path = path.replace(":generateContent", ":streamGenerateContent");
    }
    let mut url = append_path(&base, &path);
    if auth == AuthScheme::QueryKey {
        url = append_query_key(url, api_key);
    }
    if streaming && protocol == ProviderProtocol::GeminiGenerateContent {
        url.push_str(if url.contains('?') {
            "&alt=sse"
        } else {
            "?alt=sse"
        });
    }
    let request = shared_http_agent()
        .post(&url)
        .set("Content-Type", "application/json")
        .timeout(timeout);
    apply_extra_headers(
        apply_auth(request, provider_id, api_key, auth),
        extra_headers,
    )
}

fn value_u64(value: &Value, pointers: &[&str]) -> Option<u64> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_u64))
}

fn value_string(value: &Value, pointers: &[&str]) -> Option<String> {
    pointers.iter().find_map(|pointer| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

fn value_f64(value: &Value, pointers: &[&str]) -> Option<f64> {
    pointers.iter().find_map(|pointer| {
        let value = value.pointer(pointer)?;
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|raw| raw.parse::<f64>().ok()))
            .filter(|number| number.is_finite() && *number >= 0.0)
    })
}

fn price_per_million(
    value: &Value,
    per_token_pointers: &[&str],
    per_million_pointers: &[&str],
) -> Option<f64> {
    value_f64(value, per_million_pointers)
        .or_else(|| value_f64(value, per_token_pointers).map(|price| price * 1_000_000.0))
}

fn string_array(value: &Value, pointers: &[&str]) -> Vec<String> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_array))
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn bool_value(value: &Value, pointers: &[&str]) -> Option<bool> {
    pointers
        .iter()
        .find_map(|pointer| value.pointer(pointer).and_then(Value::as_bool))
}

fn is_non_agent_model(model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    [
        "embedding",
        "rerank",
        "whisper",
        "transcri",
        "text-to-speech",
        "tts",
        "moderation",
        "guard",
        "dall-e",
        "image",
        "flux",
        "stable-diffusion",
        "sora",
        "veo",
        "video",
        "realtime",
        "audio",
    ]
    .iter()
    .any(|needle| id.contains(needle))
}

fn is_known_deprecated(provider_id: &str, model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    match provider_id {
        "openai" => {
            id.starts_with("gpt-3.5")
                || id.starts_with("gpt-4-")
                || id == "gpt-4"
                || id.starts_with("gpt-4o")
                || id.starts_with("chatgpt-4o")
                || id.starts_with("o1")
                || id.starts_with("o3-mini")
                || id.starts_with("o4-mini")
                || id.starts_with("codex-mini")
                || id.starts_with("davinci")
                || id.starts_with("babbage")
        }
        "anthropic" => {
            id.starts_with("claude-3-")
                || id.starts_with("claude-2")
                || id.starts_with("claude-instant")
                || id == "claude-sonnet-4-20250514"
                || id == "claude-opus-4-20250514"
        }
        "groq" => {
            id == "llama-3.3-70b-versatile"
                || id == "llama-3.1-8b-instant"
                || id.contains("preview")
                || id.contains("llama3-groq")
        }
        "deepseek" => id == "deepseek-chat" || id == "deepseek-reasoner",
        "together" => {
            id == "moonshotai/kimi-k2.5"
                || id.contains("deepseek-r1")
                || id.contains("qwen3-coder-480b")
                || id.contains("llama-4-maverick")
        }
        _ => false,
    }
}

fn explicit_deprecated(value: &Value) -> bool {
    bool_value(value, &["/deprecated", "/is_deprecated"]).unwrap_or(false)
        || value_string(value, &["/status", "/lifecycle/status"])
            .map(|status| {
                let status = status.to_ascii_lowercase();
                status.contains("deprecated")
                    || status.contains("retired")
                    || status.contains("shutdown")
            })
            .unwrap_or(false)
}

fn inferred_capabilities(
    provider_id: &str,
    value: &Value,
    methods: &[String],
) -> (Option<bool>, Option<bool>, Option<bool>) {
    let parameters = string_array(
        value,
        &[
            "/supported_parameters",
            "/capabilities/supported_parameters",
        ],
    );
    let modalities = string_array(
        value,
        &["/architecture/input_modalities", "/input_modalities"],
    );
    let tools = if !parameters.is_empty() {
        Some(
            parameters
                .iter()
                .any(|item| item == "tools" || item == "tool_choice"),
        )
    } else if let Some(flag) = bool_value(
        value,
        &[
            "/capabilities/tools",
            "/capabilities/tool_calling",
            "/function_calling",
        ],
    ) {
        Some(flag)
    } else {
        match provider_id {
            "openai" | "anthropic" | "gemini" | "groq" | "deepseek" => Some(true),
            _ => None,
        }
    };
    let reasoning = if !parameters.is_empty() {
        Some(parameters.iter().any(|item| {
            item == "reasoning" || item == "reasoning_effort" || item == "include_reasoning"
        }))
    } else {
        bool_value(value, &["/capabilities/reasoning", "/reasoning"])
            .or_else(|| matches!(provider_id, "openai" | "gemini" | "deepseek").then_some(true))
    };
    let vision = if !modalities.is_empty() {
        Some(modalities.iter().any(|item| item == "image"))
    } else {
        bool_value(value, &["/capabilities/vision", "/vision"])
    };

    let tools = if provider_id == "gemini" {
        Some(methods.iter().any(|method| method == "generateContent"))
    } else {
        tools
    };
    (tools, reasoning, vision)
}

fn model_status(model_id: &str, value: &Value) -> String {
    if let Some(status) = value_string(value, &["/status", "/lifecycle/status"]) {
        return status.to_ascii_lowercase();
    }
    let id = model_id.to_ascii_lowercase();
    if id.contains("preview") || id.contains("beta") || id.contains("experimental") {
        "preview".to_string()
    } else {
        "stable".to_string()
    }
}

pub fn parse_models(
    provider_id: &str,
    custom_protocol: Option<&str>,
    body: &Value,
) -> Vec<ModelInfo> {
    let rows = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .cloned()
        .unwrap_or_default();
    let protocol = effective_protocol(provider_id, custom_protocol);
    let mut models = Vec::new();

    for row in rows {
        let raw_id = value_string(&row, &["/id", "/name", "/model"]).unwrap_or_default();
        if raw_id.is_empty() {
            continue;
        }
        let id = if protocol == ProviderProtocol::GeminiGenerateContent {
            raw_id.trim_start_matches("models/").to_string()
        } else {
            raw_id
        };
        let methods = string_array(
            &row,
            &[
                "/supportedGenerationMethods",
                "/supported_generation_methods",
            ],
        );
        if protocol == ProviderProtocol::GeminiGenerateContent
            && !methods.iter().any(|method| method == "generateContent")
        {
            continue;
        }
        if is_non_agent_model(&id)
            || is_known_deprecated(provider_id, &id)
            || explicit_deprecated(&row)
        {
            continue;
        }
        let (supports_tools, supports_reasoning, supports_vision) =
            inferred_capabilities(provider_id, &row, &methods);
        if supports_tools == Some(false) {
            continue;
        }
        models.push(ModelInfo {
            display_name: value_string(&row, &["/display_name", "/displayName", "/name"])
                .unwrap_or_else(|| id.clone())
                .trim_start_matches("models/")
                .to_string(),
            context_window: value_u64(
                &row,
                &[
                    "/context_length",
                    "/context_window",
                    "/max_input_tokens",
                    "/inputTokenLimit",
                    "/limits/context_window",
                ],
            ),
            max_output_tokens: value_u64(
                &row,
                &[
                    "/max_tokens",
                    "/max_output_tokens",
                    "/outputTokenLimit",
                    "/limits/max_output_tokens",
                ],
            ),
            input_price_per_million: price_per_million(
                &row,
                &["/pricing/prompt", "/pricing/input", "/price/input"],
                &[
                    "/pricing/input_per_million",
                    "/pricing/inputPerMillion",
                    "/input_price_per_million",
                ],
            ),
            output_price_per_million: price_per_million(
                &row,
                &["/pricing/completion", "/pricing/output", "/price/output"],
                &[
                    "/pricing/output_per_million",
                    "/pricing/outputPerMillion",
                    "/output_price_per_million",
                ],
            ),
            cached_input_price_per_million: price_per_million(
                &row,
                &["/pricing/input_cache_read", "/pricing/cached_input"],
            let reasoning_options = {
                let opts = string_array(
                    &row,
                    &[
                        "/reasoning_options",
                        "/reasoningOptions",
                        "/capabilities/reasoning_options",
                        "/supported_parameters/reasoning_effort/values",
                        "/reasoning/efforts",
                        "/variants",
                    ],
                );
                if !opts.is_empty() {
                    Some(opts)
                } else {
                    None
                }
            };
            models.push(ModelInfo {
                display_name: value_string(&row, &["/display_name", "/displayName", "/name"])
                    .unwrap_or_else(|| id.clone())
                    .trim_start_matches("models/")
                    .to_string(),
                context_window: value_u64(
                    &row,
                    &[
                        "/context_length",
                        "/context_window",
                        "/max_input_tokens",
                        "/inputTokenLimit",
                        "/limits/context_window",
                    ],
                ),
                max_output_tokens: value_u64(
                    &row,
                    &[
                        "/max_tokens",
                        "/max_output_tokens",
                        "/outputTokenLimit",
                        "/limits/max_output_tokens",
                    ],
                ),
                input_price_per_million: price_per_million(
                    &row,
                    &["/pricing/prompt", "/pricing/input", "/price/input"],
                    &[
                        "/pricing/input_per_million",
                        "/pricing/inputPerMillion",
                        "/input_price_per_million",
                    ],
                ),
                output_price_per_million: price_per_million(
                    &row,
                    &["/pricing/completion", "/pricing/output", "/price/output"],
                    &[
                        "/pricing/output_per_million",
                        "/pricing/outputPerMillion",
                        "/output_price_per_million",
                    ],
                ),
                cached_input_price_per_million: price_per_million(
                    &row,
                    &["/pricing/input_cache_read", "/pricing/cached_input"],
                    &[
                        "/pricing/cached_input_per_million",
                        "/cached_input_price_per_million",
                    ],
                ),
                supports_tools,
                supports_reasoning,
                supports_vision,
                reasoning_options,
                status: model_status(&id, &row),
                provider_id: provider_id.to_string(),
                id,
                recommended: false,
            });
    }

    let preferences = provider_info(provider_id).preferred_models;
    if let Some(preferred_id) = preferences
        .iter()
        .find(|candidate| models.iter().any(|model| model.id == candidate.as_str()))
    {
        if let Some(model) = models
            .iter_mut()
            .find(|model| model.id == preferred_id.as_str())
        {
            model.recommended = true;
        }
    }
    models.sort_by(
        |left, right| match right.recommended.cmp(&left.recommended) {
            Ordering::Equal => match (left.status.as_str(), right.status.as_str()) {
                ("stable", "stable") | ("preview", "preview") => left.id.cmp(&right.id),
                ("stable", _) => Ordering::Less,
                (_, "stable") => Ordering::Greater,
                _ => left.id.cmp(&right.id),
            },
            other => other,
        },
    );
    models
}

pub fn recommended_model(provider_id: &str, models: &[ModelInfo]) -> Option<String> {
    models
        .iter()
        .find(|model| model.recommended)
        .or_else(|| models.first())
        .map(|model| model.id.clone())
        .or_else(|| {
            let fallback = provider_info(provider_id).default_model;
            (!fallback.is_empty()).then_some(fallback)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalog_has_all_unique_providers() {
        let catalog = catalog();
        assert_eq!(catalog.len(), 11);
        let mut ids: Vec<_> = catalog.iter().map(|item| item.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 11);
        for entry in catalog {
            if !entry.default_model.is_empty() {
                assert!(!is_known_deprecated(&entry.id, &entry.default_model));
            }
        }
    }

    #[test]
    fn ollama_base_url_is_normalized_to_openai_v1() {
        assert_eq!(
            normalize_base_url("ollama", "http://localhost:11434/"),
            "http://localhost:11434/v1"
        );
        assert_eq!(
            normalize_base_url("ollama", "http://localhost:11434/v1"),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn openrouter_filters_non_tool_models_and_ranks_auto_router() {
        let body = json!({"data": [
            {"id":"example/no-tools", "supported_parameters":["temperature"]},
            {"id":"openrouter/auto", "supported_parameters":["tools", "reasoning"], "context_length": 200000,
             "pricing":{"prompt":"0.0000015","completion":"0.000006"}},
            {"id":"openai/whisper-large-v3", "supported_parameters":["tools"]}
        ]});
        let models = parse_models("openrouter", None, &body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "openrouter/auto");
        assert!(models[0].recommended);
        assert_eq!(models[0].supports_tools, Some(true));
        assert_eq!(models[0].input_price_per_million, Some(1.5));
        assert_eq!(models[0].output_price_per_million, Some(6.0));
    }

    #[test]
    fn gemini_keeps_only_generate_content_and_normalizes_name() {
        let body = json!({"models": [
            {"name":"models/gemini-3.6-flash", "displayName":"Gemini 3.6 Flash", "supportedGenerationMethods":["generateContent"], "inputTokenLimit":1048576, "outputTokenLimit":65536},
            {"name":"models/gemini-embedding-2", "supportedGenerationMethods":["embedContent"]}
        ]});
        let models = parse_models("gemini", None, &body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-3.6-flash");
        assert_eq!(models[0].context_window, Some(1_048_576));
        assert!(models[0].recommended);
    }

    #[test]
    fn deprecated_provider_defaults_are_filtered() {
        let body = json!({"data": [
            {"id":"claude-3-5-sonnet-20241022"},
            {"id":"claude-sonnet-5", "max_input_tokens":1000000, "max_tokens":128000}
        ]});
        let models = parse_models("anthropic", None, &body);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-sonnet-5");
    }

    #[test]
    fn deepseek_legacy_aliases_are_filtered() {
        let body = json!({"data": [
            {"id":"deepseek-chat"},
            {"id":"deepseek-v4-flash"},
            {"id":"deepseek-v4-pro"}
        ]});
        let models = parse_models("deepseek", None, &body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "deepseek-v4-flash");
        assert!(models[0].recommended);
    }

    #[test]
    fn provider_requests_use_their_native_routes_and_auth() {
        let anthropic = models_request(
            "anthropic",
            "https://api.anthropic.com/v1",
            "secret",
            None,
            None,
            None,
            &[],
            Duration::from_secs(1),
            false,
        )
        .unwrap();
        assert!(anthropic.url().ends_with("/models?limit=1000"));
        assert_eq!(anthropic.header("x-api-key"), Some("secret"));
        assert_eq!(anthropic.header("anthropic-version"), Some("2023-06-01"));

        let gemini = chat_request(
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta",
            "secret",
            "models/gemini-3.6-flash",
            None,
            None,
            None,
            &[],
            Duration::from_secs(1),
            false,
        )
        .unwrap();
        assert!(gemini
            .url()
            .ends_with("/models/gemini-3.6-flash:generateContent"));
        assert_eq!(gemini.header("x-goog-api-key"), Some("secret"));

        let openrouter = models_request(
            "openrouter",
            "https://openrouter.ai/api/v1",
            "secret",
            None,
            None,
            None,
            &[],
            Duration::from_secs(1),
            false,
        )
        .unwrap();
        assert!(openrouter
            .url()
            .ends_with("/models?supported_parameters=tools"));
        assert_eq!(
            openrouter.header("X-OpenRouter-Title"),
            Some("Kodra")
        );

        let openrouter_key = openrouter_key_request(
            "https://openrouter.ai/api/v1",
            "secret",
            &[],
            Duration::from_secs(1),
        )
        .unwrap();
        assert!(openrouter_key.url().ends_with("/api/v1/key"));
        assert!(!openrouter_key.url().contains("secret"));

        let ollama =
            ollama_version_request("http://localhost:11434/v1", Duration::from_secs(1)).unwrap();
        assert_eq!(ollama.url(), "http://localhost:11434/api/version");
    }

    #[test]
    fn custom_provider_can_use_gemini_protocol_and_query_auth() {
        let request = chat_request(
            "custom",
            "https://gateway.example/v1beta/",
            "secret",
            "models/custom-gemini",
            Some("gemini_generate_content"),
            Some("query_key"),
            None,
            &[],
            Duration::from_secs(1),
            false,
        )
        .unwrap();
        assert_eq!(
            request.url(),
            "https://gateway.example/v1beta/models/custom-gemini:generateContent?key=secret"
        );

        let body = json!({"models": [{
            "name": "models/custom-gemini",
            "supportedGenerationMethods": ["generateContent"]
        }]});
        let models = parse_models("custom", Some("gemini_generate_content"), &body);
        assert_eq!(models[0].id, "custom-gemini");

        let stream = chat_stream_request(
            "custom",
            "https://gateway.example/v1beta/",
            "secret",
            "models/custom-gemini",
            Some("gemini_generate_content"),
            Some("query_key"),
            Some("models/custom-gemini:generateContent"),
            &[],
            Duration::from_secs(1),
            false,
        )
        .unwrap();
        assert_eq!(
            stream.url(),
            "https://gateway.example/v1beta/models/custom-gemini:streamGenerateContent?key=secret&alt=sse"
        );
    }

    #[test]
    fn custom_url_policy_blocks_unsafe_targets_by_default() {
        assert!(validate_custom_url("https://api.example.com/v1", false).is_ok());
        assert!(validate_custom_url("http://api.example.com/v1", false).is_err());
        assert!(validate_custom_url("http://localhost:11434/v1", false).is_err());
        assert!(validate_custom_url("http://localhost:11434/v1", true).is_ok());
        assert!(validate_custom_url("http://192.168.1.20:8080/v1", true).is_ok());
        assert!(validate_custom_url("https://user:pass@example.com/v1", false).is_err());
    }

    #[test]
    fn custom_headers_reject_auth_override_and_injection() {
        assert!(validate_headers(&[SecretHeader {
            name: "X-Tenant".to_string(),
            value: "workspace-42".to_string(),
        }])
        .is_ok());
        assert!(validate_headers(&[SecretHeader {
            name: "Authorization".to_string(),
            value: "Bearer secret".to_string(),
        }])
        .is_err());
        assert!(validate_headers(&[SecretHeader {
            name: "X-Tenant".to_string(),
            value: "ok\r\nInjected: true".to_string(),
        }])
        .is_err());
    }

    #[test]
    fn endpoint_override_cannot_escape_the_configured_host() {
        assert_eq!(
            safe_endpoint_path(Some("api/models"), "models").unwrap(),
            "api/models"
        );
        assert!(safe_endpoint_path(Some("https://evil.example/models"), "models").is_err());
        assert!(safe_endpoint_path(Some("../admin"), "models").is_err());
    }
}
