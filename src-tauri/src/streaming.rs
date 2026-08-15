use crate::{ChatResult, TokenUsage, ToolCallData};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tauri::ipc::Channel;

#[derive(Default)]
pub(crate) struct StreamManager {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl StreamManager {
    pub(crate) fn register(&self, request_id: &str) -> Result<Arc<AtomicBool>, String> {
        validate_request_id(request_id)?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Stream lock is unavailable")?;
        if active.contains_key(request_id) {
            return Err("This stream ID is already in use".to_string());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(request_id.to_string(), cancelled.clone());
        Ok(cancelled)
    }

    pub(crate) fn cancel(&self, request_id: &str) -> Result<bool, String> {
        validate_request_id(request_id)?;
        let active = self
            .active
            .lock()
            .map_err(|_| "Stream lock is unavailable")?;
        Ok(active
            .get(request_id)
            .map(|flag| {
                flag.store(true, Ordering::Release);
                true
            })
            .unwrap_or(false))
    }

    pub(crate) fn finish(&self, request_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(request_id);
        }
    }
}

fn validate_request_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid stream ID".to_string());
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum StreamEvent {
    #[serde(rename = "started")]
    Started {
        #[serde(rename = "requestId")]
        request_id: String,
        provider: String,
        model: String,
        sequence: u64,
    },
    #[serde(rename = "textDelta")]
    TextDelta { delta: String, sequence: u64 },
    #[serde(rename = "reasoningDelta")]
    ReasoningDelta { delta: String, sequence: u64 },
    #[serde(rename = "toolCallStarted")]
    ToolCallStarted {
        index: usize,
        id: String,
        name: String,
        sequence: u64,
    },
    #[serde(rename = "toolCallDelta")]
    ToolCallDelta {
        index: usize,
        delta: String,
        sequence: u64,
    },
    #[serde(rename = "usage")]
    Usage { usage: TokenUsage, sequence: u64 },
    #[serde(rename = "completed")]
    Completed {
        #[serde(rename = "finishReason")]
        finish_reason: Option<String>,
        #[serde(rename = "elapsedMs")]
        elapsed_ms: u128,
        sequence: u64,
    },
    #[serde(rename = "cancelled")]
    Cancelled { sequence: u64 },
    #[serde(rename = "error")]
    Error {
        kind: String,
        message: String,
        sequence: u64,
    },
}

#[derive(Debug, PartialEq, Eq)]
struct SseFrame {
    event: Option<String>,
    data: String,
}

fn read_sse<R: Read, F: FnMut(SseFrame) -> Result<bool, String>>(
    reader: R,
    mut consume: F,
) -> Result<(), String> {
    let mut event = None;
    let mut data = Vec::new();
    let mut dispatch =
        |event: &mut Option<String>, data: &mut Vec<String>| -> Result<bool, String> {
            if data.is_empty() {
                *event = None;
                return Ok(true);
            }
            let frame = SseFrame {
                event: event.take(),
                data: data.join("\n"),
            };
            data.clear();
            consume(frame)
        };

    for line in BufReader::new(reader).lines() {
        let line = line.map_err(|error| format!("Stream read error: {error}"))?;
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !dispatch(&mut event, &mut data)? {
                return Ok(());
            }
        } else if line.starts_with(':') {
            continue;
        } else if let Some(value) = line.strip_prefix("event:") {
            event = Some(value.trim_start().to_string());
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start().to_string());
        }
    }
    let _ = dispatch(&mut event, &mut data)?;
    Ok(())
}

#[derive(Default)]
struct PartialTool {
    id: String,
    name: String,
    arguments: String,
    arguments_value: Option<Value>,
    thought_signature: Option<String>,
    announced: bool,
}

struct Accumulator {
    text: String,
    reasoning: String,
    thinking_signature: Option<String>,
    tools: Vec<PartialTool>,
    usage: TokenUsage,
    model: Option<String>,
    finish_reason: Option<String>,
}

