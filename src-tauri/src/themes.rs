use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const MAX_THEME_FILES: usize = 32;
const MAX_THEME_BYTES: u64 = 128 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLoadError {
    file_name: String,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeLoadReport {
    directory: String,
    themes: Vec<Value>,
    errors: Vec<ThemeLoadError>,
}

fn theme_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("themes"))
        .map_err(|error| format!("Could not resolve the theme directory: {error}"))
}

fn safe_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("theme.json")
        .chars()
        .take(96)
        .collect()
}

fn read_theme_manifests(directory: &Path) -> Result<(Vec<Value>, Vec<ThemeLoadError>), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the theme directory: {error}"))?;
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not read the theme directory: {error}"))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    let mut themes = Vec::new();
    let mut errors = Vec::new();
    for entry in entries.into_iter().take(MAX_THEME_FILES) {
        let path = entry.path();
        let is_json = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"));
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !file_type.is_file() || !is_json {
            continue;
        }

        let file_name = safe_file_name(&path);
        let size = match entry.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                errors.push(ThemeLoadError {
                    file_name,
                    reason: format!("Could not read metadata: {error}"),
                });
                continue;
            }
        };
        if size > MAX_THEME_BYTES {
            errors.push(ThemeLoadError {
                file_name,
                reason: format!("Theme exceeds the {} KiB limit", MAX_THEME_BYTES / 1024),
            });
            continue;
        }

        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                errors.push(ThemeLoadError {
                    file_name,
                    reason: format!("Could not read theme: {error}"),
                });
                continue;
            }
        };
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(object)) => themes.push(Value::Object(object)),
            Ok(_) => errors.push(ThemeLoadError {
                file_name,
                reason: "Theme root must be a JSON object".to_string(),
            }),
            Err(error) => errors.push(ThemeLoadError {
                file_name,
                reason: format!("Invalid JSON: {error}"),
            }),
        }
    }
    Ok((themes, errors))
}

#[tauri::command]
pub fn list_user_themes(app: tauri::AppHandle) -> Result<ThemeLoadReport, String> {
    let directory = theme_dir(&app)?;
    let (themes, errors) = read_theme_manifests(&directory)?;
    Ok(ThemeLoadReport {
        directory: directory.display().to_string(),
        themes,
        errors,
    })
}

#[tauri::command]
pub fn open_theme_directory(app: tauri::AppHandle) -> Result<String, String> {
    let directory = theme_dir(&app)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the theme directory: {error}"))?;
    app.opener()
        .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("Could not open the theme directory: {error}"))?;
    Ok(directory.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_theme_loader_is_bounded_and_ignores_non_json_files() {
        let root = std::env::temp_dir().join(format!(
            "kodra-theme-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("quiet.json"),
            br##"{"id":"quiet","label":"Quiet","version":1,"tokens":{"text.primary":"#ffffff"}}"##,
        )
        .unwrap();
        fs::write(root.join("broken.json"), b"not-json").unwrap();
        fs::write(root.join("notes.txt"), b"ignored").unwrap();

        let (themes, errors) = read_theme_manifests(&root).unwrap();
        assert_eq!(themes.len(), 1);
        assert_eq!(themes[0]["id"], "quiet");
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].file_name, "broken.json");

        fs::remove_dir_all(&root).unwrap();
    }
}
