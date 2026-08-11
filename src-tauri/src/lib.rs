use std::fs;
use std::path::Path;
use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri::Manager;

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

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default)]
    allow_list: Vec<String>,
    #[serde(default)]
    providers: Vec<LinkedProvider>,
    #[serde(default)]
    context_limit: Option<u64>,
    #[serde(default)]
    context_ratio: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LinkedProvider {
    id: String,
    api_key: String,
    base_url: String,
    model: String,
}

fn default_mode() -> String {
    "smart".to_string()
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Config dizini bulunamadı: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Config dizini oluşturulamadı: {}", e))?;
    Ok(dir.join("config.json"))
}

/// Kayıtlı config'i döndürür (yoksa None)
#[tauri::command]
fn get_config(app: tauri::AppHandle) -> Result<Option<AppConfig>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut cfg: AppConfig = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    // Çoklu provider migrasyonu: providers boşsa ana provider'ı ekle
    if cfg.providers.is_empty() && !cfg.api_key.is_empty() {
        cfg.providers.push(LinkedProvider {
            id: cfg.provider.clone(),
            api_key: cfg.api_key.clone(),
            base_url: cfg.base_url.clone(),
            model: cfg.model.clone(),
        });
    }
    Ok(Some(cfg))
}

/// Config'i kaydeder
#[tauri::command]
fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let raw = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

/// Provider'a göre doğru auth başlığıyla models isteği kurar
fn build_models_request(config: &AppConfig) -> Result<ureq::Request, String> {
    let url = match config.provider.as_str() {
        "ollama" => format!("{}/api/tags", config.base_url),
        "gemini" => format!("{}/models?key={}", config.base_url, config.api_key),
        _ => format!("{}/models", config.base_url),
    };

    let mut req = ureq::get(&url).timeout(std::time::Duration::from_secs(12));

    match config.provider.as_str() {
        "anthropic" => {
            req = req
                .set("x-api-key", &config.api_key)
                .set("anthropic-version", "2023-06-01");
        }
        "ollama" | "gemini" => {}
        _ => {
            req = req.set("Authorization", &format!("Bearer {}", config.api_key));
        }
    }

    Ok(req)
}

/// API Key'i doğrular — provider'a göre /models isteği atar
#[tauri::command]
async fn validate_api_key(
    provider: String,
    api_key: String,
    base_url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config = AppConfig {
            provider,
            api_key,
            base_url,
            model: String::new(),
            mode: default_mode(),
            allow_list: Vec::new(),
            providers: Vec::new(),
            context_limit: None,
            context_ratio: None,
        };

        let resp = call_with_retry(|| build_models_request(&config))?;
        let body = resp.into_string().map_err(|e| e.to_string())?;

        // OpenAI-compatible: { "data": [...] } | Gemini: { "models": [...] }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(models) = json.get("data").and_then(|d| d.as_array()) {
                return Ok(format!("{} model bulundu", models.len()));
            }
            if let Some(models) = json.get("models").and_then(|d| d.as_array()) {
                return Ok(format!("{} model bulundu", models.len()));
            }
        }

        Ok("API key geçerli".to_string())
    })
    .await
    .map_err(|e| format!("İş parçacığı hatası: {}", e))?
}

/// Kayıtlı config'ten model listesini döndürür
#[tauri::command]
async fn list_models(config: AppConfig) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = call_with_retry(|| build_models_request(&config))?;
        let body = resp.into_string().map_err(|e| e.to_string())?;

        let json: serde_json::Value =
            serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let mut models = Vec::new();

        // OpenAI-compatible: { "data": [{ "id": "..." }] }
        if let Some(arr) = json.get("data").and_then(|d| d.as_array()) {
            for m in arr {
                if let Some(id) = m.get("id").and_then(|i| i.as_str()) {
                    models.push(id.to_string());
                }
            }
        }
        // Gemini: { "models": [{ "name": "..." }] } — "models/" öneki temizlenir
        else if let Some(arr) = json.get("models").and_then(|d| d.as_array()) {
            for m in arr {
                if let Some(name) = m.get("name").and_then(|i| i.as_str()) {
                    models.push(clean_gemini_model(name));
                }
            }
        }

        Ok(models)
    })
    .await
    .map_err(|e| format!("İş parçacığı hatası: {}", e))?
}

/// Mevcut çalışma dizinini döndürür
#[tauri::command]
fn pwd() -> String {
    std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "/".to_string())
}

/// Kullanıcı ev dizinini döndürür
#[tauri::command]
fn home() -> String {
    dirs_home()
}

