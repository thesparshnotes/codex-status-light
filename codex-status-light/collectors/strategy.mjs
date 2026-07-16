const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const FAILURE_BACKOFF_MS = 10 * MINUTE_MS;
const SUCCESS_REPHRASE_MS = 60 * MINUTE_MS;

export function computeStrategy({ codex, claude, nowMs = Date.now() } = {}) {
  if (!Number.isFinite(nowMs)) return null;

  const codexWeekly = firstWindow(codex, "weekly");
  const claudeWeekly = firstWindow(claude, "weekly");
  const codexEval = evaluatedWeekly(codexWeekly, nowMs);
  const claudeEval = evaluatedWeekly(claudeWeekly, nowMs);
  const availableCount = availableCreditCount(codex?.resetCredits);
  const expiryMs = earliestFutureExpiry(codex?.resetCredits, nowMs);
  const effectiveExpiryMs = availableCount > 0 && expiryMs === null ? Infinity : expiryMs;
  const evaluated = { codex: Boolean(codexEval), claude: Boolean(claudeEval) };
  const generatedAt = new Date(nowMs).toISOString();
  const selectedSurplus = selectSurplus([
    surplusCandidate("codex", codexEval, codex, nowMs),
    surplusCandidate("claude", claudeEval, claude, nowMs),
  ]);

  const finish = (state, urgency, advice, facts, guardTokens) => {
    const strategy = {
      state,
      urgency,
      advice,
      source: "template",
      facts: { evaluated, ...facts },
      generatedAt,
      secondary: secondaryFor(state, selectedSurplus),
    };
    strategy.factsHash = factsHashFor(strategy);
    strategy.guardTokens = guardTokens;
    return strategy;
  };

  if (codexEval && expiryMs !== null && expiryMs < codexEval.resetMs) {
    const capMs = capAt(codexEval.projection);
    if ((capMs === null || capMs > expiryMs) && availableCount > 0) {
      const expiryDay = weekday(expiryMs);
      const advice = `A Codex reset credit expires ${expiryDay} — front-load heavy Codex work and spend it before then; that adds a full window (${availableCount} credit(s) total).`;
      return finish("frontload-before-expiry", "act", advice, {
        expiry: isoOrInfinity(expiryMs),
        resetsAt: codexEval.weekly.resetsAt,
        capAt: isoOrNull(capMs),
        availableCredits: availableCount,
      }, ["front-load", "before", expiryDay, String(availableCount)]);
    }
  }

  if (codexEval) {
    const capMs = capAt(codexEval.projection);
    if (capMs !== null && capMs < codexEval.resetMs && effectiveExpiryMs !== null && effectiveExpiryMs >= capMs && availableCount > 0) {
      const capDay = weekday(capMs);
      const expiryDate = expiryMs === null ? "no future expiry" : monthDay(expiryMs);
      const advice = `Codex is pacing to cap ${capDay}; spend a reset credit when you cap (${availableCount} available, earliest expires ${expiryDate}).`;
      return finish("spend-on-cap", "act", advice, {
        capAt: new Date(capMs).toISOString(),
        resetsAt: codexEval.weekly.resetsAt,
        expiry: isoOrInfinity(effectiveExpiryMs),
        availableCredits: availableCount,
      }, ["spend", "cap", capDay, String(availableCount)]);
    }
  }

  if (codexEval) {
    const capMs = capAt(codexEval.projection);
    if (capMs !== null && capMs < codexEval.resetMs && availableCount === 0) {
      const capDay = weekday(capMs);
      const resetDay = weekday(codexEval.resetMs);
      if (claudeEval?.projection?.status === "safe") {
        const claudeSurplus = weeklySurplus(claudeEval);
        const advice = claudeSurplus >= 50
          ? `Codex is pacing to cap ${capDay} with no reset credits — shift executor lanes to Claude (Sonnet) — ${claudeSurplus}% of its weekly is unused.`
          : `Codex is pacing to cap ${capDay} with no reset credits — shift executor lanes to Claude (Sonnet) until the ${resetDay} reset.`;
        return finish("codex-capping-no-credits", "act", advice, {
          branch: "claude-safe",
          capAt: new Date(capMs).toISOString(),
          resetsAt: codexEval.weekly.resetsAt,
          availableCredits: 0,
          claudeSurplus: claudeSurplus >= 50 ? claudeSurplus : undefined,
        }, claudeSurplus >= 50
          ? ["no reset credits", "shift", "Claude", "Sonnet", `${claudeSurplus}%`, "unused"]
          : ["no reset credits", "shift", "Claude", "Sonnet", "until", resetDay]);
      }
      const advice = `Codex is pacing to cap ${capDay} with no reset credits — slow Codex use or defer heavy runs past ${resetDay}.`;
      return finish("codex-capping-no-credits", "act", advice, {
        branch: "claude-not-safe",
        capAt: new Date(capMs).toISOString(),
        resetsAt: codexEval.weekly.resetsAt,
        availableCredits: 0,
      }, ["no reset credits", "slow", "defer", "past", resetDay]);
    }
  }

  if (claudeEval?.projection?.status === "safe") {
    for (const scoped of scopedWindows(claude)) {
      const projection = scoped?.projection ?? null;
      if (isHot(projection)) {
        const capMs = capAt(projection);
        if (capMs === null) continue;
        const capDay = weekday(capMs);
        const label = typeof scoped?.label === "string" && scoped.label.trim() ? scoped.label.trim() : scoped.key;
        const advice = `${label} weekly is pacing to cap ${capDay} — keep ${label} for planning/specs/review only; route execution to Codex/Sonnet.`;
        return finish("fable-scoped-hot", "act", advice, {
          scopedKey: scoped.key,
          scopedLabel: label,
          capAt: new Date(capMs).toISOString(),
        }, [label, "planning", "execution", "Codex", "Sonnet", capDay]);
      }
    }
  }

  if (claudeEval && isHot(claudeEval.projection)) {
    const capMs = capAt(claudeEval.projection);
    if (capMs !== null && capMs < claudeEval.resetMs) {
      const capDay = weekday(capMs);
      const resetDay = weekday(claudeEval.resetMs);
      if (codexEval?.projection?.status === "safe") {
        const codexPct = Math.round(codexEval.weekly.usedPercent);
        const codexSurplus = weeklySurplus(codexEval);
        const advice = codexSurplus >= 50
          ? `Claude weekly is pacing to cap ${capDay} — shift execution to Codex — ${codexSurplus}% of its weekly is unused.`
          : `Claude weekly is pacing to cap ${capDay} — shift execution to Codex (${codexPct}% used) until the ${resetDay} reset.`;
        return finish("claude-capping", "act", advice, {
          branch: "codex-safe",
          capAt: new Date(capMs).toISOString(),
          resetsAt: claudeEval.weekly.resetsAt,
          codexPct,
          codexSurplus: codexSurplus >= 50 ? codexSurplus : undefined,
        }, codexSurplus >= 50
          ? ["shift", "Codex", `${codexSurplus}%`, "unused"]
          : ["shift", "Codex", `${codexPct}%`, "until", resetDay]);
      }
      const advice = `Claude weekly is pacing to cap ${capDay} — slow down or defer heavy runs past ${resetDay}.`;
      return finish("claude-capping", "act", advice, {
        branch: "codex-not-safe",
        capAt: new Date(capMs).toISOString(),
        resetsAt: claudeEval.weekly.resetsAt,
      }, ["slow", "defer", "past", resetDay]);
    }
  }

  return selectedSurplus ? {
    ...selectedSurplus.strategy,
    generatedAt,
    facts: { evaluated, ...selectedSurplus.strategy.facts },
    factsHash: factsHashFor({
      state: selectedSurplus.strategy.state,
      facts: { evaluated, ...selectedSurplus.strategy.facts },
    }),
    secondary: null,
  } : null;
}

