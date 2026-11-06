// plugins/fdg/src/server.ts
import readline2 from "node:readline";

// plugins/fdg/src/lib.ts
import { execFileSync } from "node:child_process";
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

// plugins/fdg/src/lib.ts
var RECORD_DIR = ".figma-draft-guard";
var CACHE_TTL_MS = 5 * 60 * 1e3;
var FAILURE_TTL_MS = 60 * 1e3;
var NOTED_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var REQUEST_TIMEOUT_MS = 5e3;
var MARKER_PREFIX = "\u{1F512} Main file version";
var GuardError = class extends Error {
  code;
  constructor(code) {
    super(FAILURE_REASONS.en[code]);
    this.code = code;
  }
};
function parseFileKey(input) {
  const value = input?.trim();
  if (!value) return null;
  if (/^[A-Za-z0-9]+$/.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (!["design", "file", "proto", "board", "slides"].includes(parts[0])) return null;
  return parts[2] === "branch" && parts[3] ? parts[3] : parts[1] ?? null;
}
function isSwitching({ fileKey, pending }) {
  return pending !== null && pending.fileKey !== fileKey;
}
function targetFileKey(state) {
  return isSwitching(state) ? state.pending?.fileKey ?? state.fileKey : state.fileKey;
}
function compareState(state) {
  const compare = isSwitching(state) ? state.pending?.compare : state.compare;
  return compare ?? { scope: "all", pages: [], frames: [] };
}
function withCompare(state, compare) {
  return isSwitching(state) && state.pending ? { ...state, pending: { ...state.pending, compare } } : { ...state, compare };
}
function isBaselineReady(compare) {
  return compare.baselineReady ?? compare.frames.length > 0;
}
function readsPath(recordDir, fileKey) {
  return path.join(recordDir, `reads-${fileKey}.txt`);
}
function readNodes(recordDir, fileKey) {
  try {
    const lines = fs.readFileSync(readsPath(recordDir, fileKey), "utf8").split("\n");
    return [...new Set(lines.filter(Boolean))];
  } catch {
    return [];
  }
}
function baselineDir(recordDir, fileKey) {
  return path.join(recordDir, "baselines", fileKey);
}
function writeReport(recordDir, markdown, now = /* @__PURE__ */ new Date()) {
  const dir = path.join(recordDir, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const pad = (number) => String(number).padStart(2, "0");
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dayPath = path.join(dir, `${day}.md`);
  const file = fs.existsSync(dayPath) ? path.join(dir, `${day}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.md`) : dayPath;
  fs.writeFileSync(file, markdown);
  return file;
}
function projectRoot(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return dir;
  }
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
function newRecordDir(dir) {
  return path.join(projectRoot(dir), RECORD_DIR);
}
function writeRecord(recordDir, state) {
  fs.mkdirSync(recordDir, { recursive: true });
  fs.writeFileSync(path.join(recordDir, ".gitignore"), "*\n");
  writeAtomic(path.join(recordDir, "state.json"), `${JSON.stringify(state, null, 2)}
`);
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
function markerName(meta) {
  return `${MARKER_PREFIX} ${formatTime(meta.lastTouchedAt)} \xB7 ${meta.version} (do not delete)`;
}
function suggestedFileName(meta, now = /* @__PURE__ */ new Date()) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${meta.name}\uFF5Cdraft ${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
}
function copyToClipboard(text) {
  const commands = { darwin: "pbcopy", win32: "clip" };
  const command2 = commands[process.platform];
  if (!command2) return false;
  try {
    execFileSync(command2, [], { input: text, stdio: ["pipe", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
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
function settingsLanguage(projectDir2) {
  const files = [
    path.join(projectDir2, ".claude", "settings.local.json"),
    path.join(projectDir2, ".claude", "settings.json"),
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
function detectLocale(projectDir2, env) {
  const language = settingsLanguage(projectDir2) || env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return toLocale(language);
}
function localeFor(state, projectDir2, env = process.env) {
  return state?.locale ?? detectLocale(projectDir2, env);
}
function writeStatus(recordDir, result, locale) {
  const shown = result?.status === "fresh" ? null : result;
  writeAtomic(path.join(recordDir, "status.json"), `${JSON.stringify({ result: shown, locale })}
`);
}

// plugins/fdg/src/figwright.ts
import { spawn } from "node:child_process";
import readline from "node:readline";
var CALL_TIMEOUT_MS = 60 * 1e3;
var FigwrightError = class extends Error {
};
function command(env) {
  const override = env.NODE_ENV === "test" ? env.FDG_FIGWRIGHT_ARGV : void 0;
  return override ? JSON.parse(override) : ["npx", "-y", "@figwright/mcp"];
}
function childEnv(env) {
  const { FDG_TOKEN, CLAUDE_PLUGIN_OPTION_FIGMA_TOKEN, ...rest } = env;
  return rest;
}
var Figwright = class {
  child;
  pending = /* @__PURE__ */ new Map();
  nextId = 0;
  constructor(env = process.env) {
    const [program = "npx", ...args] = command(env);
    this.child = spawn(program, args, {
      env: childEnv(env),
      shell: process.platform === "win32"
    });
    this.child.stderr.resume();
    this.child.on("error", () => this.failAll());
    this.child.on("close", () => this.failAll());
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
  }
  failAll() {
    for (const resolve of this.pending.values()) resolve({ error: { message: "Figwright stopped" } });
    this.pending.clear();
  }
  receive(line) {
    try {
      const message = JSON.parse(line);
      if (message.id === void 0) return;
      this.pending.get(message.id)?.(message);
      this.pending.delete(message.id);
    } catch {
    }
  }
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: { message: `Figwright timed out on ${method}` } });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}
`);
    });
  }
  async connect() {
    const { error } = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fdg", version: "0.1.0" }
    });
    if (error) throw new FigwrightError(error.message);
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}
`);
  }
  async call(name, args = {}) {
    const { error, result } = await this.request("tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text ?? "";
    if (error) throw new FigwrightError(error.message);
    if (result?.isError) throw new FigwrightError(text);
    return JSON.parse(text);
  }
  close() {
    this.child.kill();
  }
};

// plugins/fdg/src/compare.ts
var MAX_DETAILS = 20;
var MAX_PARENT_DEPTH = 30;
var MARKER_NAME = /^🔒 (Main file version|主檔版本)/;
var DIVIDER_NAME = /^[\p{P}\p{S}\s]+$/u;
var NOT_FRONT = /establish connection/i;
var DraftNotInFront = class extends Error {
};
async function pages(figwright) {
  return (await figwright.call("get_pages")).pages;
}
async function nodesOn(read) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof FigwrightError) return [];
    throw error;
  }
}
function markersOn(figwright, page) {
  return nodesOn(async () => {
    const { nodes } = await figwright.call("search_nodes", { name: "\u{1F512}", root: page.id });
    return nodes.filter((node) => MARKER_NAME.test(node.name));
  });
}
async function claim(figwright, sessionId) {
  const { bound } = await figwright.call("use_file", { sessionId });
  if (bound?.sessionId !== sessionId) throw new FigwrightError("Could not connect to this draft");
}
async function markDraft(figwright, sessionId, markerName2) {
  await claim(figwright, sessionId);
  const allPages = await pages(figwright);
  for (const page of allPages) {
    if ((await markersOn(figwright, page)).length > 0) return { error: "old-draft" };
  }
  for (const page of allPages.filter(({ name }) => !DIVIDER_NAME.test(name))) {
    const created = await nodesOn(async () => [
      await figwright.call("create_frame", {
        name: markerName2,
        parentId: page.id,
        x: -1e5,
        y: -1e5,
        width: 1,
        height: 1
      })
    ]);
    const nodeId = created[0]?.nodeId;
    if (!nodeId) continue;
    await figwright.call("set_visible", { nodeId, visible: false });
    await figwright.call("lock_nodes", { nodeIds: [nodeId] });
    await figwright.call("reorder_nodes", { nodeIds: [nodeId], index: 0 });
    const markers = await markersOn(figwright, page);
    if (markers.some((node) => node.name === markerName2)) return { markerPageId: page.id };
  }
  return { error: "no-page" };
}
async function assertInFront(figwright, sessionId) {
  const { files } = await figwright.call("list_files");
  if (!files.find((file) => file.sessionId === sessionId)?.routed) throw new DraftNotInFront();
}
function sectionPath(section, byId) {
  const parent = section.parentId ? byId.get(section.parentId) : void 0;
  return parent ? [...sectionPath(parent, byId), section] : [section];
}
async function framesOnPage(figwright, page) {
  const sections = await nodesOn(async () => {
    const { nodes } = await figwright.call("scan_nodes_by_types", {
      types: ["SECTION"],
      root: page.id
    });
    return nodes;
  });
  const toRef = (frame, parents) => ({
    nodeId: frame.id,
    name: frame.name,
    path: `${[...parents.map((section) => section.name), frame.name].join(" / ")} (${frame.id})`
  });
  if (sections.length === 0) {
    const frames2 = await nodesOn(async () => {
      const { nodes } = await figwright.call("scan_nodes_by_types", {
        types: ["FRAME"],
        root: page.id
      });
      return nodes;
    });
    return frames2.filter((frame) => frame.parentId === page.id && !MARKER_NAME.test(frame.name)).map((frame) => toRef(frame, []));
  }
  const byId = new Map(sections.map((section) => [section.id, section]));
  const visible = sections.filter(
    (section) => sectionPath(section, byId).every((part) => part.visible !== false)
  );
  const frames = [];
  for (const section of visible) {
    const { nodes } = await figwright.call("get_design_context", {
      nodeId: section.id,
      detail: "minimal",
      depth: 1
    });
    for (const child of nodes[0]?.children ?? []) {
      if (child.type === "FRAME" && !MARKER_NAME.test(child.name)) {
        frames.push(toRef(child, sectionPath(section, byId)));
      }
    }
  }
  return frames;
}
async function readFrames(figwright, frames, readNodes2) {
  const frameIds = new Set(frames.map((frame) => frame.nodeId));
  const found = /* @__PURE__ */ new Set();
  for (const start of readNodes2) {
    let nodeId = start;
    for (let depth = 0; nodeId && depth < MAX_PARENT_DEPTH; depth += 1) {
      if (frameIds.has(nodeId)) {
        found.add(nodeId);
        break;
      }
      const current = nodeId;
      const nodes = await nodesOn(() => figwright.call("get_nodes_info", { nodeIds: [current] }));
      nodeId = nodes[0]?.parentId;
    }
  }
  return [...found];
}
function toChange(nodeId, { added, removed, changed }) {
  const fieldDetails = changed.flatMap(
    ({ id, name, fields = [] }) => fields.map(({ field, before, after }) => ({ node: name, nodeId: id, kind: "changed", field, before, after }))
  );
  const nodeDetail = (kind) => ({ id, name }) => ({
    node: name,
    nodeId: id,
    kind
  });
  const details = [...fieldDetails, ...added.map(nodeDetail("added")), ...removed.map(nodeDetail("removed"))];
  return { nodeId, changeCount: details.length, details: details.slice(0, MAX_DETAILS) };
}
async function compareDraft(figwright, sessionId, compare, readNodes2, rootDir) {
  await claim(figwright, sessionId);
  await assertInFront(figwright, sessionId);
  const allPages = await pages(figwright);
  const everyFrame = [];
  for (const page of allPages) {
    for (const frame of await framesOnPage(figwright, page)) everyFrame.push({ frame, page });
  }
  const readFrameIds = await readFrames(figwright, everyFrame.map(({ frame }) => frame), readNodes2);
  const read = new Set(readFrameIds);
  const inScope = ({ frame, page }) => {
    if (compare.scope === "all") return true;
    if (read.has(frame.nodeId)) return true;
    return compare.scope === "pages" && compare.pages.includes(page.name);
  };
  const frames = everyFrame.filter(inScope).map(({ frame }) => frame);
  const changes = [];
  const notComparedIds = [];
  const failedIds = [];
  for (const { nodeId } of frames) {
    try {
      const result = await figwright.call("design_diff", { nodeId, rootDir });
      if (result.status === "baseline-created") notComparedIds.push(nodeId);
      if (result.status === "diff" && result.changes) changes.push(toChange(nodeId, result.changes));
    } catch (error) {
      if (!(error instanceof FigwrightError)) throw error;
      if (NOT_FRONT.test(error.message)) throw new DraftNotInFront();
      notComparedIds.push(nodeId);
      failedIds.push(nodeId);
    }
  }
  return { frames, changes, notComparedIds, failedIds, readFrameIds };
}
async function acceptChanges(figwright, changes, rootDir) {
  for (const { nodeId } of changes) {
    await figwright.call("design_diff", { nodeId, rootDir, update: true });
  }
}

// plugins/fdg/src/report.ts
var LABELS = {
  en: {
    title: "Design comparison",
    read: "Previously read",
    other: "Other",
    added: "Added to main file",
    removed: "Removed from main file",
    unchanged: "Unchanged",
    changes: (count) => `${count} ${count === 1 ? "change" : "changes"}`,
    frames: (count) => `${count} ${count === 1 ? "frame" : "frames"}`,
    colon: ": ",
    membershipUnknown: "Added and removed frames are only listed when all pages are compared.",
    notCompared: "Not compared",
    baselineReady: (count) => `Baseline ready: ${count} ${count === 1 ? "frame" : "frames"}`,
    none: "No changes found.",
    nodeAdded: "added",
    nodeRemoved: "removed",
    empty: "none",
    more: (count) => `${count} more ${count === 1 ? "change" : "changes"}`,
    report: "Report"
  },
  "zh-TW": {
    title: "\u8A2D\u8A08\u5DEE\u7570\u5831\u544A",
    read: "\u66FE\u8B80\u53D6",
    other: "\u5176\u4ED6",
    added: "\u4E3B\u6A94\u65B0\u589E",
    removed: "\u4E3B\u6A94\u79FB\u9664",
    unchanged: "\u7121\u8B8A\u66F4",
    changes: (count) => `${count} \u9805\u8B8A\u66F4`,
    frames: (count) => `${count} \u500B\u756B\u9762`,
    colon: "\uFF1A",
    membershipUnknown: "\u53EA\u6709\u6BD4\u5C0D\u5168\u90E8\u9801\u9762\u6642\uFF0C\u624D\u6703\u5217\u51FA\u65B0\u589E\u8207\u79FB\u9664\u7684\u756B\u9762\u3002",
    notCompared: "\u672A\u6BD4\u5C0D",
    baselineReady: (count) => `\u57FA\u6E96\u5DF2\u5EFA\u7ACB\uFF1A${count} \u500B\u756B\u9762`,
    none: "\u672A\u767C\u73FE\u8B8A\u66F4\u3002",
    nodeAdded: "\u65B0\u589E",
    nodeRemoved: "\u79FB\u9664",
    empty: "\u7121",
    more: (count) => `\u5176\u9918 ${count} \u9805`,
    report: "\u5831\u544A"
  }
};
var FIELD_LABELS = {
  fills: "\u586B\u8272",
  fill: "\u586B\u8272",
  strokes: "\u908A\u6846",
  stroke: "\u908A\u6846",
  characters: "\u6587\u5B57",
  name: "\u540D\u7A31",
  width: "\u5BEC\u5EA6",
  height: "\u9AD8\u5EA6",
  x: "X",
  y: "Y",
  opacity: "\u4E0D\u900F\u660E\u5EA6",
  visible: "\u986F\u793A",
  cornerRadius: "\u5713\u89D2",
  fontSize: "\u5B57\u7D1A",
  fontName: "\u5B57\u578B",
  layout: "\u7248\u9762",
  parent: "\u4E0A\u5C64",
  textStyle: "\u6587\u5B57\u6A23\u5F0F",
  effects: "\u6548\u679C"
};
var VALUE_EDGE_LENGTH = 40;
function formatValue(value, emptyText) {
  if (value === void 0 || value === null) return emptyText;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw.replace(/\s+/g, " ");
  return text.length > VALUE_EDGE_LENGTH * 2 ? `${text.slice(0, VALUE_EDGE_LENGTH)}\u2026${text.slice(-VALUE_EDGE_LENGTH)}` : text;
}
function detailLines(change, locale) {
  const text = LABELS[locale];
  const details = change?.details ?? [];
  const nodes = /* @__PURE__ */ new Map();
  for (const detail of details) {
    nodes.set(detail.nodeId, [...nodes.get(detail.nodeId) ?? [], detail]);
  }
  const lines = [...nodes.values()].flatMap((items) => {
    const [first] = items;
    const title = `  - ${first?.node} (${first?.nodeId})`;
    if (first?.kind === "added") return [`${title}${text.colon}${text.nodeAdded}`];
    if (first?.kind === "removed") return [`${title}${text.colon}${text.nodeRemoved}`];
    return [
      title,
      ...items.map(({ field = "", before, after }) => {
        const label = locale === "zh-TW" ? FIELD_LABELS[field] ?? field : field;
        return `    - ${label}${text.colon}${formatValue(before, text.empty)} \u2192 ${formatValue(after, text.empty)}`;
      })
    ];
  });
  const omitted = (change?.changeCount ?? 0) - details.length;
  return omitted > 0 ? [...lines, `  - ${text.more(omitted)}`] : lines;
}
function summarize(input) {
  const { previous, current, changes, readNodeIds, notComparedIds = [] } = input;
  const membershipKnown = input.membershipKnown !== false;
  const known = new Set(previous.map((frame) => frame.nodeId));
  const present = new Set(current.map((frame) => frame.nodeId));
  const read = new Set(readNodeIds);
  const skipped = new Set(notComparedIds);
  const byId = new Map(current.map((frame) => [frame.nodeId, frame]));
  const added = membershipKnown ? current.filter((frame) => !known.has(frame.nodeId)) : [];
  const addedIds = new Set(added.map((frame) => frame.nodeId));
  const notCompared = current.filter(({ nodeId }) => skipped.has(nodeId) && !addedIds.has(nodeId));
  const changed = changes.filter(
    ({ nodeId, changeCount }) => changeCount > 0 && byId.has(nodeId) && !addedIds.has(nodeId) && !skipped.has(nodeId)
  );
  const pathOf = (nodeId) => byId.get(nodeId)?.path ?? nodeId;
  return {
    read: changed.filter(({ nodeId }) => read.has(nodeId)).map(({ nodeId, changeCount }) => ({ path: pathOf(nodeId), changeCount })),
    other: changed.filter(({ nodeId }) => !read.has(nodeId)).map(({ nodeId }) => pathOf(nodeId)),
    added: added.map((frame) => frame.path),
    removed: membershipKnown ? previous.filter((frame) => !present.has(frame.nodeId)).map((frame) => frame.path) : [],
    notCompared: notCompared.map((frame) => frame.path),
    unchanged: current.length - changed.length - added.length - notCompared.length
  };
}
function changeSections(input, locale, withDetails) {
  const text = LABELS[locale];
  const summary = summarize(input);
  const lines = [];
  const nodeIds = new Map(input.current.map((frame) => [frame.path, frame.nodeId]));
  const changes = new Map(input.changes.map((change) => [change.nodeId, change]));
  const details = (path2) => withDetails ? detailLines(changes.get(nodeIds.get(path2) ?? ""), locale) : [];
  const section = (title, items) => {
    if (items.length > 0) lines.push(`## ${title}`, "", ...items, "");
  };
  section(
    text.read,
    summary.read.flatMap(({ path: path2, changeCount }) => [
      `- ${path2}${text.colon}${text.changes(changeCount)}`,
      ...details(path2)
    ])
  );
  section(text.other, summary.other.flatMap((path2) => [`- ${path2}`, ...details(path2)]));
  section(text.added, summary.added.map((path2) => `- ${path2}`));
  section(text.removed, summary.removed.map((path2) => `- ${path2}`));
  section(text.notCompared, summary.notCompared.map((path2) => `- ${path2}`));
  if (lines.length === 0) lines.push(text.none, "");
  if (input.membershipKnown === false) lines.push(text.membershipUnknown, "");
  lines.push(`${text.unchanged}${text.colon}${text.frames(summary.unchanged)}`);
  return lines;
}
function reportMarkdown(input, locale, date) {
  const title = [`# ${LABELS[locale].title}`, "", `${input.fileName} \xB7 ${date}`, ""];
  return `${[...title, ...changeSections(input, locale, true)].join("\n")}
`;
}
function baselineMarkdown(frames, notCompared, locale) {
  const text = LABELS[locale];
  const skipped = notCompared.length > 0 ? ["", `## ${text.notCompared}`, "", ...notCompared.map((path2) => `- ${path2}`)] : [];
  return [text.baselineReady(frames), ...skipped].join("\n");
}
function summaryMarkdown(input, locale, reportPath) {
  return [...changeSections(input, locale, false), "", `${LABELS[locale].report}${LABELS[locale].colon}${reportPath}`].join("\n");
}

// plugins/fdg/src/server.ts
var projectDir = () => process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
var TOOLS = [
  {
    name: "start_binding",
    description: "Read the main Figma file version and hold it until a new draft is ready. Does not change the active record. Omit mainFileUrl to reuse the bound main file.",
    inputSchema: {
      type: "object",
      properties: {
        mainFileUrl: { type: "string", description: "Figma main file link" },
        language: { type: "string", description: "Language of this conversation, such as zh-TW or en" }
      }
    },
    run: startBinding
  },
  {
    name: "finish_binding",
    description: "Make the held version the active record. Call only after the marker from start_binding exists in the new draft.",
    inputSchema: {
      type: "object",
      properties: { markerName: { type: "string", description: "Marker name written to the draft" } },
      required: ["markerName"]
    },
    run: finishBinding
  },
  {
    name: "compare_context",
    description: "Return the comparison scope, known frames and nodes read so far.",
    inputSchema: { type: "object", properties: {} },
    run: compareContext
  },
  {
    name: "set_compare_scope",
    description: "Set which frames to compare: all, pages (with page names), or read (only frames read before).",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["all", "pages", "read"] },
        pages: { type: "array", items: { type: "string" }, description: "Page names when scope is pages" }
      },
      required: ["scope"]
    },
    run: setCompareScope
  },
  {
    name: "mark_draft",
    description: "Write the version marker into the draft with this Figwright sessionId. Returns old-draft when it already has a marker.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "From Figwright list_files" } },
      required: ["sessionId"]
    },
    run: markDraftTool
  },
  {
    name: "run_comparison",
    description: "List frames, build or compare baselines, and write the report. The draft must be in front in Figma. Returns draft-not-front otherwise. Show the returned summary as it is.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", description: "From Figwright list_files" } },
      required: ["sessionId"]
    },
    run: runComparison
  },
  {
    name: "check_status",
    description: "Compare the active record with the current main Figma file version.",
    inputSchema: { type: "object", properties: {} },
    run: checkStatus
  }
];
function recoverableRecord(mainFileUrl) {
  try {
    return readRecord(projectDir());
  } catch (error) {
    if (mainFileUrl && error instanceof GuardError && error.code === "bad-record") return null;
    throw error;
  }
}
async function startBinding(args) {
  const { mainFileUrl, language } = args;
  const record = recoverableRecord(mainFileUrl);
  const fileKey = mainFileUrl ? parseFileKey(mainFileUrl) : record?.state.fileKey;
  if (!fileKey) {
    return { error: "missing-link", message: "A valid Figma main file link is required." };
  }
  const meta = await fetchMeta(fileKey);
  const marker = markerName(meta);
  writeRecord(record?.recordDir ?? newRecordDir(projectDir()), {
    fileKey: record?.state.fileKey ?? fileKey,
    fileName: record?.state.fileName ?? meta.name,
    locale: language ? toLocale(language) : record?.state.locale,
    compare: record?.state.compare,
    active: record?.state.active ?? null,
    pending: {
      fileKey,
      fileName: meta.name,
      version: meta.version,
      lastTouchedAt: meta.lastTouchedAt,
      markerName: marker
    }
  });
  return {
    fileName: meta.name,
    markerName: marker,
    mainPhase: phaseOf(meta.lastTouchedAt, Date.now()),
    mainUpdatedAt: meta.lastTouchedAt
  };
}
function finishBinding({ markerName: name }) {
  const record = readRecord(projectDir());
  const pending = record?.state.pending;
  if (!record || !pending) return { error: "not-started", message: "Call start_binding first." };
  if (pending.markerName !== name) {
    return { error: "marker-mismatch", message: `Expected marker: ${pending.markerName}` };
  }
  const { fileKey, fileName: boundName, version, lastTouchedAt, markerName: activeMarker, markerPageId } = pending;
  writeRecord(record.recordDir, {
    ...record.state,
    fileKey,
    fileName: boundName,
    compare: fileKey === record.state.fileKey ? record.state.compare : pending.compare,
    active: { version, lastTouchedAt, markerName: activeMarker, markerPageId, boundAt: (/* @__PURE__ */ new Date()).toISOString() },
    pending: null
  });
  writeStatus(record.recordDir, null, localeFor(record.state, projectDir()));
  const fileName = suggestedFileName({ name: boundName });
  return {
    watching: boundName,
    suggestedFileName: fileName,
    copiedToClipboard: copyToClipboard(fileName)
  };
}
async function checkStatus() {
  const record = readRecord(projectDir());
  if (!record) return { status: "unbound" };
  const { fileKey } = record.state;
  const result = await assess(record.state, () => fetchMeta(fileKey));
  writeStatus(record.recordDir, result, localeFor(record.state, projectDir()));
  const { key, ...facts } = result;
  return result.status === "failed" ? { ...facts, message: new GuardError(result.code).message } : facts;
}
function compareContext() {
  const record = readRecord(projectDir());
  if (!record) return { error: "not-started", message: "Call start_binding first." };
  const compare = compareState(record.state);
  const fileKey = targetFileKey(record.state);
  return {
    scope: compare.scope,
    pages: compare.pages,
    frames: compare.frames,
    readNodes: readNodes(record.recordDir, fileKey),
    baselineDir: baselineDir(record.recordDir, fileKey),
    isFirstComparison: !isBaselineReady(compare)
  };
}
function setCompareScope({ scope, pages: pages2 }) {
  const record = readRecord(projectDir());
  if (!record) return { error: "not-started", message: "Call start_binding first." };
  if (!["all", "pages", "read"].includes(scope)) {
    return { error: "bad-scope", message: "scope must be all, pages or read." };
  }
  const compare = {
    ...compareState(record.state),
    scope,
    pages: pages2 ?? [],
    scopeChanged: true
  };
  writeRecord(record.recordDir, withCompare(record.state, compare));
  return { scope: compare.scope, pages: compare.pages };
}
async function withFigwright(use) {
  const figwright = new Figwright();
  try {
    await figwright.connect();
    return await use(figwright);
  } finally {
    figwright.close();
  }
}
async function markDraftTool({ sessionId }) {
  const record = readRecord(projectDir());
  const pending = record?.state.pending;
  if (!record || !pending) return { error: "not-started", message: "Call start_binding first." };
  const result = await withFigwright((figwright) => markDraft(figwright, sessionId, pending.markerName));
  if ("error" in result) return { error: result.error, message: "This draft cannot be marked." };
  writeRecord(record.recordDir, { ...record.state, pending: { ...pending, ...result } });
  return { marked: true };
}
async function runComparison({ sessionId }) {
  const record = readRecord(projectDir());
  if (!record) return { error: "not-started", message: "Call start_binding first." };
  const compare = compareState(record.state);
  const fileKey = targetFileKey(record.state);
  const rootDir = baselineDir(record.recordDir, fileKey);
  const locale = localeFor(record.state, projectDir());
  const isFirst = !isBaselineReady(compare);
  const summary = await withFigwright(async (figwright) => {
    const result = await compareDraft(
      figwright,
      sessionId,
      compare,
      readNodes(record.recordDir, fileKey),
      rootDir
    );
    const pathOf = (id) => result.frames.find((frame) => frame.nodeId === id)?.path ?? id;
    const saved = { ...compare, frames: result.frames, baselineReady: true, scopeChanged: false };
    if (isFirst) {
      writeRecord(record.recordDir, withCompare(record.state, saved));
      return baselineMarkdown(result.frames.length - result.failedIds.length, result.failedIds.map(pathOf), locale);
    }
    const input = {
      fileName: record.state.pending?.fileName ?? record.state.fileName,
      previous: compare.frames,
      current: result.frames,
      changes: result.changes,
      readNodeIds: result.readFrameIds,
      notComparedIds: result.notComparedIds,
      membershipKnown: compare.scope === "all" && !compare.scopeChanged
    };
    const date = (/* @__PURE__ */ new Date()).toLocaleDateString("sv-SE");
    const reportPath = writeReport(record.recordDir, reportMarkdown(input, locale, date));
    await acceptChanges(figwright, result.changes, rootDir);
    writeRecord(record.recordDir, withCompare(record.state, saved));
    return summaryMarkdown(input, locale, reportPath);
  });
  return { summary };
}
async function callTool(name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { error: "unknown-tool", message: name ?? "" };
  try {
    return await tool.run(args ?? {});
  } catch (error) {
    if (error instanceof GuardError) return { error: error.code, message: error.message };
    if (error instanceof DraftNotInFront) return { error: "draft-not-front", message: "Bring the draft to the front." };
    if (error instanceof FigwrightError) return { error: "figwright", message: error.message };
    return { error: "internal", message: error instanceof Error ? error.message : String(error) };
  }
}
function send(id, result) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
async function handle({ id, method, params }) {
  if (id === void 0) return;
  if (method === "initialize") {
    send(id, {
      protocolVersion: params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fdg", version: "0.1.0" }
    });
  } else if (method === "tools/list") {
    send(id, { tools: TOOLS.map(({ run, ...tool }) => tool) });
  } else if (method === "tools/call") {
    const result = await callTool(params?.name, params?.arguments);
    send(id, {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: Boolean(result.error)
    });
  } else {
    send(id, {});
  }
}
readline2.createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    handle(JSON.parse(line)).catch(() => void 0);
  } catch {
  }
});