/// Çalışma dizinini değiştirir
#[tauri::command]
fn change_dir(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    let path_obj = Path::new(&path);

    if !path_obj.exists() {
        return Err(format!("Yol bulunamadı: {}", path));
    }
    if !path_obj.is_dir() {
        return Err(format!("Dizin değil: {}", path));
    }

    std::env::set_current_dir(path_obj).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Bir sistem komutunu çalıştırır (eski /run komutu için — tool kullanmıyor)
#[tauri::command]
fn run_command(command: &str, args: Vec<String>) -> Result<CommandResult, String> {
    let output = Command::new(command)
        .args(&args)
        .output()
        .map_err(|e| format!("Komut çalıştırılamadı: {}", e))?;

    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// Uygulamayı kapatır
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// ~ ve . gibi kısaltmaları açar
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
struct NativeMessage {
    role: String, // system | user | assistant | tool
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_call_id: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallMsg>>,
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
struct ToolCallData {
    id: String,
    name: String,
    arguments: serde_json::Value,
    #[serde(rename = "thoughtSignature")]
    thought_signature: Option<String>,
}

#[derive(Serialize)]
struct ChatResult {
    text: String,
    tool_calls: Vec<ToolCallData>,
}

/// Native tool şemaları — OpenAI-compatible format (17 araç)
fn native_tools() -> serde_json::Value {
    serde_json::json!([
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
        {"type":"function","function":{"name":"spawn_sub_agent","description":"Delegates a complex subtask to an independent sub-agent and returns its report.","parameters":{"type":"object","properties":{"sub_task_prompt":{"type":"string","description":"Subtask description"},"model":{"type":"string","description":"Optional model override"},"timeout_seconds":{"type":"number","description":"Timeout in seconds"}},"required":["sub_task_prompt"]}}}
    ])
}

/// LLM chat isteği — provider'a göre uygun API'ye gönderir
/// Net hata mesajı — 429/404/503 özel açıklamalı
fn map_ureq_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let detail: String = resp.into_string().unwrap_or_default().chars().take(300).collect();
            match code {
                429 => "Rate limit (429) — birkaç dakika bekleyip tekrar deneyin".to_string(),
                503 => "Sunucu yükü (503) — biraz bekleyip tekrar deneyin".to_string(),
                404 => "Bulunamadı (404) — model geçersiz olabilir, /model ile başka seçin".to_string(),
                401 | 403 => "Yetki reddedildi — API key geçersiz olabilir".to_string(),
                _ => {
                    if detail.trim().is_empty() {
                        format!("HTTP {}", code)
                    } else {
                        format!("HTTP {}: {}", code, detail.trim())
                    }
                }
            }
        }
        ureq::Error::Transport(t) => format!("Bağlantı hatası: {}", t),
    }
}

/// 429: retry YOK (limit dolu — tekrar denemek pencereyi çifte tüketir).
/// 503 (sunucu yükü): 3sn bekleyip bir kez tekrar dener.
fn send_with_retry<F>(build: F, body: &str) -> Result<ureq::Response, String>
where
    F: Fn() -> ureq::Request,
{
    let send = |body: &str| build().send_string(body);
    match send(body) {
        Err(ureq::Error::Status(429, _)) => {
            std::thread::sleep(std::time::Duration::from_secs(3));
            Err("İstek limiti doldu (429) — lütfen pencere dolana kadar bekleyin".to_string())
        }
        Err(ureq::Error::Status(503, _)) => {
            std::thread::sleep(std::time::Duration::from_secs(3));
            send(body).map_err(map_ureq_err)
        }
        other => other.map_err(map_ureq_err),
    }
}

/// 429: retry YOK (çifte tüketim olmasın). 503: 3sn bekle, bir kez dene.
fn call_with_retry<F>(build: F) -> Result<ureq::Response, String>
where
    F: Fn() -> Result<ureq::Request, String>,
{
    let call = || -> Result<ureq::Response, String> {
        let req = build()?;
        req.call().map_err(map_ureq_err)
    };
    match call() {
        Err(e) if e.starts_with("Rate limit") => {
            std::thread::sleep(std::time::Duration::from_secs(3));
            Err(e)
        }
        Err(e) if e.starts_with("Sunucu yükü") => {
            std::thread::sleep(std::time::Duration::from_secs(3));
            call()
        }
        other => other,
    }
}

/// Gemini model adını temizler — "models/gemini-x" -> "gemini-x" (URL'de çift önek olmasın)
fn clean_gemini_model(model: &str) -> String {
    model.trim_start_matches("models/").to_string()
}

/// Blocking chat çağrısı — hem chat_completion hem sub-agent kullanır
/// Provider'a göre history dönüşümü — OpenAI-compatible
fn openai_messages(messages: &[NativeMessage]) -> Vec<serde_json::Value> {
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
                    serde_json::json!({
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
                    })
                } else {
                    serde_json::json!({
                        "role": "assistant",
                        "content": m.content.clone().unwrap_or_default()
                    })
                }
            }
            _ => serde_json::json!({
                "role": m.role,
                "content": m.content.clone().unwrap_or_default()
            }),
        })
        .collect()
}

