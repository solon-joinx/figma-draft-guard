// plugins/fdg/src/hook.ts
import os2 from "node:os";
import path2 from "node:path";

// plugins/fdg/src/lib.ts
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// plugins/fdg/src/messages.ts
var MINUTE_MS = 60 * 1e3;
var STABLE_AFTER_MS = 30 * MINUTE_MS;
var FAILURE_REASONS = {
  en: {
    "no-token": "Figma token not set (/plugin \u2192 fdg)",
    auth: "Figma token invalid, expired, or missing file_metadata:read",
    "not-found": "Main file not found, or not readable with this token",
    "rate-limited": "Figma API rate limit reached",
    network: "Figma API unreachable",
    "bad-response": "Unexpected Figma API response",
    "bad-record": "Binding record damaged; bind the draft again"
  },
  "zh-TW": {
    "no-token": "\u672A\u8A2D\u5B9A Figma token\uFF08/plugin \u2192 fdg\uFF09",
    auth: "Figma token \u7121\u6548\u3001\u5DF2\u904E\u671F\uFF0C\u6216\u7F3A\u5C11 file_metadata:read \u6B0A\u9650",
    "not-found": "\u627E\u4E0D\u5230\u4E3B\u6A94\uFF0C\u6216\u6B64 token \u7121\u8B80\u53D6\u6B0A\u9650",
    "rate-limited": "\u5DF2\u9054 Figma API \u901F\u7387\u9650\u5236",
    network: "\u7121\u6CD5\u9023\u7DDA\u81F3 Figma API",
    "bad-response": "Figma API \u56DE\u61C9\u683C\u5F0F\u7570\u5E38",
    "bad-record": "\u7D81\u5B9A\u7D00\u9304\u640D\u6BC0\uFF0C\u8ACB\u91CD\u65B0\u7D81\u5B9A draft"
  }
};
function phaseOf(lastChangedAt, now) {
  const changed = Date.parse(lastChangedAt ?? "");
  return now - changed < STABLE_AFTER_MS ? "editing" : "stable";
}
function formatTime(value) {
  const date = new Date(value ?? "");
  if (Number.isNaN(date.getTime())) return "--/-- --:--";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function relativeTime(value, now, locale) {
  const elapsed = now - Date.parse(value ?? "");
  const isZh = locale === "zh-TW";
  if (Number.isNaN(elapsed)) return isZh ? "\u672A\u77E5" : "unknown";
  const minutes = Math.floor(elapsed / MINUTE_MS);
  if (minutes < 1) return isZh ? "\u4E0D\u5230 1 \u5206\u9418\u524D" : "under 1 min ago";
  if (minutes < 60) return isZh ? `${minutes} \u5206\u9418\u524D` : `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isZh ? `${hours} \u5C0F\u6642\u524D` : `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return isZh ? `${days} \u5929\u524D` : `${days} ${days === 1 ? "day" : "days"} ago`;
}
function notice(result, locale, now) {
  const isZh = locale === "zh-TW";
  switch (result.status) {
    case "fresh": {
      const main = formatTime(result.mainUpdatedAt);
      return {
        tone: "green",
        text: isZh ? `\u2705 Draft \u5DF2\u540C\u6B65 \uFF5C ${result.fileName} \uFF5C \u4E3B\u6A94\u7248\u672C ${main}` : `\u2705 Draft in sync | ${result.fileName} | Main file version ${main}`
      };
    }
    case "stale": {
      const changed = relativeTime(result.mainUpdatedAt, now, locale);
      if (phaseOf(result.mainUpdatedAt, now) === "editing") {
        return {
          tone: "blue",
          text: isZh ? `\u{1F535} Draft \u7248\u672C\u843D\u5F8C \uFF5C \u4E3B\u6A94\u7DE8\u8F2F\u4E2D \uFF5C \u6700\u5F8C\u8B8A\u66F4\uFF1A${changed}` : `\u{1F535} Draft out of date | Main file being edited | Last change: ${changed}`
        };
      }
      return {
        tone: "yellow",
        text: isZh ? `\u26A0\uFE0F Draft \u7248\u672C\u843D\u5F8C \uFF5C \u4E3B\u6A94\u5DF2\u7A69\u5B9A \uFF5C \u6700\u5F8C\u8B8A\u66F4\uFF1A${changed} \uFF5C \u53EF\u66F4\u65B0` : `\u26A0\uFE0F Draft out of date | Main file stable | Last change: ${changed} | Ready to update`
      };
    }
    case "not-ready":
      return {
        tone: "yellow",
        text: isZh ? `\u26A0\uFE0F Draft \u7D81\u5B9A\u672A\u5B8C\u6210 \uFF5C ${result.fileName} \uFF5C \u5C1A\u672A\u958B\u59CB\u76E3\u770B` : `\u26A0\uFE0F Draft binding incomplete | ${result.fileName} | Not watching yet`
      };
    case "failed": {
      const reason = FAILURE_REASONS[locale][result.code];
      return {
        tone: "red",
        text: isZh ? `\u274C \u7248\u672C\u6AA2\u67E5\u5931\u6557 \uFF5C \u539F\u56E0\uFF1A${reason}` : `\u274C Version check failed | Reason: ${reason}`
      };
    }
  }
}

// plugins/fdg/src/lib.ts
var RECORD_DIR = ".figma-draft-guard";
var CACHE_TTL_MS = 5 * 60 * 1e3;
var FAILURE_TTL_MS = 60 * 1e3;
var NOTED_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var REQUEST_TIMEOUT_MS = 5e3;
var GuardError = class extends Error {
  code;
  constructor(code) {
    super(FAILURE_REASONS.en[code]);
    this.code = code;
  }
};
function parseNodeId(input) {
  const value = input?.trim();
  if (!value) return null;
  if (!value.includes("figma.com")) return value;
  try {
    return new URL(value).searchParams.get("node-id")?.replaceAll("-", ":") ?? null;
  } catch {
    return null;
  }
}
function readsPath(recordDir, fileKey) {
  return path.join(recordDir, `reads-${fileKey}.txt`);
}
function recordRead(recordDir, fileKey, nodeId) {
  fs.appendFileSync(readsPath(recordDir, fileKey), `${nodeId}
`);
}
function findRecordDir(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, RECORD_DIR);
    if (fs.existsSync(path.join(candidate, "state.json"))) return candidate;
    if (fs.existsSync(path.join(dir, ".git")) || dir === os.homedir()) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function readRecord(startDir) {
  const recordDir = findRecordDir(startDir);
  if (!recordDir) return null;
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(recordDir, "state.json"), "utf8"));
  } catch {
    throw new GuardError("bad-record");
  }
  if (!state?.fileKey) throw new GuardError("bad-record");
  return { recordDir, state };
}
function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}
function usableToken(value) {
  return value && !value.includes("${") ? value : null;
}
function readToken(env = process.env) {
  return usableToken(env.CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN) || usableToken(env.FDG_TOKEN) || null;
}
function apiBase(env) {
  const override = env.FIGMA_API_BASE;
  return override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(override) ? override : "https://api.figma.com";
}
async function fetchMeta(fileKey, env = process.env) {
  const token = readToken(env);
  if (!token) throw new GuardError("no-token");
  const base = apiBase(env);
  let response;
  try {
    response = await fetch(`${base}/v1/files/${encodeURIComponent(fileKey)}/meta`, {
      headers: { "X-Figma-Token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new GuardError("network");
  }
  if (response.status === 403) throw new GuardError("auth");
  if (response.status === 404) throw new GuardError("not-found");
  if (response.status === 429) throw new GuardError("rate-limited");
  if (!response.ok) throw new GuardError("network");
  let file;
  try {
    ;
    ({ file } = await response.json());
  } catch {
    throw new GuardError("bad-response");
  }
  if (!file?.version) throw new GuardError("bad-response");
  return { name: file.name, version: file.version, lastTouchedAt: file.last_touched_at ?? null };
}
function isStale(active, latest) {
  if (latest.version !== active.version) return true;
  return Date.parse(latest.lastTouchedAt ?? "") > Date.parse(active.lastTouchedAt ?? "");
}
async function assess(state, getLatest) {
  if (!state.active) {
    return { status: "not-ready", key: "not-ready", fileName: state.fileName };
  }
  try {
    const latest = await getLatest();
    const facts = {
      fileName: latest.name,
      phase: phaseOf(latest.lastTouchedAt, Date.now()),
      mainUpdatedAt: latest.lastTouchedAt,
      draftFromUpdatedAt: state.active.lastTouchedAt
    };
    return isStale(state.active, latest) ? { status: "stale", key: "stale", ...facts } : { status: "fresh", key: "fresh", ...facts };
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    return { status: "failed", key: `failed:${error.code}`, code: error.code, fileName: state.fileName };
  }
}
function settingsLanguage(projectDir) {
  const files = [
    path.join(projectDir, ".claude", "settings.local.json"),
    path.join(projectDir, ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.json")
  ];
  for (const file of files) {
    try {
      const { language } = JSON.parse(fs.readFileSync(file, "utf8"));
      if (language) return language;
    } catch {
    }
  }
  return null;
}
function toLocale(language) {
  return /^zh|chinese|中文|繁體|繁体/i.test(language) ? "zh-TW" : "en";
}
function detectLocale(projectDir, env) {
  const language = settingsLanguage(projectDir) || env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return toLocale(language);
}
function localeFor(state, projectDir, env = process.env) {
  return state?.locale ?? detectLocale(projectDir, env);
}
var ANSI = { blue: "1;34", yellow: "1;33", red: "1;31", green: "1;32" };
function emphasized({ text, tone }) {
  return `\x1B[${ANSI[tone]}m${text}\x1B[0m`;
}
function writeStatus(recordDir, result, locale) {
  const shown = result?.status === "fresh" ? null : result;
  writeAtomic(path.join(recordDir, "status.json"), `${JSON.stringify({ result: shown, locale })}
`);
}
function readStatus(recordDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(recordDir, "status.json"), "utf8")).result ?? null;
  } catch {
    return null;
  }
}
function cachePath(dataDir, fileKey) {
  return path.join(dataDir, `meta-${fileKey}.json`);
}
function readCache(dataDir, fileKey, boundAt, now) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath(dataDir, fileKey), "utf8"));
    if (cache.fetchedAt < Date.parse(boundAt)) return null;
    const ttl = "errorCode" in cache ? FAILURE_TTL_MS : CACHE_TTL_MS;
    return now - cache.fetchedAt < ttl ? cache : null;
  } catch {
    return null;
  }
}
function writeCache(dataDir, fileKey, value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cachePath(dataDir, fileKey), JSON.stringify(value));
}
async function cachedMeta(fileKey, boundAt, dataDir, env, now = Date.now()) {
  const cached = readCache(dataDir, fileKey, boundAt, now);
  if (cached && "errorCode" in cached) throw new GuardError(cached.errorCode);
  if (cached) return cached;
  try {
    const meta = await fetchMeta(fileKey, env);
    writeCache(dataDir, fileKey, { ...meta, fetchedAt: now });
    return meta;
  } catch (error) {
    if (error instanceof GuardError) {
      writeCache(dataDir, fileKey, { errorCode: error.code, fetchedAt: now });
    }
    throw error;
  }
}
function markNoted(dataDir, key, now = Date.now()) {
  const dir = path.join(dataDir, "noted");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    const file2 = path.join(dir, name);
    if (now - fs.statSync(file2).mtimeMs > NOTED_TTL_MS) fs.rmSync(file2, { force: true });
  }
  const file = path.join(dir, createHash("sha1").update(key).digest("hex"));
  const isNew = !fs.existsSync(file);
  fs.writeFileSync(file, "");
  return isNew;
}

