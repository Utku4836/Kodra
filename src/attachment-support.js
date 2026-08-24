const TEXT_EXTENSIONS = new Set([
  "txt", "md", "mdx", "json", "jsonl", "yaml", "yml", "toml", "xml", "csv",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "html", "htm", "vue",
  "rs", "py", "go", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cs", "php",
  "rb", "swift", "sh", "ps1", "bat", "cmd", "sql", "graphql", "ini", "env", "log",
]);

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFiles: 4,
  maxTotalBytes: 4 * 1024 * 1024,
  maxTextBytes: 256 * 1024,
  maxMediaBytes: 3 * 1024 * 1024,
});

function extension(name = "") {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

export function attachmentKind(file = {}) {
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || extension(file.name) === "pdf") return "document";
  if (type.startsWith("text/") || TEXT_EXTENSIONS.has(extension(file.name))) return "text";
  return "unknown";
}

export function attachmentPolicy({ provider = "", protocol = "", model = null, providerInfo = null } = {}) {
  const supportsVision = typeof model?.supportsVision === "boolean"
    ? model.supportsVision
    : providerInfo?.capabilities?.vision === true;
  const resolvedProtocol = protocol || providerInfo?.protocol || "openai_chat";
  const documents = resolvedProtocol === "anthropic_messages" || resolvedProtocol === "gemini_generate_content";
  return Object.freeze({
    provider,
    protocol: resolvedProtocol,
    text: true,
    images: supportsVision,
    documents,
    accept: [
      [...TEXT_EXTENSIONS].map((item) => `.${item}`).join(","),
      supportsVision ? "image/png,image/jpeg,image/webp,image/gif" : "",
      documents ? "application/pdf" : "",
    ].filter(Boolean).join(","),
  });
}

export function validateAttachment(file, policy, current = [], limits = ATTACHMENT_LIMITS) {
  if (!file) return { ok: false, reason: "No file was selected." };
  if (current.length >= limits.maxFiles) return { ok: false, reason: `You can attach up to ${limits.maxFiles} files.` };
  const kind = attachmentKind(file);
  if (kind === "unknown") return { ok: false, reason: "This file type is not supported." };
  if (kind === "image" && !policy.images) return { ok: false, reason: "The selected model does not support image input." };
  if (kind === "document" && !policy.documents) return { ok: false, reason: "PDF input is not supported by this provider protocol." };
  const size = Number(file.size || 0);
  const max = kind === "text" ? limits.maxTextBytes : limits.maxMediaBytes;
  if (size <= 0) return { ok: false, reason: "The selected file is empty." };
  if (size > max) return { ok: false, reason: kind === "text" ? "Text files must be 256 KB or smaller." : "Images and PDFs must be 3 MB or smaller." };
  const total = current.reduce((sum, item) => sum + Number(item.size || 0), 0) + size;
  if (total > limits.maxTotalBytes) return { ok: false, reason: "Attachments must stay under 4 MB in total." };
  return { ok: true, kind };
}

export function attachmentTokenEstimate(attachments = []) {
  return attachments.reduce((total, item) => {
    if (item.kind === "text") return total + Math.ceil(String(item.text || "").length / 4);
    if (item.kind === "image") return total + 1100;
    if (item.kind === "document") return total + 1800;
    return total;
  }, 0);
}

export function publicAttachment(attachment) {
  return {
    name: String(attachment.name || "attachment").slice(0, 180),
    mimeType: String(attachment.mimeType || "application/octet-stream").slice(0, 100),
    kind: attachment.kind,
    size: Number(attachment.size || 0),
    ...(attachment.kind === "text" ? { text: String(attachment.text || "") } : { dataUrl: String(attachment.dataUrl || "") }),
  };
}

export function pastedContentDescriptor(value = "") {
  const text = String(value).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const codeSignals = lines.filter((line) =>
    /^\s{2,}\S/.test(line)
    || /[{};]\s*$/.test(line)
    || /^\s*(?:const|let|var|function|class|def|fn|import|export|SELECT|CREATE|```)[\s(:]/i.test(line)
  ).length;
  const code = codeSignals >= 2 || /```[\s\S]*```/.test(text);
  const attach = text.length >= 600 || lines.length >= 7 || (lines.length >= 4 && code);
  return Object.freeze({
    attach,
    code,
    name: code ? "Pasted code" : "Pasted text",
    text,
  });
}