export function createStrategyPhraser({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = Date.now,
  llmUrl = env.CODEX_LIGHT_LLM_URL || "http://localhost:8080",
} = {}) {
  let lastSuccessMs = 0;
  let lastFailureMs = 0;
  let lastFactsHash = null;
  let inFlight = null;

  async function maybeRephrase(strategy, { currentFactsHash = () => strategy?.factsHash, apply } = {}) {
    if (!strategy || env.CODEX_LIGHT_LLM === "0" || typeof fetchImpl !== "function") return strategy;
    if (!Array.isArray(strategy.guardTokens) || strategy.guardTokens.length === 0) return strategy;
    const nowMs = now();
    if (lastFailureMs && nowMs - lastFailureMs >= 0 && nowMs - lastFailureMs < FAILURE_BACKOFF_MS) return strategy;
    if (lastFactsHash === strategy.factsHash && lastSuccessMs && nowMs - lastSuccessMs < SUCCESS_REPHRASE_MS) return strategy;
    if (inFlight) return strategy;

    const factsHash = strategy.factsHash;
    inFlight = rephraseOnce({ strategy, fetchImpl, llmUrl })
      .then((result) => {
        inFlight = null;
        if (result.source === "llm") {
          lastSuccessMs = now();
          lastFactsHash = factsHash;
        } else {
          lastFailureMs = now();
        }
        if (currentFactsHash() !== factsHash) return strategy;
        const next = { ...strategy, advice: result.advice, source: result.source };
        apply?.(next);
        return next;
      })
      .catch(() => {
        inFlight = null;
        lastFailureMs = now();
        return strategy;
      });
    return strategy;
  }

  return { maybeRephrase };
}