// plugins/fdg/src/hook.ts
var READ_TOOL = "mcp__figwright__get_design_context";
function claudeContext(result, state) {
  const marker = state?.active?.markerName;
  const pageId = state?.active?.markerPageId;
  const where = pageId ? `with root ${pageId}` : "on each page";
  const draftCheck = marker ? ` Before reading design data with Figwright, confirm the connected draft: search_nodes ${where} must find a layer named exactly "${marker}". If not, tell the user it may be the wrong draft. Ignore that marker layer when implementing.` : "";
  const facts = JSON.stringify(result);
  const speak = "Tell the user in the language of this conversation";
  const binding = state?.pending ? " If you are running the bind flow right now, ignore this notice." : "";
  if (result.status === "fresh") {
    return `fdg: the bound draft matches the main file.${draftCheck}`;
  }
  if (result.status === "stale") {
    return `fdg: the draft is behind the main Figma file. ${speak} before implementing from it, in a neutral, professional tone, and say whether the main file is still being edited (phase) or stable. Offer to update the draft with the bind skill, then continue unless they say otherwise.${binding}${draftCheck} Facts: ${facts}`;
  }
  return `fdg: draft freshness is unknown, so do not claim it is up to date. ${speak}.${binding}${draftCheck} Facts: ${facts}`;
}
function isDesignRead({ tool_name, tool_input }) {
  const detail = tool_input?.detail;
  return tool_name === READ_TOOL && (detail === void 0 || detail === "full");
}
function responseTexts(response) {
  if (typeof response === "string") return [response];
  if (Array.isArray(response)) return response.flatMap(responseTexts);
  if (typeof response !== "object" || response === null) return [];
  const { text, content } = response;
  return responseTexts(text ?? content);
}
function selectionRoots(response) {
  for (const text of responseTexts(response)) {
    try {
      const { nodes } = JSON.parse(text);
      if (nodes) return nodes.map((node) => node.id);
    } catch {
    }
  }
  return [];
}
function trackRead(record, input) {
  if (!isDesignRead(input)) return;
  const nodeId = input.tool_input?.nodeId;
  const ids = nodeId ? [parseNodeId(nodeId)] : selectionRoots(input.tool_response);
  for (const id of ids) {
    if (id) recordRead(record.recordDir, record.state.fileKey, id);
  }
}
function afterRead(input, env = process.env) {
  const record = readRecord(env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd());
  if (record) trackRead(record, input);
}
async function evaluateHook(eventName, input, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const dataDir = env.CLAUDE_PLUGIN_DATA ?? path2.join(os2.tmpdir(), "figma-draft-guard");
  let record = null;
  let result;
  try {
    record = readRecord(projectDir);
    if (!record) return null;
    const { fileKey, active } = record.state;
    result = await assess(record.state, () => cachedMeta(fileKey, active?.boundAt ?? "", dataDir, env));
    const shown = readStatus(record.recordDir);
    if (result.status === "fresh" && shown?.status === "stale") result = shown;
  } catch (error) {
    if (!(error instanceof GuardError)) throw error;
    result = { status: "failed", key: `failed:${error.code}`, code: error.code };
  }
  const locale = localeFor(record?.state, projectDir, env);
  if (record) writeStatus(record.recordDir, result, locale);
  const isSessionStart = eventName === "SessionStart";
  if (result.status === "fresh" && !isSessionStart) return null;
  const key = [input.session_id, record?.state.fileKey, record?.state.active?.boundAt, result.key].join("|");
  const isNew = markNoted(dataDir, key);
  if (!isNew && !isSessionStart) return null;
  const hookSpecificOutput = {
    hookEventName: eventName,
    additionalContext: claudeContext(result, record?.state)
  };
  return isSessionStart ? { systemMessage: emphasized(notice(result, locale, Date.now())), hookSpecificOutput } : { hookSpecificOutput };
}
var TEMPORARY_FAILURES = ["network", "rate-limited"];
async function poll(env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const record = readRecord(projectDir);
  if (!record) return;
  const { fileKey } = record.state;
  const result = await assess(record.state, () => fetchMeta(fileKey, env));
  if (result.status === "failed" && TEMPORARY_FAILURES.includes(result.code)) return;
  writeStatus(record.recordDir, result, localeFor(record.state, projectDir, env));
}
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}
var EVENTS = {
  "session-start": "SessionStart",
  "pre-tool-use": "PreToolUse"
};
try {
  if (process.argv[2] === "poll") {
    await poll();
  } else if (process.argv[2] === "post-tool-use") {
    afterRead(JSON.parse(await readStdin()));
  } else {
    const eventName = EVENTS[process.argv[2] ?? ""];
    if (!eventName) throw new Error(`unknown hook: ${process.argv[2]}`);
    const text = await readStdin();
    const output = await evaluateHook(eventName, text ? JSON.parse(text) : {});
    if (output) console.log(JSON.stringify(output));
  }
} catch (error) {
  console.error(`fdg: ${error instanceof Error ? error.message : error}`);
}