/// Gemini history dönüşümü — tool_call_id → name eşleme ile
fn gemini_contents(messages: &[NativeMessage]) -> Vec<serde_json::Value> {
    // tool_call_id → name haritası (assistant tool_calls'tan)
    let mut id_to_name: std::collections::HashMap<String, String> = std::collections::HashMap::new();
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
            "system" => {} // system_instruction alanına ayrıca gider
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
                        // Gemini 3.x: functionCall'a id ekle; thoughtSignature PART seviyesinde gönderilir
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
                out.push(serde_json::json!({
                    "role": "user",
                    "parts": [{"text": m.content.clone().unwrap_or_default()}]
                }));
            }
        }
    }
    out
}

/// Anthropic history dönüşümü
fn anthropic_messages(messages: &[NativeMessage]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => {} // "system" alanına ayrıca gider
            "tool" => {
                out.push(serde_json::json!({
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": m.tool_call_id.clone().unwrap_or_default(), "content": m.content.clone().unwrap_or_default()}]
                }));
            }
            "assistant" => {
                let mut content = Vec::new();
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
                out.push(serde_json::json!({
                    "role": "user",
                    "content": m.content.clone().unwrap_or_default()
                }));
            }
        }
    }
    out
}

/// LLM chat isteği — native tool calling (provider'a göre payload)
fn chat_blocking(config: &AppConfig, messages: &[NativeMessage]) -> Result<ChatResult, String> {
    let provider = config.provider.as_str();
    let timeout = std::time::Duration::from_secs(45);
    let tools = native_tools();

    // System promptunu ayır (provider'a göre ayrı alana gider)
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

    let body = match provider {
        "anthropic" => serde_json::json!({
            "model": config.model,
            "max_tokens": 1024,
            "system": system_text,
            "tools": tools.as_array().unwrap_or(&Vec::new()).iter().map(|t| serde_json::json!({
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "input_schema": t["function"]["parameters"]
            })).collect::<Vec<_>>(),
            "messages": anthropic_messages(&non_system)
        })
        .to_string(),
        "gemini" => serde_json::json!({
            "contents": gemini_contents(&non_system),
            "system_instruction": {"parts": [{"text": system_text}]},
            "tools": {"functionDeclarations": tools.as_array().unwrap_or(&Vec::new()).iter().map(|t| serde_json::json!({
                "name": t["function"]["name"],
                "description": t["function"]["description"],
                "parameters": t["function"]["parameters"]
            })).collect::<Vec<_>>()}
        })
        .to_string(),
        _ => serde_json::json!({
            "model": config.model,
            "max_tokens": 1024,
            "tools": tools,
            "tool_choice": "auto",
            // OpenAI-uyumlular (NVIDIA, DeepSeek...): system dahil TÜM mesajlar
            // system role'u messages içinde gönderilir — filtreleme YOK
            "messages": openai_messages(messages)
        })
        .to_string(),
    };

    let build = || match provider {
        "anthropic" => ureq::post(&format!("{}/messages", config.base_url))
            .set("x-api-key", &config.api_key)
            .set("anthropic-version", "2023-06-01")
            .timeout(timeout),
        "gemini" => ureq::post(&format!(
            "{}/models/{}:generateContent?key={}",
            config.base_url,
            clean_gemini_model(&config.model),
            config.api_key
        ))
        .timeout(timeout),
        _ => ureq::post(&format!("{}/chat/completions", config.base_url))
            .set("Authorization", &format!("Bearer {}", config.api_key))
            .timeout(timeout),
    };

    let resp = send_with_retry(build, &body)?;
    let out: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;

    // Yanıtı parse et — metin + tool_calls
    let mut text = String::new();
    let mut tool_calls: Vec<ToolCallData> = Vec::new();

    match provider {
        "anthropic" => {
            if let Some(content) = out.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                    if let Some(tu) = block.get("type").and_then(|v| v.as_str()) {
                        if tu == "tool_use" {
                            tool_calls.push(ToolCallData {
                                id: block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                name: block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                                arguments: block.get("input").cloned().unwrap_or(serde_json::json!({})),
                                thought_signature: None,
                            });
                        }
                    }
                }
            }
        }
        "gemini" => {
            if let Some(parts) = out.pointer("/candidates/0/content/parts").and_then(|p| p.as_array()) {
                for part in parts {
                    if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                        text.push_str(t);
                    }
                    if let Some(fc) = part.get("functionCall") {
                        // D?KKAT: thoughtSignature functionCall'?n ???NDE de?il ?
                        // part seviyesinde (functionCall ile ayn? hizada)
                        tool_calls.push(ToolCallData {
                            id: fc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            name: fc.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            arguments: fc.get("args").cloned().unwrap_or(serde_json::json!({})),
                            thought_signature: part
                                .get("thoughtSignature")
                                .and_then(|v| v.as_str())
                                .map(String::from),
                        });
                    }
                }
            }
        }
        _ => {
            if let Some(msg) = out.pointer("/choices/0/message") {
                if let Some(t) = msg.get("content").and_then(|v| v.as_str()) {
                    text.push_str(t);
                }
                if let Some(tcs) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                    for tc in tcs {
                        let name = tc.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let args_str = tc.pointer("/function/arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                        let arguments = serde_json::from_str(args_str)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        tool_calls.push(ToolCallData {
                            id: tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            name,
                            arguments,
                            thought_signature: None,
                        });
                    }
                }
            }
        }
    }

    Ok(ChatResult { text, tool_calls })
}

