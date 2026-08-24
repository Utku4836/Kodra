use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::Manager;

use crate::{providers, secrets};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppConfig {
    pub(crate) provider: String,
    #[serde(default, skip_serializing)]
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default = "default_mode")]
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) allow_list: Vec<String>,
    #[serde(default)]
    pub(crate) providers: Vec<LinkedProvider>,
    #[serde(default)]
    pub(crate) context_limit: Option<u64>,
    #[serde(default)]
    pub(crate) context_ratio: Option<f64>,
    #[serde(default)]
    pub(crate) max_output_tokens: Option<u64>,
    #[serde(default)]
    pub(crate) input_price_per_million: Option<f64>,
    #[serde(default)]
    pub(crate) output_price_per_million: Option<f64>,
    #[serde(default)]
    pub(crate) cached_input_price_per_million: Option<f64>,
    #[serde(default)]
    pub(crate) protocol: Option<String>,
    #[serde(default)]
    pub(crate) auth_scheme: Option<String>,
    #[serde(default)]
    pub(crate) secret_ref: Option<String>,
    #[serde(default)]
    pub(crate) models_path: Option<String>,
    #[serde(default)]
    pub(crate) chat_path: Option<String>,
    #[serde(default)]
    pub(crate) header_names: Vec<String>,
    #[serde(default)]
    pub(crate) request_timeout_secs: Option<u64>,
    #[serde(default)]
    pub(crate) allow_local_network: bool,
    #[serde(default)]
    pub(crate) thinking_mode: Option<String>,
    #[serde(default)]
    pub(crate) thinking_budget: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkedProvider {
    pub(crate) id: String,
    #[serde(default, skip_serializing)]
    pub(crate) api_key: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) protocol: Option<String>,
    #[serde(default)]
    pub(crate) auth_scheme: Option<String>,
    #[serde(default)]
    pub(crate) secret_ref: Option<String>,
    #[serde(default)]
    pub(crate) models_path: Option<String>,
    #[serde(default)]
    pub(crate) chat_path: Option<String>,
    #[serde(default)]
    pub(crate) header_names: Vec<String>,
    #[serde(default)]
    pub(crate) request_timeout_secs: Option<u64>,
    #[serde(default)]
    pub(crate) allow_local_network: bool,
    #[serde(default)]
    pub(crate) context_limit: Option<u64>,
    #[serde(default)]
    pub(crate) max_output_tokens: Option<u64>,
    #[serde(default)]
    pub(crate) input_price_per_million: Option<f64>,
    #[serde(default)]
    pub(crate) output_price_per_million: Option<f64>,
    #[serde(default)]
    pub(crate) cached_input_price_per_million: Option<f64>,
    #[serde(default)]
    pub(crate) thinking_mode: Option<String>,
    #[serde(default)]
    pub(crate) thinking_budget: Option<u64>,
}

pub(crate) fn default_mode() -> String {
    "smart".to_string()
}

pub(crate) fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Could not locate config directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create config directory: {error}"))?;
    Ok(dir.join("config.json"))
}

pub(crate) fn request_timeout(config: &AppConfig, fallback: u64) -> std::time::Duration {
    std::time::Duration::from_secs(
        config
            .request_timeout_secs
            .unwrap_or(fallback)
            .clamp(5, 120),
    )
}

pub(crate) fn write_sanitized_config(path: &Path, config: &AppConfig) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.new");
    fs::write(&temporary, raw).map_err(|error| format!("Could not prepare config: {error}"))?;
    fs::copy(&temporary, path).map_err(|error| format!("Could not save config: {error}"))?;
    let _ = fs::remove_file(temporary);
    Ok(())
}

fn linked_from_active(config: &AppConfig) -> LinkedProvider {
    LinkedProvider {
        id: config.provider.clone(),
        api_key: config.api_key.clone(),
        base_url: config.base_url.clone(),
        model: config.model.clone(),
        protocol: config.protocol.clone(),
        auth_scheme: config.auth_scheme.clone(),
        secret_ref: config.secret_ref.clone(),
        models_path: config.models_path.clone(),
        chat_path: config.chat_path.clone(),
        header_names: config.header_names.clone(),
        request_timeout_secs: config.request_timeout_secs,
        allow_local_network: config.allow_local_network,
        context_limit: config.context_limit,
        max_output_tokens: config.max_output_tokens,
        input_price_per_million: config.input_price_per_million,
        output_price_per_million: config.output_price_per_million,
        cached_input_price_per_million: config.cached_input_price_per_million,
        thinking_mode: config.thinking_mode.clone(),
        thinking_budget: config.thinking_budget,
    }
}

