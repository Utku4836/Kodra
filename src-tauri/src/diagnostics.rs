use crate::{providers, AppConfig, RateLimitInfo};
use serde::Serialize;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use url::Url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticCheck {
    id: String,
    title: String,
    state: String,
    detail: String,
    action: Option<String>,
    latency_ms: Option<u128>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAccountInfo {
    limit_usd: Option<f64>,
    remaining_usd: Option<f64>,
    usage_usd: Option<f64>,
    reset_at: Option<String>,
    tier: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderDiagnosticReport {
    provider_id: String,
    provider_name: String,
    overall: String,
    checked_at: u64,
    endpoint: String,
    protocol: String,
    requested_model: String,
    response_model: Option<String>,
    model_count: Option<usize>,
    recommended_model: Option<String>,
    deep_test: bool,
    error_kind: Option<String>,
    request_id: Option<String>,
    rate_limits: Option<RateLimitInfo>,
    account: Option<ProviderAccountInfo>,
    checks: Vec<DiagnosticCheck>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DiagnosticFault {
    kind: &'static str,
    state: &'static str,
    action: &'static str,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn endpoint_label(config: &AppConfig) -> String {
    let base = providers::normalize_base_url(&config.provider, &config.base_url);
    Url::parse(&base)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| "invalid endpoint".to_string())
}

fn response_request_id(response: &ureq::Response) -> Option<String> {
    ["x-request-id", "request-id", "cf-ray"]
        .iter()
        .find_map(|name| response.header(name))
        .map(|value| {
            value
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
                .take(128)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
}

fn json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    value
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str()?.parse::<f64>().ok())
        })
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn money(value: Option<f64>) -> String {
    value
        .map(|amount| format!("${amount:.4}"))
        .unwrap_or_else(|| "unlimited".to_string())
}

fn check(
    id: &str,
    title: &str,
    state: &str,
    detail: impl Into<String>,
    action: Option<&str>,
    latency_ms: Option<u128>,
) -> DiagnosticCheck {
    DiagnosticCheck {
        id: id.to_string(),
        title: title.to_string(),
        state: state.to_string(),
        detail: detail.into(),
        action: action.map(str::to_string),
        latency_ms,
    }
}

fn skipped(id: &str, title: &str, reason: &str) -> DiagnosticCheck {
    check(id, title, "skipped", reason, None, None)
}

fn classify_diagnostic_message(message: &str) -> DiagnosticFault {
    let lower = message.to_ascii_lowercase();
    if lower.contains("rate limit") || lower.contains("429") {
        DiagnosticFault {
            kind: "rate_limited",
            state: "rate_limited",
            action: "Wait for the rate-limit window to reset, then try again.",
        }
    } else if lower.contains("402")
        || lower.contains("insufficient credit")
        || lower.contains("yetersiz kredi")
    {
        DiagnosticFault {
            kind: "billing",
            state: "failed",
            action: "Check the provider balance or spending limit.",
        }
    } else if lower.contains("authentication")
        || lower.contains("credential")
        || lower.contains("yetki")
        || lower.contains("kimlik bilgisi")
        || lower.contains("401")
        || lower.contains("403")
    {
        DiagnosticFault {
            kind: "authentication",
            state: "failed",
            action: "Refresh the API key or provider authentication settings.",
        }
    } else if lower.contains("404") || lower.contains("bulunamad") {
        DiagnosticFault {
            kind: "not_found",
            state: "failed",
            action: "Check the model and endpoint path, then refresh the catalog.",
        }
    } else if lower.contains("zaman aş") || lower.contains("timeout") || lower.contains("timed out")
    {
        DiagnosticFault {
            kind: "timeout",
            state: "offline",
            action: "Check the network connection and provider timeout setting.",
        }
    } else if lower.contains("bağlantı hatası")
        || lower.contains("connection")
        || lower.contains("dns")
    {
        DiagnosticFault {
            kind: "network",
            state: "offline",
            action: "Check the network, DNS, and provider address.",
        }
    } else if lower.contains("498")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("server overloaded")
        || lower.contains("server error")
        || lower.contains("sunucu yükü")
        || lower.contains("sunucu hatası")
        || lower.contains("5xx")
    {
        DiagnosticFault {
            kind: "provider_unavailable",
            state: "offline",
            action: "Check the provider status and try again shortly.",
        }
    } else {
        DiagnosticFault {
            kind: "request",
            state: "failed",
            action: "Check the provider, model, protocol, and custom endpoint settings.",
        }
    }
}

fn diagnostic_chat_payload(config: &AppConfig) -> String {
    let protocol = providers::effective_protocol(&config.provider, config.protocol.as_deref());
    match protocol {
        providers::ProviderProtocol::AnthropicMessages => serde_json::json!({
            "model": config.model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "Reply OK."}]
        })
        .to_string(),
        providers::ProviderProtocol::GeminiGenerateContent => serde_json::json!({
            "contents": [{"role": "user", "parts": [{"text": "Reply OK."}]}],
            "generationConfig": {"maxOutputTokens": 1}
        })
        .to_string(),
        providers::ProviderProtocol::OpenAiChat => {
            let mut body = serde_json::json!({
                "model": config.model,
                "messages": [{"role": "user", "content": "Reply OK."}],
                "stream": false
            });
            if config.provider == "openai" {
                body["max_completion_tokens"] = serde_json::json!(1);
                body["store"] = serde_json::json!(false);
            } else {
                body["max_tokens"] = serde_json::json!(1);
            }
            body.to_string()
        }
    }
}