/// Async + spawn_blocking: uzun LLM yanıtı UI thread'ini bloklamaz
#[tauri::command]
async fn chat_completion(
    config: AppConfig,
    messages: Vec<NativeMessage>,
) -> Result<ChatResult, String> {
    tauri::async_runtime::spawn_blocking(move || chat_blocking(&config, &messages))
        .await
        .map_err(|e| format!("İş parçacığı hatası: {}", e))?
}

// ============================================================
// FAZ 3 — PERMISSION ENGINE + TOOL REGISTRY
// ============================================================

/// Tool risk seviyesi
fn tool_risk(tool_id: &str) -> &'static str {
    match tool_id {
        "read_file" | "list_dir" | "search_code" | "glob_files" | "web_fetch" | "analyze_codebase" => "low",
        "write_file" | "edit_file" | "create_dir" | "apply_diff" | "manage_memory" | "browser_automation" | "spawn_sub_agent" => "medium",
        "delete_file" | "execute_command" | "manage_background_process" | "github_action" => "high",
        _ => "medium",
    }
}

/// Yıkıcı komut tespiti — her koşulda reddedilir
fn destructive_check(tool_id: &str, params: &serde_json::Value) -> Option<String> {
    if tool_id != "execute_command" {
        return None;
    }
    let cmd = params
        .get("cmd")
        .or_else(|| params.get("command"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let lc = cmd.to_lowercase().trim().to_string();

    // Kesin engel listesi
    let hard_blocks = [
        "rm -rf /",
        "rm -rf /*",
        "rm -rf c:",
        "rd /s /q c:",
        "del /f /s /q",
        "del /f /q c:\\windows",
        "diskpart",
        "mkfs",
        "fdisk",
        "chmod -r 777",
        "chmod 777 /",
        "remove-item -recurse",
        "remove-item -force -recurse",
        ":(){",
        "reg delete",
        "shutdown",
        "reboot",
        "format c:",
        "format d:",
        "format /q",
        "cipher /w",
    ];
    for p in hard_blocks {
        if lc.contains(p) {
            return Some(format!("Yıkıcı komut engellendi: {}", p));
        }
    }
    // "format" tam komut olarak (Format-Table gibi zararsızları yakalamaz)
    if lc == "format" || lc.starts_with("format ") {
        return Some("format komutu engellendi".to_string());
    }
    // Çıplak rm -rf (herhangi bir yol)
    if lc.contains("rm -rf") {
        return Some("rm -rf engellendi".to_string());
    }
    None
}

/// Kritik yol koruması — mod ne olursa olsun onay gerektirir
fn critical_path_check(tool_id: &str, params: &serde_json::Value) -> bool {
    // Okuma işlemleri serbest
    if matches!(tool_id, "read_file" | "list_dir" | "search_code") {
        return false;
    }
    // Parametrelerdeki path değerlerini tara
    let mut paths: Vec<String> = Vec::new();
    if let Some(p) = params.get("path").and_then(|v| v.as_str()) {
        paths.push(p.to_string());
    }
    if let Some(p) = params.get("old").and_then(|v| v.as_str()) {
        paths.push(p.to_string());
    }
    if let Some(p) = params.get("new").and_then(|v| v.as_str()) {
        paths.push(p.to_string());
    }
    if let Some(p) = params.get("cmd").and_then(|v| v.as_str()) {
        paths.push(p.to_string());
    }

    let critical_segments = [
        ".env",
        "node_modules",
        "\\.git",
        "\\windows\\",
        "/windows/",
        "program files",
        "/etc/",
        "/usr/",
        ".ssh",
        "appdata",
        "system32",
        "\\boot\\",
        "/boot/",
        "config.json",
    ];

    for p in &paths {
        let lower = p.to_lowercase();
        for seg in critical_segments {
            if lower.contains(seg) {
                return true;
            }
        }
    }
    false
}

/// Allow list anahtarı — tool + parametre bazlı
fn tool_allow_key(tool_id: &str, params: &serde_json::Value) -> String {
    // Komut için ilk kelime + tool; dosya için path kısa hali
    if tool_id == "execute_command" {
        let cmd = params
            .get("cmd")
            .or_else(|| params.get("command"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let first = cmd.split_whitespace().next().unwrap_or("").to_lowercase();
        format!("{}:{}", tool_id, first)
    } else {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        format!("{}:{}", tool_id, path)
    }
}

#[derive(Serialize)]
struct ToolCheckResult {
    decision: String, // "allow" | "approve" | "deny"
    risk: String,     // "low" | "medium" | "high"
    reason: String,
}

/// Tool çağrısını mod + kurallara göre değerlendirir (JS onay modalı öncesi)
#[tauri::command]
fn check_tool(
    config: AppConfig,
    tool_id: String,
    params: serde_json::Value,
) -> Result<ToolCheckResult, String> {
    let risk = tool_risk(&tool_id).to_string();

    // 1) Yıkıcı komut — derhal reddet
    if let Some(reason) = destructive_check(&tool_id, &params) {
        return Ok(ToolCheckResult {
            decision: "deny".into(),
            risk: "high".into(),
            reason,
        });
    }

    // 2) Kritik yol — mod ne olursa olsun onay (allow_list bile bypass edemez)
    let critical = critical_path_check(&tool_id, &params);
    if critical {
        return Ok(ToolCheckResult {
            decision: "approve".into(),
            risk,
            reason: "Kritik sistem yolu — onay zorunlu".into(),
        });
    }

    // 3) Kalıcı allow list
    let key = tool_allow_key(&tool_id, &params);
    if config.allow_list.contains(&key) {
        return Ok(ToolCheckResult {
            decision: "allow".into(),
            risk,
            reason: "Kalıcı izinli".into(),
        });
    }

    // 4) Mod bazlı karar
    let decision = match config.mode.as_str() {
        "autonomous" => "allow",
        "strict" => {
            if risk == "low" {
                "allow"
            } else {
                "approve"
            }
        }
        _ => {
            // smart (varsayılan)
            if risk == "low" {
                "allow"
            } else {
                "approve"
            }
        }
    };

    Ok(ToolCheckResult {
        decision: decision.into(),
        risk,
        reason: if decision == "allow" {
            "Düşük risk — otomatik".into()
        } else {
            "Onay gerekiyor".into()
        },
    })
}

// ---- /undo geri alma — dosya değişiklikleri öncesi snapshot ----

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

/// Son yapılan dosya değişikliğini geri alır (/undo)
#[tauri::command]
fn undo_last() -> Result<String, String> {
    let manifest_path = format!("{}/.agent/undo/undo_manifest.json", dirs_home());
    let raw = fs::read_to_string(&manifest_path)
        .map_err(|_| "Geri alınacak işlem yok".to_string())?;
    let mut entries: Vec<serde_json::Value> =
        serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let last = entries.pop().ok_or("Geri alınacak işlem yok")?;
    let original = last["original"].as_str().unwrap_or("").to_string();
    let backup = last["backup"].as_str().unwrap_or("").to_string();
    if original.is_empty() || backup.is_empty() {
        return Err("Snapshot kaydı bozuk".into());
    }
    fs::copy(&backup, &original).map_err(|e| format!("Geri alınamadı: {}", e))?;
    let _ = fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&entries).unwrap_or_default(),
    );
    Ok(format!("Geri alındı: {}", original))
}

// ---- Tool uygulamaları ----

fn tool_write_file(path: &str, content: &str) -> Result<String, String> {
    let path = expand_path(path);
    snapshot_file(&path);
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content)
        .map_err(|e| format!("{} yazılamadı: {}", path, e))?;
    Ok(format!("{} yazıldı ({} byte)", path, content.len()))
}

fn tool_edit_file(path: &str, old: &str, new: &str) -> Result<String, String> {
    let path = expand_path(path);
    snapshot_file(&path);
    let content = fs::read_to_string(&path).map_err(|e| format!("{} okunamadı: {}", path, e))?;
    if !content.contains(old) {
        return Err(format!("Aranan metin {} dosyasında bulunamadı", path));
    }
    let updated = content.replacen(old, new, 1);
    fs::write(&path, updated).map_err(|e| format!("{} yazılamadı: {}", path, e))?;
    Ok(format!("{} düzenlendi", path))
}

fn tool_create_dir(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    fs::create_dir_all(&path).map_err(|e| format!("{} oluşturulamadı: {}", path, e))?;
    Ok(format!("{} oluşturuldu", path))
}

fn tool_delete_file(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    let p = Path::new(&path);
    snapshot_file(&path);
    if !p.exists() {
        return Err(format!("Yol bulunamadı: {}", path));
    }
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())?;
        Ok(format!("{} klasörü silindi", path))
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())?;
        Ok(format!("{} silindi", path))
    }
}