export async function rephraseOnce({ strategy, fetchImpl = globalThis.fetch, llmUrl = "http://localhost:8080" } = {}) {
  try {
    const modelsResponse = await fetchImpl(`${llmUrl}/v1/models`, { method: "GET", signal: AbortSignal.timeout(5000) });
    if (!modelsResponse?.ok) return templateResult(strategy);
    const modelsJson = await modelsResponse.json();
    const model = modelsJson?.data?.[0]?.id;
    if (typeof model !== "string" || model.length === 0) return templateResult(strategy);
    const body = {
      model,
      temperature: 0.2,
      max_tokens: 90,
      messages: [{
        role: "user",
        content: `Reword the following recommendation in one natural sentence (max 45 words). Do not add, remove, or alter any facts, numbers, dates, or model names. Output only the sentence.\n\n${strategy.advice}`,
      }],
    };
    const chatResponse = await fetchImpl(`${llmUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!chatResponse?.ok) return templateResult(strategy);
    const chatJson = await chatResponse.json();
    const text = String(chatJson?.choices?.[0]?.message?.content ?? "").trim();
    return acceptsPhrasing(text, strategy) ? { advice: text, source: "llm" } : templateResult(strategy);
  } catch {
    return templateResult(strategy);
  }
}

export function acceptsPhrasing(text, strategy) {
  if (!text || text.length > 300 || text.includes("\n") || wordCount(text) > 45) return false;
  if ((text.match(/[.!?]/g) ?? []).length > 1) return false;
  for (const token of strategy.guardTokens ?? []) {
    if (!text.toLowerCase().includes(String(token).toLowerCase())) return false;
  }
  for (const token of digitTokens(strategy.advice)) {
    if (!text.includes(token)) return false;
  }
  return true;
}

function templateResult(strategy) {
  return { advice: strategy?.advice ?? "", source: "template" };
}

function evaluatedWeekly(window, nowMs) {
  const weekly = validStrategyWindow(window);
  if (!weekly) return null;
  const resetMs = Date.parse(weekly.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  return { weekly, resetMs, projection: weekly.projection ?? null };
}

function firstWindow(provider, key) {
  return Array.isArray(provider?.windows) ? provider.windows.find((window) => window?.key === key) ?? null : null;
}

function scopedWindows(provider) {
  return Array.isArray(provider?.windows)
    ? provider.windows.filter((window) => typeof window?.key === "string" && window.key.startsWith("weekly_scoped:"))
    : [];
}

function validStrategyWindow(window) {
  const usedPercent = Number(window?.usedPercent);
  if (typeof window?.key !== "string" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  const resetMs = Date.parse(window?.resetsAt);
  if (!Number.isFinite(resetMs)) return null;
  return { ...window, usedPercent, resetsAt: new Date(resetMs).toISOString() };
}

function capAt(projection) {
  const times = [projection?.weekPace, projection?.recentPace]
    .map((pace) => Date.parse(pace?.runsOutAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  return times[0] ?? null;
}

function isHot(projection) {
  return projection?.status === "warning" || projection?.status === "critical";
}

function weeklySurplus(evaluation) {
  return Math.round(100 - Number(evaluation?.weekly?.usedPercent));
}

function surplusCandidate(providerName, evaluation, provider, nowMs) {
  if (!evaluation || evaluation.projection?.status !== "safe") return null;
  const surplus = weeklySurplus(evaluation);
  const msUntilReset = evaluation.resetMs - nowMs;
  if (!Number.isFinite(msUntilReset) || !(msUntilReset > 0 && msUntilReset <= 48 * HOUR_MS) || surplus < 50) return null;

  const resetDay = weekday(evaluation.resetMs);
  const facts = {
    provider: providerName,
    resetsAt: evaluation.weekly.resetsAt,
    surplus,
  };
  const scoped = providerName === "claude" ? scopedSurplusClause(provider) : null;
  const advice = providerName === "claude"
    ? `Claude weekly resets ${resetDay} with ~${surplus}% unused${scoped?.clause ?? ""} — if you have queued work, front-load it now.`
    : `Codex weekly resets ${resetDay} with ~${surplus}% unused — if you have queued Codex work, front-load it now.`;
  if (scoped) {
    facts.scopedModel = scoped.modelName;
    facts.scopedSurplus = scoped.surplus;
    facts.scopedKey = scoped.key;
  }

  return {
    provider: providerName,
    resetMs: evaluation.resetMs,
    strategy: {
      state: "surplus-before-reset",
      urgency: "info",
      advice,
      source: "template",
      facts,
      guardTokens: ["front-load", resetDay, `${surplus}%`],
    },
  };
}

function scopedSurplusClause(provider) {
  for (const window of scopedWindows(provider)) {
    const usedPercent = Number(window?.usedPercent);
    if (!Number.isFinite(usedPercent)) continue;
    const surplus = Math.round(100 - usedPercent);
    if (surplus < 50) continue;
    const modelName = scopedModelName(window);
    if (!modelName) continue;
    return {
      key: window.key,
      modelName,
      surplus,
      clause: ` (${modelName} ~${surplus}% unused)`,
    };
  }
  return null;
}

function scopedModelName(window) {
  const label = typeof window?.label === "string" ? window.label : "";
  const match = [...label.matchAll(/\(([^()]*)\)/g)].at(-1);
  if (match?.[1]?.trim()) return match[1].trim();
  const key = typeof window?.key === "string" ? window.key : "";
  const suffix = key.startsWith("weekly_scoped:") ? key.slice("weekly_scoped:".length).trim() : "";
  return suffix || null;
}

function selectSurplus(candidates) {
  return candidates
    .filter(Boolean)
    .sort((left, right) => left.resetMs - right.resetMs || (left.provider === "codex" ? -1 : 1))[0] ?? null;
}

function secondaryFor(primaryState, surplus) {
  if (!surplus) return null;
  const codexScarcity = new Set(["frontload-before-expiry", "spend-on-cap", "codex-capping-no-credits"]);
  const claudeScarcity = new Set(["fable-scoped-hot", "claude-capping"]);
  const allowed = (codexScarcity.has(primaryState) && surplus.provider === "claude")
    || (claudeScarcity.has(primaryState) && surplus.provider === "codex");
  if (!allowed) return null;
  const { state, urgency, advice, source, facts } = surplus.strategy;
  return { state, urgency, advice, source, facts };
}

function availableCreditCount(resetCredits) {
  if (Number.isFinite(resetCredits?.available) && resetCredits.available >= 0) return resetCredits.available;
  return Array.isArray(resetCredits?.credits)
    ? resetCredits.credits.filter((credit) => credit?.status === "available").length
    : 0;
}

function earliestFutureExpiry(resetCredits, nowMs) {
  const expiries = (Array.isArray(resetCredits?.credits) ? resetCredits.credits : [])
    .filter((credit) => credit?.status === "available")
    .map((credit) => Date.parse(credit?.expiresAt))
    .filter((expiresMs) => Number.isFinite(expiresMs) && expiresMs > nowMs)
    .sort((left, right) => left - right);
  return expiries[0] ?? null;
}

function factsHashFor(strategy) {
  return stableJson(normalizeFacts({
    state: strategy.state,
    facts: strategy.facts,
  }));
}

function normalizeFacts(value) {
  if (Array.isArray(value)) return value.map(normalizeFacts);
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
    return value;
  }
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) normalized[key] = normalizeFacts(value[key]);
  }
  return normalized;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function digitTokens(text) {
  return String(text).split(/\s+/).map((token) => token.replace(/^[^\w%]+|[^\w%]+$/g, "")).filter((token) => /\d/.test(token));
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function weekday(ms) {
  return new Date(ms).toLocaleString("en-US", { weekday: "short" });
}

function monthDay(ms) {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric" });
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isoOrInfinity(ms) {
  return ms === Infinity ? "+Infinity" : isoOrNull(ms);
}