fn response_model(
    protocol: providers::ProviderProtocol,
    body: &serde_json::Value,
) -> Option<String> {
    match protocol {
        providers::ProviderProtocol::GeminiGenerateContent => {
            body.get("modelVersion").and_then(serde_json::Value::as_str)
        }
        _ => body.get("model").and_then(serde_json::Value::as_str),
    }
    .map(str::to_string)
}

fn overall_state(checks: &[DiagnosticCheck], error_kind: Option<&str>) -> String {
    if checks.iter().any(|entry| entry.state == "rate_limited") {
        return "rate_limited".to_string();
    }
    if checks.iter().any(|entry| entry.state == "offline") {
        return "offline".to_string();
    }
    if checks.iter().any(|entry| entry.state == "failed") {
        return "failed".to_string();
    }
    if error_kind.is_some() || checks.iter().any(|entry| entry.state == "degraded") {
        return "degraded".to_string();
    }
    "healthy".to_string()
}

fn run(config: AppConfig, deep: bool) -> ProviderDiagnosticReport {
    let info = providers::provider_info(&config.provider);
    let protocol = providers::effective_protocol(&config.provider, config.protocol.as_deref());
    let mut report = ProviderDiagnosticReport {
        provider_id: config.provider.clone(),
        provider_name: info.name.clone(),
        overall: "checking".to_string(),
        checked_at: now_ms(),
        endpoint: endpoint_label(&config),
        protocol: protocol.as_str().to_string(),
        requested_model: config.model.clone(),
        response_model: None,
        model_count: None,
        recommended_model: None,
        deep_test: deep,
        error_kind: None,
        request_id: None,
        rate_limits: None,
        account: None,
        checks: Vec::new(),
    };

    let secret = match crate::resolve_secret(&config) {
        Ok(secret) => {
            report.checks.push(check(
                "credentials",
                "Credentials",
                "healthy",
                "Provider credentials are available in the secure vault.",
                None,
                None,
            ));
            secret
        }
        Err(message) => {
            let fault = classify_diagnostic_message(&message);
            report.error_kind = Some(fault.kind.to_string());
            report.checks.push(check(
                "credentials",
                "Credentials",
                fault.state,
                message,
                Some(fault.action),
                None,
            ));
            report.checks.push(skipped(
                "models",
                "Model catalog",
                "Skipped because credentials could not be verified.",
            ));
            report.checks.push(skipped(
                "chat",
                "Chat endpoint",
                "Skipped because credentials could not be verified.",
            ));
            report.checks.push(skipped(
                "tools",
                "Tool support",
                "Provider connection could not be verified.",
            ));
            report.overall = overall_state(&report.checks, report.error_kind.as_deref());
            return report;
        }
    };

    match crate::build_models_request(&config, &secret) {
        Ok(_) => report.checks.push(check(
            "endpoint",
            "Endpoint",
            "healthy",
            format!("{} · {}", report.endpoint, report.protocol),
            None,
            None,
        )),
        Err(message) => {
            let fault = classify_diagnostic_message(&message);
            report.error_kind = Some(fault.kind.to_string());
            report.checks.push(check(
                "endpoint",
                "Endpoint",
                fault.state,
                message,
                Some(fault.action),
                None,
            ));
            report.checks.push(skipped(
                "models",
                "Model catalog",
                "Endpoint configuration is invalid.",
            ));
            report.checks.push(skipped(
                "chat",
                "Chat endpoint",
                "Endpoint configuration is invalid.",
            ));
            report.checks.push(skipped(
                "tools",
                "Tool support",
                "Endpoint configuration is invalid.",
            ));
            report.overall = overall_state(&report.checks, report.error_kind.as_deref());
            return report;
        }
    }

    let started = Instant::now();
    let model_result = (|| {
        let response = crate::call_with_retry(|| crate::build_models_request(&config, &secret))?;
        let rate_limits = crate::rate_limits_from_response(&response);
        let request_id = response_request_id(&response);
        let body = response.into_string().map_err(|error| error.to_string())?;
        let json: serde_json::Value =
            serde_json::from_str(&body).map_err(|error| error.to_string())?;
        let models = providers::parse_models(&config.provider, config.protocol.as_deref(), &json);
        Ok::<_, String>((models, rate_limits, request_id))
    })();
    let catalog_latency = started.elapsed().as_millis();

    let models = match model_result {
        Ok((models, rate_limits, request_id)) => {
            report.rate_limits = rate_limits;
            report.request_id = request_id;
            report.model_count = Some(models.len());
            report.recommended_model = providers::recommended_model(&config.provider, &models);
            report.checks.push(check(
                "authentication",
                "Provider authorization",
                "healthy",
                "The provider request passed authentication.",
                None,
                Some(catalog_latency),
            ));
            report.checks.push(check(
                "models",
                "Model catalog",
                if models.is_empty() {
                    "degraded"
                } else {
                    "healthy"
                },
                if models.is_empty() {
                    "The endpoint responded, but no model compatible with agent use was found."
                        .to_string()
                } else {
                    format!("{} current agent models verified.", models.len())
                },
                models
                    .is_empty()
                    .then_some("Check the provider catalog and model filters."),
                Some(catalog_latency),
            ));
            models
        }
        Err(message) => {
            let fault = classify_diagnostic_message(&message);
            report.error_kind = Some(fault.kind.to_string());
            report.checks.push(check(
                "authentication",
                "Provider authorization",
                fault.state,
                message.clone(),
                Some(fault.action),
                Some(catalog_latency),
            ));
            report.checks.push(skipped(
                "models",
                "Model catalog",
                "The catalog could not be read because the provider request failed.",
            ));
            report.checks.push(skipped(
                "chat",
                "Chat endpoint",
                "The model catalog could not be verified.",
            ));
            report.checks.push(skipped(
                "tools",
                "Tool support",
                "The model catalog could not be verified.",
            ));
            report.overall = overall_state(&report.checks, report.error_kind.as_deref());
            return report;
        }
    };

    if config.provider == "ollama" {
        let started = Instant::now();
        let version_result = crate::call_with_retry(|| {
            providers::ollama_version_request(&config.base_url, crate::request_timeout(&config, 8))
        })
        .and_then(|response| {
            response
                .into_json::<serde_json::Value>()
                .map_err(|error| error.to_string())
        });
        let latency = started.elapsed().as_millis();
        match version_result {
            Ok(body) => {
                let version = body
                    .get("version")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                report.checks.push(check(
                    "local_runtime",
                    "Ollama runtime",
                    "healthy",
                    format!("Local Ollama {version} is responding."),
                    None,
                    Some(latency),
                ));
            }
            Err(message) => report.checks.push(check(
                "local_runtime",
                "Ollama runtime",
                "degraded",
                message,
                Some("Make sure Ollama is running and check the local address."),
                Some(latency),
            )),
        }
    }

    if config.provider == "openrouter" {
        let started = Instant::now();
        let account_result = (|| {
            let response = crate::call_with_retry(|| {
                providers::openrouter_key_request(
                    &config.base_url,
                    &secret.api_key,
                    &secret.headers,
                    crate::request_timeout(&config, 12),
                )
            })?;
            let request_id = response_request_id(&response);
            let body = response
                .into_json::<serde_json::Value>()
                .map_err(|error| error.to_string())?;
            let data = body.get("data").unwrap_or(&body);
            let limit = json_number(data.get("limit"));
            let usage = json_number(data.get("usage"));
            let remaining = json_number(data.get("limit_remaining")).or_else(|| {
                limit
                    .zip(usage)
                    .map(|(limit, usage)| (limit - usage).max(0.0))
            });
            let reset_at = data
                .get("limit_reset")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let tier = data
                .get("is_free_tier")
                .and_then(serde_json::Value::as_bool)
                .map(|free| if free { "free" } else { "paid" }.to_string());
            Ok::<_, String>((
                ProviderAccountInfo {
                    limit_usd: limit,
                    remaining_usd: remaining,
                    usage_usd: usage,
                    reset_at,
                    tier,
                },
                request_id,
            ))
        })();
        let latency = started.elapsed().as_millis();
        match account_result {
            Ok((account, request_id)) => {
                report.request_id = report.request_id.or(request_id);
                let depleted = account
                    .remaining_usd
                    .is_some_and(|value| value <= f64::EPSILON);
                report.checks.push(check(
                    "account_limit",
                    "OpenRouter account",
                    if depleted { "degraded" } else { "healthy" },
                    format!(
                        "Remaining {} · usage {} · limit {}",
                        money(account.remaining_usd),
                        money(account.usage_usd),
                        money(account.limit_usd)
                    ),
                    depleted.then_some("Add credit or increase the account spending limit."),
                    Some(latency),
                ));
                report.account = Some(account);
            }
            Err(message) => {
                let fault = classify_diagnostic_message(&message);
                report.checks.push(check(
                    "account_limit",
                    "OpenRouter account",
                    "degraded",
                    message,
                    Some(fault.action),
                    Some(latency),
                ));
            }
        }
    }

    let selected_model = models.iter().find(|model| model.id == config.model);
    report.checks.push(check(
        "selected_model",
        "Selected model",
        if config.model.is_empty() || selected_model.is_none() {
            "degraded"
        } else {
            "healthy"
        },
        if config.model.is_empty() {
            "No model has been selected yet.".to_string()
        } else if selected_model.is_none() {
            format!("{} was not found in the current catalog.", config.model)
        } else {
            format!("{} is compatible with the current catalog.", config.model)
        },
        (config.model.is_empty() || selected_model.is_none())
            .then_some("Choose a current model with /model."),
        None,
    ));

    let tool_supported = info.capabilities.tools
        && selected_model
            .and_then(|model| model.supports_tools)
            .unwrap_or(true);
    report.checks.push(check(
        "tools",
        "Tool support",
        if tool_supported {
            "ready"
        } else {
            "unsupported"
        },
        if tool_supported {
            "The provider and model report tool-calling support."
        } else {
            "This provider/model combination does not report tool-calling support."
        },
        (!tool_supported).then_some("Choose another model that supports tools."),
        None,
    ));

    if !deep {
        report.checks.push(check(
            "chat",
            "Chat endpoint",
            "ready",
            "Configuration is ready. The billable probe only runs during a deep test.",
            None,
            None,
        ));
    } else if config.model.is_empty() {
        report.checks.push(skipped(
            "chat",
            "Chat endpoint",
            "Select a model before running a deep test.",
        ));
    } else {
        let started = Instant::now();
        let payload = diagnostic_chat_payload(&config);
        let chat_result = crate::send_with_retry(
            || {
                providers::chat_request(
                    &config.provider,
                    &config.base_url,
                    &secret.api_key,
                    &config.model,
                    config.protocol.as_deref(),
                    config.auth_scheme.as_deref(),
                    config.chat_path.as_deref(),
                    &secret.headers,
                    crate::request_timeout(&config, 20),
                    config.allow_local_network,
                )
            },
            &payload,
        );
        let chat_latency = started.elapsed().as_millis();
        match chat_result {
            Ok(response) => {
                report.request_id = response_request_id(&response).or(report.request_id);
                report.rate_limits = crate::rate_limits_from_response(&response)
                    .or_else(|| report.rate_limits.clone());
                match response.into_json::<serde_json::Value>() {
                    Ok(body) => {
                        report.response_model = response_model(protocol, &body);
                        report.checks.push(check(
                            "chat",
                            "Chat endpoint",
                            "healthy",
                            "The minimal live chat probe completed successfully.",
                            None,
                            Some(chat_latency),
                        ));
                    }
                    Err(error) => report.checks.push(check(
                        "chat",
                        "Chat endpoint",
                        "degraded",
                        format!(
                            "A response arrived, but its JSON could not be parsed: {}",
                            error
                        ),
                        Some("Check the provider protocol and endpoint settings."),
                        Some(chat_latency),
                    )),
                }
            }
            Err(message) => {
                let fault = classify_diagnostic_message(&message);
                report.error_kind = Some(fault.kind.to_string());
                report.checks.push(check(
                    "chat",
                    "Chat endpoint",
                    fault.state,
                    message,
                    Some(fault.action),
                    Some(chat_latency),
                ));
            }
        }
    }

    report.overall = overall_state(&report.checks, report.error_kind.as_deref());
    report
}