fn tool_search_code(path: &str, pattern: &str) -> Result<serde_json::Value, String> {
    let path = expand_path(path);
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("Dizin bulunamadı: {}", path));
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
                // Sadece metin dosyaları dene
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
// FAZ 4 — GENİŞLETİLMİŞ TOOL EKOSİSTEMİ
// ============================================================

use std::io::{BufRead, BufReader, Read};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

/// Basit glob eşleştirici — *, **, ? destekler
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

/// glob deseni ile dosya bulma — node_modules/.git/target atlanır
fn tool_glob_files(pattern: &str) -> Result<Vec<String>, String> {
    // Pattern'deki ilk dizin segmentini kök olarak al
    let (root, pat) = if pattern.contains('/') || pattern.contains('\\') {
        let sep = if pattern.contains('\\') { '\\' } else { '/' };
        let idx = pattern.find(sep).unwrap();
        let root = &pattern[..idx];
        let pat = &pattern[idx + 1..];
        (if root.is_empty() { ".".to_string() } else { root.to_string() }, pat.to_string())
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

/// Basit HTML -> Markdown dönüştürücü
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
                    // İçeriği atla
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
    // Çoklu boş satırları sadeleştir
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

/// web_fetch — URL içeriğini çeker, markdown'a çevirir
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
        return Err(format!("Dizin bulunamadı: {}", path));
    }
    // Diff'i geçici dosyaya yaz
    let tmp = std::env::temp_dir().join(format!("diff_{}.patch", std::process::id()));
    fs::write(&tmp, diff_content).map_err(|e| e.to_string())?;
    let output = Command::new("git")
        .current_dir(dir)
        .args(["apply", "--whitespace=nowarn"])
        .arg(&tmp)
        .output()
        .map_err(|e| format!("git bulunamadı: {}", e))?;
    let _ = fs::remove_file(&tmp);
    if output.status.success() {
        Ok("Yama başarıyla uygulandı".to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// analyze_codebase — sembol analizi (grep tabanlı)
fn tool_analyze_codebase(symbol: &str, kind: &str, path: &str) -> Result<serde_json::Value, String> {
    let root = expand_path(path);
    let root = Path::new(&root);
    if !root.is_dir() {
        return Err(format!("Dizin bulunamadı: {}", root.display()));
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
                            (l.starts_with("fn ") || l.starts_with("function ") || l.starts_with("class ")
                                || l.starts_with("def ") || l.starts_with("const ") || l.starts_with("let ") || l.starts_with("pub fn "))
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
        // Dizin ağacı (2 seviye)
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
                Ok("(hafıza boş)".to_string())
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
            Ok(format!("Hafızaya eklendi: {} → {}", key, value))
        }
        "clear" => {
            if Path::new(&path).exists() {
                fs::remove_file(&path).map_err(|e| e.to_string())?;
            }
            Ok("Hafıza temizlendi".to_string())
        }
        _ => Err("geçersiz action — read / add / clear".into()),
    }
}

/// Edge tarayıcı yolunu bul
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
fn tool_browser_automation(action: &str, url: &str, selector: &str) -> Result<String, String> {
    let edge = find_edge().ok_or("Edge bulunamadı")?;
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
            let out_path = std::env::temp_dir().join(format!("browser_shot_{}.png", std::process::id()));
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
                Ok(format!("Ekran görüntüsü: {}", out_str))
            } else {
                Err("Ekran görüntüsü alınamadı".into())
            }
        }
        "click" | "type" => Err(format!(
            "{} şu an desteklenmiyor — navigate / extract_text / take_screenshot kullanın",
            action
        )),
        _ => Err("geçersiz action".into()),
    }
}