impl Default for Accumulator {
    fn default() -> Self {
        Self {
            text: String::new(),
            reasoning: String::new(),
            thinking_signature: None,
            tools: Vec::new(),
            usage: TokenUsage::default(),
            model: None,
            finish_reason: None,
        }
    }
}

struct Emitter {
    channel: Channel<StreamEvent>,
    sequence: u64,
}

impl Emitter {
    fn send(&mut self, build: impl FnOnce(u64) -> StreamEvent) -> Result<(), String> {
        self.sequence = self.sequence.saturating_add(1);
        self.channel
            .send(build(self.sequence))
            .map_err(|_| "UI stream channel closed".to_string())
    }

    fn text(&mut self, delta: &str) -> Result<(), String> {
        if !delta.is_empty() {
            self.send(|sequence| StreamEvent::TextDelta {
                delta: delta.to_string(),
                sequence,
            })?;
        }
        Ok(())
    }

    fn reasoning(&mut self, delta: &str) -> Result<(), String> {
        if !delta.is_empty() {
            self.send(|sequence| StreamEvent::ReasoningDelta {
                delta: delta.to_string(),
                sequence,
            })?;
        }
        Ok(())
    }
}

fn tool_mut(tools: &mut Vec<PartialTool>, index: usize) -> &mut PartialTool {
    while tools.len() <= index {
        tools.push(PartialTool::default());
    }
    &mut tools[index]
}

fn announce_tool(
    emitter: &mut Emitter,
    tool: &mut PartialTool,
    index: usize,
) -> Result<(), String> {
    if !tool.announced && !tool.name.is_empty() {
        tool.announced = true;
        let id = tool.id.clone();
        let name = tool.name.clone();
        emitter.send(|sequence| StreamEvent::ToolCallStarted {
            index,
            id,
            name,
            sequence,
        })?;
    }
    Ok(())
}

fn parse_openai(value: &Value, acc: &mut Accumulator, out: &mut Emitter) -> Result<(), String> {
    if let Some(model) = value.get("model").and_then(Value::as_str) {
        acc.model = Some(model.to_string());
    }
    if let Some(usage) = value.get("usage") {
        acc.usage.input_tokens = usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        acc.usage.output_tokens = usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        acc.usage.reasoning_tokens = usage
            .pointer("/completion_tokens_details/reasoning_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        acc.usage.cached_tokens = usage
            .pointer("/prompt_tokens_details/cached_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        acc.usage.total_tokens = usage
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                acc.usage
                    .input_tokens
                    .saturating_add(acc.usage.output_tokens)
            });
        let usage = acc.usage.clone();
        out.send(|sequence| StreamEvent::Usage { usage, sequence })?;
    }
    let Some(choice) = value.pointer("/choices/0") else {
        return Ok(());
    };
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        acc.finish_reason = Some(reason.to_string());
    }
    let Some(delta) = choice.get("delta") else {
        return Ok(());
    };
    if let Some(text) = delta.get("content").and_then(Value::as_str) {
        acc.text.push_str(text);
        out.text(text)?;
    }
    if let Some(reasoning) = delta
        .get("reasoning_content")
        .or_else(|| delta.get("reasoning"))
        .and_then(Value::as_str)
    {
        acc.reasoning.push_str(reasoning);
        out.reasoning(reasoning)?;
    }
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
        for call in calls {
            let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let tool = tool_mut(&mut acc.tools, index);
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                tool.id.push_str(id);
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                tool.name.push_str(name);
            }
            announce_tool(out, tool, index)?;
            if let Some(arguments) = call.pointer("/function/arguments").and_then(Value::as_str) {
                tool.arguments.push_str(arguments);
                let chunk = arguments.to_string();
                out.send(|sequence| StreamEvent::ToolCallDelta {
                    index,
                    delta: chunk,
                    sequence,
                })?;
            }
        }
    }
    Ok(())
}

