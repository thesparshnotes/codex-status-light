const ATTENTION_IDLE_MS = 30 * 60_000;

export function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function reduceSession(state = emptyRolloutState(), record) {
  if (!record || typeof record !== "object") return state;

  const timestamp = timestampMs(record);
  const base = timestamp ? { ...state, lastActivityAt: timestamp } : state;

  if (record.type === "session_meta") {
    const payload = record.payload || {};
    const threadSpawn = payload.source?.subagent?.thread_spawn;
    return {
      ...base,
      id: payload.session_id || payload.id || base.id,
      cwd: payload.cwd || base.cwd,
      cliVersion: payload.cli_version || base.cliVersion,
      originator: payload.originator || base.originator,
      source: payload.source || base.source,
      isGuardian: isGuardianSource(payload.source) || base.isGuardian,
      agentNickname: threadSpawn?.agent_nickname || base.agentNickname,
      parentThreadId: threadSpawn?.parent_thread_id || base.parentThreadId,
      status: "running",
    };
  }

  if (isErrorRecord(record)) {
    return { ...base, status: "error", detail: undefined };
  }

  if (isInteractiveQuestionRecord(record)) {
    return { ...base, status: "waiting", detail: "question" };
  }

  if (isApprovalRequestRecord(record)) {
    return { ...base, status: "waiting", detail: "approval" };
  }

  if (record.type === "event_msg" && record.payload?.type === "task_complete") {
    const lastAgentMessage = record.payload?.last_agent_message;
    if (questionRedEnabled() && typeof lastAgentMessage === "string" && looksLikeQuestion(lastAgentMessage)) {
      return {
        ...base,
        status: "waiting",
        detail: "question",
        completedAt: timestampMs({ timestamp: record.payload.completed_at }) || timestamp || base.completedAt,
      };
    }
    return {
      ...base,
      status: "done",
      detail: undefined,
      completedAt: timestampMs({ timestamp: record.payload.completed_at }) || timestamp || base.completedAt,
    };
  }

  if (isActivityRecord(record)) {
    return { ...base, status: "running", detail: undefined };
  }

  if (timestamp) {
    return { ...base, unknownTypes: appendUnknownType(base.unknownTypes, unknownTypeKey(record)) };
  }

  return base;
}

export function deriveStatus(state, nowMs, { quietRedMs = 20_000, staleMs = 120_000 } = {}) {
  if (!state?.status) return "idle";
  if (state.status === "done" || state.status === "error" || state.status === "idle") {
    return state.status;
  }

  const lastActivityAt = state.lastActivityAt || 0;
  const quietMs = Math.max(0, nowMs - lastActivityAt);
  if (state.status === "waiting" && (state.detail === "question" || state.detail === "approval")) {
    return quietMs > ATTENTION_IDLE_MS ? "idle" : "waiting";
  }
  if ((state.status === "running" || state.status === "waiting") && quietMs > staleMs) {
    return "idle";
  }
  if (state.status === "running" && quietMs > quietRedMs) {
    return "waiting";
  }
  return state.status;
}

function emptyRolloutState() {
  return {
    id: null,
    cwd: null,
    cliVersion: null,
    originator: null,
    source: null,
    isGuardian: false,
    agentNickname: null,
    parentThreadId: null,
    status: "idle",
    detail: undefined,
    lastActivityAt: 0,
    completedAt: null,
    unknownTypes: [],
  };
}

export function looksLikeQuestion(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;

  const finalLine = lines.at(-1);
  if (finalLine.endsWith("?")) return true;

  const finalLinePatterns = [
    /\bshould i\b/i,
    /\bdo you want\b/i,
    /\bwould you like\b/i,
    /\bwhich (option|one|approach)\b/i,
    /\blet me know\b/i,
    /\bconfirm\b/i,
    /\bchoose\b/i,
    /\bpick one\b/i,
    /\bwaiting for your\b/i,
    /\bneed your (input|decision|approval)\b/i,
    /\breply with\b/i,
    /\bwhich of the following\b/i,
  ];
  if (finalLinePatterns.some((pattern) => pattern.test(finalLine))) return true;

  const optionLines = lines.filter((line) => /^(\d+\.|[A-Z]\.|-)\s+/.test(line));
  if (optionLines.length < 2) return false;

  // A bare interrogative opener is not enough — report headings like
  // "What changed:" would count. Require a question mark, or an
  // interrogative line that actually addresses the user.
  return lines.some((line) =>
    /\?/.test(line) ||
    (/^(who|what|when|where|why|how|which|do|does|did|can|could|should|would|will|is|are)\b/i.test(line) &&
      /\b(you|your|i)\b/i.test(line))
  );
}

function questionRedEnabled() {
  return process.env.CODEX_LIGHT_QUESTION_RED !== "0";
}

function timestampMs(record) {
  const value = record?.timestamp;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isActivityRecord(record) {
  if (record.type === "turn_context") return true;
  if (record.type === "response_item") return true;
  if (record.type !== "event_msg") return false;
  const payloadType = record.payload?.type;
  return (
    ["task_started", "user_message", "token_count"].includes(payloadType) ||
    /^(task_|turn_|user_|agent_|exec_|patch_|web_search|mcp_|tool_|token_)/.test(String(payloadType || ""))
  );
}

function isErrorRecord(record) {
  const fields = [record.type, record.payload?.type, record.payload?.status, record.payload?.name]
    .filter(Boolean)
    .join(" ");
  return /error|failed/i.test(fields);
}

function isInteractiveQuestionRecord(record) {
  if (record.type !== "response_item" || record.payload?.type !== "function_call") return false;
  const name = String(record.payload?.name || "").toLowerCase();
  return (
    name === "request_user_input" ||
    name === "requestuserinput" ||
    name.includes("user_input") ||
    name.includes("elicitation")
  );
}

function isApprovalRequestRecord(record) {
  if (record.type !== "response_item" || record.payload?.type !== "function_call") return false;
  const name = String(record.payload?.name || "").toLowerCase();
  if (!["exec_command", "shell", "apply_patch"].includes(name)) return false;

  const args = parseFunctionArguments(record.payload?.arguments);
  return args?.sandbox_permissions === "require_escalated";
}

function parseFunctionArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isGuardianSource(source) {
  return source?.subagent?.other === "guardian";
}

function unknownTypeKey(record) {
  return [record.type, record.payload?.type].filter(Boolean).join(":") || "unknown";
}

function appendUnknownType(existing = [], type) {
  if (!type || existing.includes(type)) return existing;
  return [...existing, type].slice(0, 8);
}