/// github_action — git + gh CLI
fn tool_github_action(action: &str, message: &str, branch: &str) -> Result<String, String> {
    match action {
        "commit" => {
            let add = Command::new("git").args(["add", "-A"]).output().map_err(|e| e.to_string())?;
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
                .map_err(|e| format!("gh bulunamadı: {}", e))?;
            if pr.status.success() {
                Ok(String::from_utf8_lossy(&pr.stdout).to_string())
            } else {
                Err(String::from_utf8_lossy(&pr.stderr).to_string())
            }
        }
        "view_issues" => {
            let out = Command::new("gh").args(["issue", "list"]).output().map_err(|e| e.to_string())?;
            Ok(String::from_utf8_lossy(&out.stdout).to_string())
        }
        "repo_status" => {
            let status = Command::new("git").args(["status", "--short"]).output().map_err(|e| e.to_string())?;
            let mut out = String::from_utf8_lossy(&status.stdout).to_string();
            if let Ok(repo) = Command::new("gh").args(["repo", "view", "--json", "nameWithOwner"]).output() {
                out.push_str(&String::from_utf8_lossy(&repo.stdout));
            }
            if branch.is_empty() {
                if let Ok(b) = Command::new("git").args(["branch", "--show-current"]).output() {
                    out.push_str(&format!("\nbranch: {}", String::from_utf8_lossy(&b.stdout).trim()));
                }
            }
            Ok(out)
        }
        _ => Err("geçersiz action — commit / create_pr / view_issues / repo_status".into()),
    }
}