fn parse_anthropic(value: &Value, acc: &mut Accumulator, out: &mut Emitter) -> Result<(), String> {
    match value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "message_start" => {
            acc.model = value
                .pointer("/message/model")
                .and_then(Value::as_str)
                .map(str::to_string);
            acc.usage.input_tokens = value
                .pointer("/message/usage/input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            acc.usage.output_tokens = value
                .pointer("/message/usage/output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
        }
        "content_block_start" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if value.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") {
                let tool = tool_mut(&mut acc.tools, index);
                tool.id = value
                    .pointer("/content_block/id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                tool.name = value
                    .pointer("/content_block/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                announce_tool(out, tool, index)?;
            }
        }
        "content_block_delta" => {
            let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            match value
                .pointer("/delta/type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "text_delta" => {
                    let delta = value
                        .pointer("/delta/text")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    acc.text.push_str(delta);
                    out.text(delta)?;
                }
                "thinking_delta" => {
                    let delta = value
                        .pointer("/delta/thinking")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    acc.reasoning.push_str(delta);
                    out.reasoning(delta)?;
                }
                "signature_delta" => {
                    let signature = value
                        .pointer("/delta/signature")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    acc.thinking_signature
                        .get_or_insert_with(String::new)
                        .push_str(signature);
                }
                "input_json_delta" => {
                    let delta = value
                        .pointer("/delta/partial_json")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    tool_mut(&mut acc.tools, index).arguments.push_str(delta);
                    let chunk = delta.to_string();
                    out.send(|sequence| StreamEvent::ToolCallDelta {
                        index,
                        delta: chunk,
                        sequence,
                    })?;
                }
                _ => {}
            }
        }
        "message_delta" => {
            acc.finish_reason = value
                .pointer("/delta/stop_reason")
                .and_then(Value::as_str)
                .map(str::to_string);
            if let Some(output) = value
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64)
            {
                acc.usage.output_tokens = output;
            }
            acc.usage.cached_tokens = value
                .pointer("/usage/cache_read_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(acc.usage.cached_tokens);
            acc.usage.total_tokens = acc
                .usage
                .input_tokens
                .saturating_add(acc.usage.output_tokens);
            let usage = acc.usage.clone();
            out.send(|sequence| StreamEvent::Usage { usage, sequence })?;
        }
        "error" => {
            let kind = value
                .pointer("/error/type")
                .and_then(Value::as_str)
                .unwrap_or("stream_error");
            return Err(format!("Anthropic stream error: {kind}"));
        }
        _ => {}
    }
    Ok(())
}