#[tauri::command]
pub(crate) async fn diagnose_provider(
    config: AppConfig,
    deep: Option<bool>,
) -> Result<ProviderDiagnosticReport, String> {
    tauri::async_runtime::spawn_blocking(move || run(config, deep.unwrap_or(false)))
        .await
        .map_err(|error| format!("Diagnostics worker error: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_faults_are_actionable_and_stable() {
        assert_eq!(
            classify_diagnostic_message("Rate limit (429)").kind,
            "rate_limited"
        );
        assert_eq!(
            classify_diagnostic_message("Yetki reddedildi (401)").kind,
            "authentication"
        );
        assert_eq!(
            classify_diagnostic_message("Bağlantı hatası: dns").state,
            "offline"
        );
        assert_eq!(
            classify_diagnostic_message("Bulunamadı (404)").kind,
            "not_found"
        );
        assert_eq!(
            classify_diagnostic_message("Provider sunucu hatası (500)").kind,
            "provider_unavailable"
        );
        assert_eq!(
            classify_diagnostic_message("Yetersiz kredi (402)").kind,
            "billing"
        );
        assert_eq!(
            classify_diagnostic_message("Upstream hatası (502)").state,
            "offline"
        );
    }

    #[test]
    fn endpoint_label_never_exports_path_or_query() {
        let config = AppConfig {
            provider: "custom".into(),
            api_key: String::new(),
            base_url: "https://example.test/private/v1?token=secret".into(),
            model: "model".into(),
            mode: "smart".into(),
            allow_list: Vec::new(),
            providers: Vec::new(),
            context_limit: None,
            context_ratio: None,
            max_output_tokens: None,
            input_price_per_million: None,
            output_price_per_million: None,
            cached_input_price_per_million: None,
            protocol: Some("openai_chat".into()),
            auth_scheme: Some("bearer".into()),
            secret_ref: None,
            models_path: None,
            chat_path: None,
            header_names: Vec::new(),
            request_timeout_secs: None,
            allow_local_network: false,
            thinking_mode: None,
            thinking_budget: None,
        };
        assert_eq!(endpoint_label(&config), "https://example.test");
    }

    #[test]
    fn deep_probe_payload_is_bounded_and_has_no_tools() {
        let mut config = AppConfig {
            provider: "openai".into(),
            api_key: String::new(),
            base_url: String::new(),
            model: "gpt-test".into(),
            mode: "smart".into(),
            allow_list: Vec::new(),
            providers: Vec::new(),
            context_limit: None,
            context_ratio: None,
            max_output_tokens: None,
            input_price_per_million: None,
            output_price_per_million: None,
            cached_input_price_per_million: None,
            protocol: None,
            auth_scheme: None,
            secret_ref: None,
            models_path: None,
            chat_path: None,
            header_names: Vec::new(),
            request_timeout_secs: None,
            allow_local_network: false,
            thinking_mode: None,
            thinking_budget: None,
        };
        let openai: serde_json::Value =
            serde_json::from_str(&diagnostic_chat_payload(&config)).unwrap();
        assert_eq!(openai["max_completion_tokens"], 1);
        assert!(openai.get("tools").is_none());

        config.provider = "anthropic".into();
        let anthropic: serde_json::Value =
            serde_json::from_str(&diagnostic_chat_payload(&config)).unwrap();
        assert_eq!(anthropic["max_tokens"], 1);

        config.provider = "gemini".into();
        let gemini: serde_json::Value =
            serde_json::from_str(&diagnostic_chat_payload(&config)).unwrap();
        assert_eq!(gemini["generationConfig"]["maxOutputTokens"], 1);
    }
}
