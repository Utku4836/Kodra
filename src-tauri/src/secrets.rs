use keyring::v1::{Entry, Error};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use zeroize::Zeroize;

const CREDENTIAL_SERVICE: &str = "com.utkui.cli-terminal-ui";
const SECRET_PREFIX: &str = "provider:";
static CREDENTIAL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBundle {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub headers: Vec<SecretHeader>,
}

impl Drop for SecretBundle {
    fn drop(&mut self) {
        self.api_key.zeroize();
        for header in &mut self.headers {
            header.value.zeroize();
        }
    }
}

pub fn provider_reference(provider_id: &str) -> Result<String, String> {
    let normalized = provider_id.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > 64
        || !normalized
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("Geçersiz provider kimliği".to_string());
    }
    Ok(format!("{}{}", SECRET_PREFIX, normalized))
}

pub fn validate_reference(secret_ref: &str) -> Result<(), String> {
    let provider = secret_ref
        .strip_prefix(SECRET_PREFIX)
        .ok_or_else(|| "Geçersiz secret reference".to_string())?;
    let expected = provider_reference(provider)?;
    if expected != secret_ref {
        return Err("Geçersiz secret reference".to_string());
    }
    Ok(())
}

fn entry(secret_ref: &str) -> Result<Entry, String> {
    validate_reference(secret_ref)?;
    Entry::new(CREDENTIAL_SERVICE, secret_ref)
        .map_err(|_| "Windows Credential Manager kullanılamıyor".to_string())
}

pub fn store(secret_ref: &str, bundle: &SecretBundle) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Credential Manager kilidi alınamadı".to_string())?;
    let payload = serde_json::to_string(bundle)
        .map_err(|_| "Güvenli kimlik bilgisi hazırlanamadı".to_string())?;
    entry(secret_ref)?
        .set_password(&payload)
        .map_err(|_| "Kimlik bilgisi Windows Credential Manager'a yazılamadı".to_string())
}

pub fn read(secret_ref: &str) -> Result<SecretBundle, String> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Credential Manager kilidi alınamadı".to_string())?;
    let payload = entry(secret_ref)?
        .get_password()
        .map_err(|_| "Kayıtlı kimlik bilgisi bulunamadı; providerı yeniden bağlayın".to_string())?;
    serde_json::from_str(&payload)
        .map_err(|_| "Kayıtlı kimlik bilgisi bozuk; providerı yeniden bağlayın".to_string())
}

pub fn delete(secret_ref: &str) -> Result<(), String> {
    let _guard = CREDENTIAL_LOCK
        .lock()
        .map_err(|_| "Credential Manager kilidi alınamadı".to_string())?;
    match entry(secret_ref)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(_) => Err("Kimlik bilgisi Windows Credential Manager'dan silinemedi".to_string()),
    }
}

pub fn exists(secret_ref: &str) -> bool {
    read(secret_ref).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_references_are_deterministic_and_scoped() {
        assert_eq!(provider_reference("OpenAI").unwrap(), "provider:openai");
        assert!(provider_reference("../../other").is_err());
        assert!(validate_reference("other-app:openai").is_err());
        assert!(validate_reference("provider:openai").is_ok());
    }

    #[test]
    fn secret_bundle_serialization_is_round_trip_safe() {
        let bundle = SecretBundle {
            api_key: "never-persist-this".to_string(),
            headers: vec![SecretHeader {
                name: "X-Tenant".to_string(),
                value: "private-tenant".to_string(),
            }],
        };
        let encoded = serde_json::to_string(&bundle).unwrap();
        let decoded: SecretBundle = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.api_key, "never-persist-this");
        assert_eq!(decoded.headers[0].value, "private-tenant");
    }
}