// ---- Arka plan süreç yönetimi ----
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
            let p = procs.get_mut(process_id).ok_or("Süreç bulunamadı")?;
            let _ = p.child.kill();
            Ok(serde_json::json!({ "process_id": process_id, "status": "stopped" }))
        }
        "status" => {
            let p = procs.get_mut(process_id).ok_or("Süreç bulunamadı")?;
            if let Some(status) = p.child.try_wait().map_err(|e| e.to_string())? {
                Ok(serde_json::json!({ "process_id": process_id, "status": "exited", "code": status.code() }))
            } else {
                Ok(serde_json::json!({ "process_id": process_id, "status": "running" }))
            }
        }
        "logs" => {
            let p = procs.get(process_id).ok_or("Süreç bulunamadı")?;
            let logs = p.log.lock().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "logs": logs.iter().rev().take(50).cloned().collect::<Vec<_>>() }))
        }
        _ => Err("geçersiz action — start / stop / status / logs".into()),
    }
}

/// Tool'u çalıştırır — güvenlik kontrollü (JS onayı ile birlikte çalışır)
#[tauri::command]
async fn execute_approved_tool(
    config: AppConfig,
    tool_id: String,
    params: serde_json::Value,
    approved: bool,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
    // Güvenlik katmanı 1: yıkıcı komut — approved olsa bile reddet
    if let Some(reason) = destructive_check(&tool_id, &params) {
        return Err(reason);
    }
    // Güvenlik katmanı 2: izin kontrolü
    let critical = critical_path_check(&tool_id, &params);
    let risk = tool_risk(&tool_id);
    let key = tool_allow_key(&tool_id, &params);
    let in_allow = config.allow_list.contains(&key);
    let mode = config.mode.as_str();

    let auto_allow = risk == "low" || mode == "autonomous";
    let authorized = approved || in_allow || auto_allow;
    if critical && !in_allow && !approved {
        return Err("Kritik yol — onay gerekli".into());
    }
    if !authorized {
        return Err("İzin yok — onay gerekli".into());
    }

    // Tool'u çalıştır
    match tool_id.as_str() {
        "read_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path gerekli")?;
            let content = read_file_inner(path)?;
            // Satır numaralı + aralık desteği
            let start = params.get("start_line").and_then(|v| v.as_u64()).unwrap_or(1).max(1) as usize;
            let end = params.get("end_line").and_then(|v| v.as_u64()).map(|v| v as usize);
            let lines: Vec<&str> = content.lines().collect();
            let total = lines.len();
            let end = end.unwrap_or(total).min(total);
            let mut numbered = String::new();
            for (i, line) in lines.iter().enumerate().skip(start - 1).take(end.saturating_sub(start - 1)) {
                numbered.push_str(&format!("{:>5} | {}\n", i + 1, line));
            }
            Ok(serde_json::json!({
                "content": numbered,
                "path": expand_path(path),
                "total_lines": total
            }))
        }
        "list_dir" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or(".");
            let entries = list_dir_inner(path)?;
            Ok(serde_json::json!({ "entries": entries }))
        }
        "search_code" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or(".");
            let pattern = params
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or("pattern gerekli")?;
            tool_search_code(path, pattern)
        }
        "glob_files" => {
            let pattern = params
                .get("pattern")
                .and_then(|v| v.as_str())
                .ok_or("pattern gerekli")?;
            let files = tool_glob_files(pattern)?;
            Ok(serde_json::json!({ "files": files, "total": files.len() }))
        }
        "write_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path gerekli")?;
            let content = params
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("content gerekli")?;
            let msg = tool_write_file(path, content)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "edit_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path gerekli")?;
            let old = params
                .get("old_string")
                .or_else(|| params.get("old"))
                .and_then(|v| v.as_str())
                .ok_or("old_string gerekli")?;
            let new = params
                .get("new_string")
                .or_else(|| params.get("new"))
                .and_then(|v| v.as_str())
                .ok_or("new_string gerekli")?;
            let msg = tool_edit_file(path, old, new)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "apply_diff" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path gerekli")?;
            let diff = params
                .get("diff_content")
                .and_then(|v| v.as_str())
                .ok_or("diff_content gerekli")?;
            let msg = tool_apply_diff(path, diff)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "create_dir" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path gerekli")?;
            let msg = tool_create_dir(path)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "delete_file" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path gerekli")?;
            let msg = tool_delete_file(path)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "execute_command" => {
            let cmd = params
                .get("cmd")
                .or_else(|| params.get("command"))
                .and_then(|v| v.as_str())
                .ok_or("cmd gerekli")?
                .trim()
                .trim_matches('"')
                .trim_matches('\'');
            let timeout_ms = params.get("timeout").and_then(|v| v.as_u64()).unwrap_or(30000);

            // Windows: cmd /C + timeout desteği (çıktı ayrı thread'de okunur)
            let mut child = Command::new("cmd")
                .args(["/C", cmd])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|e| format!("Komut çalıştırılamadı: {}", e))?;

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
                    return Err(format!("Komut zaman aşımı ({}ms)", timeout_ms));
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
            let action = params.get("action").and_then(|v| v.as_str()).ok_or("action gerekli")?;
            let command = params.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let process_id = params.get("process_id").and_then(|v| v.as_str()).unwrap_or("");
            tool_background_process(pm(), action, command, process_id)
        }
        "web_fetch" => {
            let url = params.get("url").and_then(|v| v.as_str()).ok_or("url gerekli")?;
            let md = tool_web_fetch(url)?;
            Ok(serde_json::json!({ "content": md, "url": url }))
        }
        "browser_automation" => {
            let action = params.get("action").and_then(|v| v.as_str()).ok_or("action gerekli")?;
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let selector = params.get("selector").and_then(|v| v.as_str()).unwrap_or("");
            let msg = tool_browser_automation(action, url, selector)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "github_action" => {
            let action = params.get("action").and_then(|v| v.as_str()).ok_or("action gerekli")?;
            let message = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
            let branch = params.get("branch").and_then(|v| v.as_str()).unwrap_or("");
            let msg = tool_github_action(action, message, branch)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "analyze_codebase" => {
            let symbol = params.get("symbol").and_then(|v| v.as_str()).unwrap_or("");
            let kind = params.get("type").and_then(|v| v.as_str()).unwrap_or("references");
            let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            tool_analyze_codebase(symbol, kind, path)
        }
        "manage_memory" => {
            let action = params.get("action").and_then(|v| v.as_str()).ok_or("action gerekli")?;
            let key = params.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = params.get("value").and_then(|v| v.as_str()).unwrap_or("");
            let msg = tool_manage_memory(action, key, value)?;
            Ok(serde_json::json!({ "message": msg }))
        }
        "spawn_sub_agent" => {
            let sub_task = params
                .get("sub_task_prompt")
                .and_then(|v| v.as_str())
                .ok_or("sub_task_prompt gerekli")?;
            let model = params.get("model").and_then(|v| v.as_str()).unwrap_or(&config.model);
            let timeout_seconds = params.get("timeout_seconds").and_then(|v| v.as_u64()).unwrap_or(60);

            let mut sub_config = config.clone();
            if !model.is_empty() {
                sub_config.model = model.to_string();
            }
            let msg = NativeMessage {
                role: "user".to_string(),
                content: Some(sub_task.to_string()),
                tool_call_id: None,
                tool_calls: None,
            };
            // spawn_blocking içindeyiz — direkt blocking çağrı yap
            let reply = chat_blocking(&sub_config, &[msg])?;
            Ok(serde_json::json!({
                "sub_agent_reply": reply.text.chars().take(3000).collect::<String>(),
                "timeout_seconds": timeout_seconds
            }))
        }
        _ => Err(format!("Bilinmeyen tool: {}", tool_id)),
    }
    })
    .await
    .map_err(|e| format!("İş parçacığı hatası: {}", e))?
}

