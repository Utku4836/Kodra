use serde::Serialize;

pub(crate) fn tool_risk(tool_id: &str) -> &'static str {
    match tool_id {
        "read_file" | "list_dir" | "search_code" | "glob_files" | "web_fetch"
        | "analyze_codebase" => "low",
        "write_file" | "edit_file" | "create_dir" | "apply_diff" | "manage_memory"
        | "browser_automation" | "spawn_sub_agent" => "medium",
        "delete_file" | "execute_command" | "manage_background_process" | "github_action" => "high",
        _ => "medium",
    }
}

pub(crate) fn destructive_check(tool_id: &str, params: &serde_json::Value) -> Option<String> {
    if tool_id != "execute_command" {
        return None;
    }
    let command = params
        .get("cmd")
        .or_else(|| params.get("command"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let normalized = command.to_lowercase().trim().to_string();
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
    for pattern in hard_blocks {
        if normalized.contains(pattern) {
            return Some(format!("Destructive command blocked: {pattern}"));
        }
    }
    if normalized == "format" || normalized.starts_with("format ") {
        return Some("format command blocked".to_string());
    }
    if normalized.contains("rm -rf") {
        return Some("rm -rf blocked".to_string());
    }
    None
}

pub(crate) fn critical_path_check(tool_id: &str, params: &serde_json::Value) -> bool {
    if matches!(tool_id, "read_file" | "list_dir" | "search_code") {
        return false;
    }
    let paths = ["path", "old", "new", "cmd", "command"]
        .into_iter()
        .filter_map(|key| params.get(key).and_then(|value| value.as_str()));
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
    paths.map(str::to_lowercase).any(|path| {
        critical_segments
            .iter()
            .any(|segment| path.contains(segment))
    })
}

pub(crate) fn tool_allow_key(tool_id: &str, params: &serde_json::Value) -> String {
    if tool_id == "execute_command" {
        let command = params
            .get("cmd")
            .or_else(|| params.get("command"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let program = command
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase();
        format!("{tool_id}:{program}")
    } else {
        let path = params
            .get("path")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_lowercase();
        format!("{tool_id}:{path}")
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ToolCheckResult {
    decision: String,
    risk: String,
    reason: String,
}

pub(crate) fn evaluate(
    mode: &str,
    allow_list: &[String],
    tool_id: &str,
    params: &serde_json::Value,
) -> ToolCheckResult {
    let risk = tool_risk(tool_id).to_string();
    if let Some(reason) = destructive_check(tool_id, params) {
        return ToolCheckResult {
            decision: "deny".into(),
            risk: "high".into(),
            reason,
        };
    }
    if critical_path_check(tool_id, params) {
        return ToolCheckResult {
            decision: "approve".into(),
            risk,
            reason: "Critical system path — approval required".into(),
        };
    }
    if allow_list.contains(&tool_allow_key(tool_id, params)) {
        return ToolCheckResult {
            decision: "allow".into(),
            risk,
            reason: "Permanently allowed".into(),
        };
    }

    let decision = match mode {
        "autonomous" => "allow",
        "strict" => "approve",
        _ if risk == "low" => "allow",
        _ => "approve",
    };
    ToolCheckResult {
        decision: decision.into(),
        risk,
        reason: if decision == "allow" {
            "Low risk — automatic".into()
        } else {
            "Approval required".into()
        },
    }
}

pub(crate) fn authorize_execution(
    mode: &str,
    allow_list: &[String],
    tool_id: &str,
    params: &serde_json::Value,
    approved: bool,
) -> Result<(), String> {
    if let Some(reason) = destructive_check(tool_id, params) {
        return Err(reason);
    }
    if critical_path_check(tool_id, params) && !approved {
        return Err("Critical path — approval required".into());
    }
    let permanently_allowed = allow_list.contains(&tool_allow_key(tool_id, params));
    let automatic = mode == "autonomous" || (mode != "strict" && tool_risk(tool_id) == "low");
    if approved || permanently_allowed || automatic {
        Ok(())
    } else {
        Err("Permission denied — approval required".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_requires_approval_even_for_reads() {
        let result = evaluate("strict", &[], "read_file", &json!({ "path": "README.md" }));
        assert_eq!(result.decision, "approve");
        assert!(authorize_execution(
            "strict",
            &[],
            "read_file",
            &json!({ "path": "README.md" }),
            false
        )
        .is_err());
    }

    #[test]
    fn critical_paths_cannot_be_bypassed_by_a_saved_allow_rule() {
        let params = json!({ "path": "C:\\Windows\\System32\\drivers\\etc\\hosts" });
        let key = tool_allow_key("write_file", &params);
        assert!(authorize_execution("autonomous", &[key], "write_file", &params, false).is_err());
        assert!(authorize_execution("smart", &[], "write_file", &params, true).is_ok());
    }

    #[test]
    fn destructive_commands_are_denied_after_frontend_approval_too() {
        let params = json!({ "command": "rm -rf ./project" });
        assert_eq!(
            evaluate("autonomous", &[], "execute_command", &params).decision,
            "deny"
        );
        assert!(authorize_execution("autonomous", &[], "execute_command", &params, true).is_err());
    }
}