fn parse_gemini(value: &Value, acc: &mut Accumulator, out: &mut Emitter) -> Result<(), String> {
    if let Some(model) = value.get("modelVersion").and_then(Value::as_str) {
        acc.model = Some(model.to_string());
    }
    if let Some(reason) = value
        .pointer("/candidates/0/finishReason")
        .and_then(Value::as_str)
    {
        acc.finish_reason = Some(reason.to_string());
    }
    if let Some(parts) = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
    {
        for (index, part) in parts.iter().enumerate() {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                if part
                    .get("thought")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    acc.reasoning.push_str(text);
                    out.reasoning(text)?;
                } else {
                    acc.text.push_str(text);
                    out.text(text)?;
                }
            }
            if let Some(call) = part.get("functionCall") {
                let tool = tool_mut(&mut acc.tools, index);
                tool.id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("gemini-{index}"));
                tool.name = call
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                tool.arguments_value = call
                    .get("args")
                    .cloned()
                    .or_else(|| Some(serde_json::json!({})));
                tool.thought_signature = part
                    .get("thoughtSignature")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                announce_tool(out, tool, index)?;
                let chunk = serde_json::to_string(tool.arguments_value.as_ref().unwrap())
                    .unwrap_or_else(|_| "{}".to_string());
                out.send(|sequence| StreamEvent::ToolCallDelta {
                    index,
                    delta: chunk,
                    sequence,
                })?;
            } else if let Some(signature) = part.get("thoughtSignature").and_then(Value::as_str) {
                if let Some(tool) = acc
                    .tools
                    .iter_mut()
                    .find(|tool| !tool.name.is_empty() && tool.thought_signature.is_none())
                {
                    tool.thought_signature = Some(signature.to_string());
                }
            }
        }
    }
    if let Some(usage) = value.get("usageMetadata") {
        acc.usage.input_tokens = usage
            .get("promptTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(acc.usage.input_tokens);
        acc.usage.output_tokens = usage
            .get("candidatesTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(acc.usage.output_tokens);
        acc.usage.reasoning_tokens = usage
            .get("thoughtsTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(acc.usage.reasoning_tokens);
        acc.usage.cached_tokens = usage
            .get("cachedContentTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(acc.usage.cached_tokens);
        acc.usage.total_tokens = usage
            .get("totalTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| {
                acc.usage
                    .input_tokens
                    .saturating_add(acc.usage.output_tokens)
                    .saturating_add(acc.usage.reasoning_tokens)
            });
        let usage = acc.usage.clone();
        out.send(|sequence| StreamEvent::Usage { usage, sequence })?;
    }
    Ok(())
}

pub(crate) fn consume(
    response: ureq::Response,
    protocol: crate::providers::ProviderProtocol,
    provider: String,
    model: String,
    request_id: String,
    channel: Channel<StreamEvent>,
    cancelled: Arc<AtomicBool>,
) -> Result<ChatResult, String> {
    let started_at = Instant::now();
    let rate_limits = crate::rate_limits_from_response(&response);
    let mut out = Emitter {
        channel,
        sequence: 0,
    };
    out.send(|sequence| StreamEvent::Started {
        request_id,
        provider,
        model,
        sequence,
    })?;
    let mut acc = Accumulator::default();
    let mut did_cancel = false;
    let stream_result = read_sse(response.into_reader(), |frame| {
        if cancelled.load(Ordering::Acquire) {
            did_cancel = true;
            return Ok(false);
        }
        if frame.data == "[DONE]" {
            return Ok(false);
        }
        let value: Value = serde_json::from_str(&frame.data)
            .map_err(|error| format!("Invalid SSE JSON data: {error}"))?;
        match protocol {
            crate::providers::ProviderProtocol::OpenAiChat => {
                parse_openai(&value, &mut acc, &mut out)?
            }
            crate::providers::ProviderProtocol::AnthropicMessages => {
                parse_anthropic(&value, &mut acc, &mut out)?
            }
            crate::providers::ProviderProtocol::GeminiGenerateContent => {
                parse_gemini(&value, &mut acc, &mut out)?
            }
        }
        Ok(true)
    });
    if let Err(error) = stream_result {
        let public_message = error.clone();
        let _ = out.send(|sequence| StreamEvent::Error {
            kind: "protocol".to_string(),
            message: public_message,
            sequence,
        });
        return Err(error);
    }
    if did_cancel || cancelled.load(Ordering::Acquire) {
        out.send(|sequence| StreamEvent::Cancelled { sequence })?;
        return Err("Request cancelled by user".to_string());
    }
    let mut tools = Vec::new();
    for tool in acc.tools.into_iter().filter(|tool| !tool.name.is_empty()) {
        let arguments = match tool.arguments_value {
            Some(value) => value,
            None if tool.arguments.trim().is_empty() => serde_json::json!({}),
            None => serde_json::from_str(&tool.arguments)
                .map_err(|_| format!("Incomplete JSON arguments for tool {}", tool.name))?,
        };
        tools.push(ToolCallData {
            id: tool.id,
            name: tool.name,
            arguments,
            thought_signature: tool.thought_signature,
        });
    }
    let elapsed_ms = started_at.elapsed().as_millis();
    let finish_reason = acc.finish_reason.clone();
    out.send(|sequence| StreamEvent::Completed {
        finish_reason,
        elapsed_ms,
        sequence,
    })?;
    Ok(ChatResult {
        text: acc.text,
        tool_calls: tools,
        reasoning: (!acc.reasoning.is_empty()).then_some(acc.reasoning),
        thinking_signature: acc.thinking_signature,
        usage: acc.usage,
        model: acc.model,
        finish_reason: acc.finish_reason,
        rate_limits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_decoder_handles_comments_multiline_crlf_and_eof() {
        let input = ": ping\r\nevent: update\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata: [DONE]";
        let mut frames = Vec::new();
        read_sse(input.as_bytes(), |frame| {
            frames.push(frame);
            Ok(true)
        })
        .unwrap();
        assert_eq!(
            frames,
            vec![
                SseFrame {
                    event: Some("update".into()),
                    data: "{\"a\":\n1}".into()
                },
                SseFrame {
                    event: None,
                    data: "[DONE]".into()
                },
            ]
        );
    }

    #[test]
    fn openai_accumulates_parallel_tool_arguments() {
        let channel = Channel::new(|_| Ok(()));
        let mut out = Emitter {
            channel,
            sequence: 0,
        };
        let mut acc = Accumulator::default();
        parse_openai(
            &serde_json::json!({"choices":[{"delta":{"tool_calls":[
                {"index":0,"id":"a","function":{"name":"read_file","arguments":"{\"path\":"}},
                {"index":1,"id":"b","function":{"name":"list_dir","arguments":"{}"}}
            ]}}]}),
            &mut acc,
            &mut out,
        )
        .unwrap();
        parse_openai(
            &serde_json::json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"\"x\"}"}}
        ]},"finish_reason":"tool_calls"}]}),
            &mut acc,
            &mut out,
        )
        .unwrap();
        assert_eq!(acc.tools[0].arguments, "{\"path\":\"x\"}");
        assert_eq!(acc.tools[1].arguments, "{}");
        assert_eq!(acc.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn anthropic_keeps_thinking_signature_and_cumulative_usage() {
        let channel = Channel::new(|_| Ok(()));
        let mut out = Emitter {
            channel,
            sequence: 0,
        };
        let mut acc = Accumulator::default();
        parse_anthropic(&serde_json::json!({"type":"message_start","message":{"model":"claude","usage":{"input_tokens":9,"output_tokens":1}}}), &mut acc, &mut out).unwrap();
        parse_anthropic(&serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}), &mut acc, &mut out).unwrap();
        parse_anthropic(&serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}), &mut acc, &mut out).unwrap();
        parse_anthropic(&serde_json::json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}), &mut acc, &mut out).unwrap();
        assert_eq!(acc.reasoning, "plan");
        assert_eq!(acc.thinking_signature.as_deref(), Some("sig"));
        assert_eq!(acc.usage.total_tokens, 16);
    }

    #[test]
    fn request_ids_reject_path_characters() {
        assert!(validate_request_id("req-123_ok").is_ok());
        assert!(validate_request_id("../session").is_err());
    }

    #[test]
    fn gemini_keeps_signature_from_empty_text_part() {
        let channel = Channel::new(|_| Ok(()));
        let mut out = Emitter {
            channel,
            sequence: 0,
        };
        let mut acc = Accumulator::default();
        parse_gemini(
            &serde_json::json!({"candidates":[{"content":{"parts":[{
                "functionCall":{"id":"call-1","name":"read_file","args":{"path":"x"}}
            }]}}]}),
            &mut acc,
            &mut out,
        )
        .unwrap();
        parse_gemini(
            &serde_json::json!({"candidates":[{"content":{"parts":[{
                "text":"","thoughtSignature":"signed"
            }]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":12}}),
            &mut acc,
            &mut out,
        )
        .unwrap();
        assert_eq!(acc.tools[0].thought_signature.as_deref(), Some("signed"));
        assert_eq!(acc.usage.total_tokens, 12);
    }

    #[test]
    fn manager_cancels_and_removes_one_request() {
        let manager = StreamManager::default();
        let flag = manager.register("req-one").unwrap();
        assert!(manager.cancel("req-one").unwrap());
        assert!(flag.load(Ordering::Acquire));
        manager.finish("req-one");
        assert!(!manager.cancel("req-one").unwrap());
    }
}