/// read_file iç implementasyonu (tool + eski komut için ortak)
fn read_file_inner(path: &str) -> Result<String, String> {
    let path = expand_path(path);
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Dosya bulunamadı: {}", path));
    }
    if p.is_dir() {
        return Err(format!("Dizin, dosya değil: {}", path));
    }
    fs::read_to_string(p).map_err(|e| e.to_string())
}

/// list_dir iç implementasyonu (tool + eski komut için ortak)
fn list_dir_inner(path: &str) -> Result<Vec<DirEntry>, String> {
    let path = expand_path(path);
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Yol bulunamadı: {}", path));
    }
    if !p.is_dir() {
        return Err(format!("Dizin değil: {}", path));
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

/// Eski pwd/list_dir/read_file komutlarını tool implementasyonlarına bağla
#[tauri::command]
fn list_dir(path: &str) -> Result<Vec<DirEntry>, String> {
    list_dir_inner(path)
}

#[tauri::command]
fn read_file(path: &str) -> Result<String, String> {
    read_file_inner(path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pwd,
            home,
            change_dir,
            list_dir,
            read_file,
            run_command,
            quit_app,
            get_config,
            save_config,
            validate_api_key,
            list_models,
            chat_completion,
            check_tool,
            execute_approved_tool,
            undo_last,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