pub(crate) fn sync_active_provider(config: &mut AppConfig) {
    if let Some(provider) = config
        .providers
        .iter()
        .find(|item| item.id == config.provider)
    {
        config.api_key.clear();
        config.base_url = provider.base_url.clone();
        config.model = provider.model.clone();
        config.protocol = provider.protocol.clone();
        config.auth_scheme = provider.auth_scheme.clone();
        config.secret_ref = provider.secret_ref.clone();
        config.models_path = provider.models_path.clone();
        config.chat_path = provider.chat_path.clone();
        config.header_names = provider.header_names.clone();
        config.request_timeout_secs = provider.request_timeout_secs;
        config.allow_local_network = provider.allow_local_network;
        config.context_limit = provider.context_limit;
        config.max_output_tokens = provider.max_output_tokens;
        config.input_price_per_million = provider.input_price_per_million;
        config.output_price_per_million = provider.output_price_per_million;
        config.cached_input_price_per_million = provider.cached_input_price_per_million;
        config.thinking_mode = provider.thinking_mode.clone();
        config.thinking_budget = provider.thinking_budget;
    }
}

fn migrate_config_secrets(config: &mut AppConfig) -> Result<bool, String> {
    let mut changed = false;
    if !config.provider.is_empty()
        && !config
            .providers
            .iter()
            .any(|provider| provider.id == config.provider)
    {
        config.providers.push(linked_from_active(config));
        changed = true;
    }

    for provider in &mut config.providers {
        if !provider.api_key.is_empty() {
            let secret_ref = provider
                .secret_ref
                .clone()
                .unwrap_or(secrets::provider_reference(&provider.id)?);
            secrets::store(
                &secret_ref,
                &secrets::SecretBundle {
                    api_key: provider.api_key.clone(),
                    headers: Vec::new(),
                },
            )?;
            provider.secret_ref = Some(secret_ref);
            provider.api_key.clear();
            changed = true;
        }
    }

    if !config.api_key.is_empty() {
        if let Some(active) = config
            .providers
            .iter_mut()
            .find(|provider| provider.id == config.provider)
        {
            if active.secret_ref.is_none() {
                let secret_ref = secrets::provider_reference(&active.id)?;
                secrets::store(
                    &secret_ref,
                    &secrets::SecretBundle {
                        api_key: config.api_key.clone(),
                        headers: Vec::new(),
                    },
                )?;
                active.secret_ref = Some(secret_ref);
            }
        }
        config.api_key.clear();
        changed = true;
    }
    sync_active_provider(config);
    Ok(changed)
}

fn validate_and_clean_config(config: &mut AppConfig) -> bool {
    let mut changed = false;
    config.providers.retain(|provider| {
        let auth = provider.auth_scheme.as_deref().unwrap_or("bearer");
        if auth == "none" && provider.header_names.is_empty() {
            return true;
        }
        if let Some(secret_ref) = &provider.secret_ref {
            if secrets::exists(secret_ref) {
                return true;
            }
        }
        changed = true;
        false
    });
    if !config.provider.is_empty() {
        let auth = config.auth_scheme.as_deref().unwrap_or("bearer");
        let is_none_auth = auth == "none" && config.header_names.is_empty();
        if !is_none_auth {
            let has_secret = config
                .secret_ref
                .as_ref()
                .map(|reference| secrets::exists(reference))
                .unwrap_or(false);
            if !has_secret {
                config.provider.clear();
                config.model.clear();
                config.secret_ref = None;
                changed = true;
            }
        }
    }
    if config.provider.is_empty() && !config.providers.is_empty() {
        config.provider = config.providers[0].id.clone();
        sync_active_provider(config);
        changed = true;
    }
    changed
}

pub(crate) fn read_stored_config(app: &tauri::AppHandle) -> Result<Option<AppConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut config: AppConfig = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let mut changed = migrate_config_secrets(&mut config)?;
    if validate_and_clean_config(&mut config) {
        changed = true;
    }
    if changed {
        write_sanitized_config(&path, &config)?;
    }
    if config.provider.is_empty() && config.providers.is_empty() {
        return Ok(None);
    }
    Ok(Some(config))
}

pub(crate) fn save_stored_config(
    app: &tauri::AppHandle,
    config: &mut AppConfig,
) -> Result<(), String> {
    migrate_config_secrets(config)?;
    write_sanitized_config(&config_path(app)?, config)
}

pub(crate) fn resolve_secret(config: &AppConfig) -> Result<secrets::SecretBundle, String> {
    if !config.api_key.is_empty() {
        return Ok(secrets::SecretBundle {
            api_key: config.api_key.clone(),
            headers: Vec::new(),
        });
    }
    if let Some(secret_ref) = config.secret_ref.as_deref() {
        return secrets::read(secret_ref);
    }
    let auth = providers::effective_auth(&config.provider, config.auth_scheme.as_deref());
    if auth == providers::AuthScheme::None && config.header_names.is_empty() {
        return Ok(secrets::SecretBundle::default());
    }
    Err("Stored credentials were not found; reconnect the provider".to_string())
}
