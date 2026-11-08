#!/usr/bin/env node
// Boldbobbin's agent bridge: the MCP server
// an agent launches over stdio, which reaches the Boldbobbin the person has
// open, in a browser tab or in the desktop app.
//
//   agent  <-- stdio, newline-delimited JSON-RPC -->  bridge
//   bridge <-- WebSocket ws://127.0.0.1:47832..47835 -->  Boldbobbin tab(s)
//   bridge  -- HTTP POST http://127.0.0.1:47831/mcp -->  Boldbobbin desktop
//
// A browser tab cannot be a server, so it dials in; the desktop app is one,
// so the bridge dials it. The bridge answers what it can alone (the
// handshake, the tool list, the workflow help, waiting for the app) from
// `catalogue.json`, generated from the app's own catalogue, and carries
// every other call to the app that owns the session. It never reads or
// changes a design itself.
//
// Files cross here, on the person's computer, so the app never touches a
// path: boldbobbin_add_picture reads a picture (sniffed, 15 MB at most) and
// sends its bytes; boldbobbin_export takes the machine file's bytes from the
// app and writes them, only with the format's own extension, and never over
// an existing file unless the agent says overwrite.
//
// Several agents can run a bridge each: a bridge takes the first free port
// of 47832 to 47835, and a tab connects to every bridge it finds. Only pages
// from Boldbobbin's own origins may connect (Origin checked on the
// upgrade), and only on loopback. No dependencies: Node 18 or newer.
//
// Environment: BOLDBOBBIN_RELAY_PORT (one port instead of the range),
// BOLDBOBBIN_DESKTOP_PORT (default 47831), BOLDBOBBIN_RELAY_ORIGINS
// (comma-separated extra origins, for development).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const CATALOGUE = JSON.parse(readFileSync(new URL("./catalogue.json", import.meta.url), "utf8"));
const PORTS = process.env.BOLDBOBBIN_RELAY_PORT ? [Number(process.env.BOLDBOBBIN_RELAY_PORT)] : [47832, 47833, 47834, 47835];
const DESKTOP_PORT = Number(process.env.BOLDBOBBIN_DESKTOP_PORT ?? 47831);
const ORIGINS = new Set([
  "https://app.boldbobbin.com",
  "http://localhost:1420",
  "http://localhost:1430",
  "http://127.0.0.1:1420",
  "http://127.0.0.1:1430",
  ...(process.env.BOLDBOBBIN_RELAY_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);
/** How long a call waits for the app. */
const DEADLINE_MS = 120_000;
/** The largest WebSocket message accepted from a tab. */
const MAX_MESSAGE = 32 * 1024 * 1024;
/** A tab is pinged this often, and dropped after this long in silence. */
const PING_MS = 30_000;
const SILENT_MS = 90_000;
const VERSION = "0.4.0";
/** The largest picture boldbobbin_add_picture reads. */
const MAX_PICTURE = 15 * 1024 * 1024;

const log = (...args) => process.stderr.write(`[boldbobbin] ${args.join(" ")}\n`);

// ---- The agent's side: stdio ---------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function structured(value, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function toolError(code, message) {
  return structured({ error: { code, message } }, true);
}

let clientInfo = null;
let listenError = null;
let listeningPort = null;

const NO_APP =
  "Boldbobbin is not reachable. Ask the person to open their design in Boldbobbin (in the browser or the desktop app), choose File > Connect an AI agent…, and leave it open. boldbobbin_wait_for_app waits for it.";

async function onAgentMessage(message) {
  if (typeof message !== "object" || message === null || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
  if (!("id" in message)) return; // a notification
  const { id, method } = message;
  const params = message.params ?? {};
  switch (method) {
    case "initialize": {
      clientInfo = params.clientInfo ?? null;
      const asked = params.protocolVersion;
      reply(id, {
        protocolVersion: CATALOGUE.protocolVersions.includes(asked) ? asked : CATALOGUE.protocolVersions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CATALOGUE.serverName, title: "Boldbobbin", version: `bridge ${VERSION}` },
        instructions: CATALOGUE.instructions,
      });
      return;
    }
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: CATALOGUE.tools });
      return;
    case "tools/call":
      reply(id, await callTool(message, params));
      return;
    default:
      fail(id, -32601, `unknown method: ${method}`);
  }
}

// ---- Files ----------------------------------------------------------------

/** An agent's path: absolute, or under the home folder with ~. */
function resolvePath(given) {
  if (typeof given !== "string" || given.length === 0) return { error: "path is missing" };
  const expanded = given === "~" ? homedir() : given.startsWith("~/") ? path.join(homedir(), given.slice(2)) : given;
  if (!path.isAbsolute(expanded)) return { error: `path must be absolute or start with ~ (got ${given})` };
  return { path: path.normalize(expanded) };
}

async function statOf(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** What a picture's first bytes say it is, or null. */
function sniff(bytes) {
  const at = (i, ...b) => b.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x42, 0x4d)) return "image/bmp";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

async function readPicture(given) {
  const resolved = resolvePath(given);
  if (resolved.error) return resolved;
  const st = await statOf(resolved.path);
  if (!st || !st.isFile()) return { error: `no file at ${resolved.path}` };
  if (st.size > MAX_PICTURE) return { error: `the picture is ${Math.round(st.size / 1024 / 1024)} MB; at most 15 MB` };
  const bytes = await readFile(resolved.path);
  const mime = sniff(bytes);
  if (!mime) return { error: `${resolved.path} is not a PNG, JPEG, WebP, GIF or BMP picture` };
  return { data: bytes.toString("base64"), mime, name: path.basename(resolved.path) };
}

/** Where an export goes, checked before the app does any work: a file with
 *  the format's extension (added when it has none), or an existing folder. */
async function exportTarget(args) {
  const resolved = resolvePath(args.path);
  if (resolved.error) return resolved;
  const format = String(args.format ?? "").toLowerCase();
  const st = await statOf(resolved.path);
  if (st?.isDirectory()) return { folder: resolved.path };
  let file = resolved.path;
  const ext = path.extname(file).toLowerCase();
  if (ext === "") file = `${file}.${format}`;
  else if (ext !== `.${format}`) return { error: `the path ends in ${ext}, but the format is ${format}: use a .${format} name` };
  const parent = await statOf(path.dirname(file));
  if (!parent?.isDirectory()) return { error: `the folder ${path.dirname(file)} does not exist` };
  if (!args.overwrite && (await statOf(file))) return { error: `a file is already at ${file}; pass overwrite: true to replace it, or choose another name` };
  return { file };
}

async function writeExport(target, args, answer) {
  const result = answer?.result;
  const sc = result?.structuredContent;
  if (!result || result.isError || typeof sc?.data !== "string") return result ?? toolError("no_app", "Boldbobbin did not answer");
  const file = target.file ?? path.join(target.folder, String(sc.fileName ?? `design.${args.format}`));
  try {
    await writeFile(file, Buffer.from(sc.data, "base64"), { flag: args.overwrite ? "w" : "wx" });
  } catch (err) {
    return toolError(
      err?.code === "EEXIST" ? "file_exists" : "write_failed",
      err?.code === "EEXIST" ? `a file is already at ${file}; pass overwrite: true to replace it` : `could not write ${file}: ${err?.message ?? err}`,
    );
  }
  const { data: _data, ...facts } = sc;
  return structured({ ...facts, path: file, fileName: path.basename(file) });
}

/** Which app (a tab, or the desktop) owns which session. */
const sessionPeers = new Map();

/** The workflow is the bridge's own; bb's documentation comes from the
 *  running app, so it always matches the version the person has open (and
 *  is not published with the bridge). */
async function help(message, topic) {
  const workflow = { content: [{ type: "text", text: CATALOGUE.help.workflow }] };
  if (topic === "workflow") return workflow;
  const [app] = await peers();
  const answer = app ? await app.call(message) : null;
  if (answer?.result) return answer.result;
  const note =
    "bb's documentation comes from Boldbobbin itself, and it is not reachable yet. Ask the person to open their design and choose File > Connect an AI agent…, then call boldbobbin_wait_for_app and boldbobbin_help again.";
  return { content: [{ type: "text", text: topic === "bb" ? note : `${CATALOGUE.help.workflow}\n\n${note}` }] };
}

async function waitForApp(args) {
  const seconds = Math.min(120, Math.max(1, Number(args.timeoutSeconds ?? 60) || 60));
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const found = await peers();
    if (found.length > 0) return structured({ connected: true, apps: found.map((p) => p.kind) });
    if (Date.now() >= until) {
      return structured({ connected: false, message: listenError ?? NO_APP });
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function callTool(message, params) {
  const name = params.name;
  const args = params.arguments ?? {};
  if (!CATALOGUE.tools.some((t) => t.name === name)) return toolError("unknown_tool", `unknown tool: ${name}`);
  if (name === "boldbobbin_help") return help(message, args.topic);
  if (name === "boldbobbin_wait_for_app") return waitForApp(args);

  // Files: the picture read and sent as bytes; the export's target checked
  // now and written from the answer. The app never sees a path.
  let sent = args;
  let target = null;
  if (name === "boldbobbin_add_picture") {
    const picture = await readPicture(args.path);
    if (picture.error) return toolError("bad_path", picture.error);
    const { path: _path, ...rest } = args;
    sent = { ...rest, data: picture.data, mime: picture.mime, name: picture.name };
  } else if (name === "boldbobbin_export") {
    target = await exportTarget(args);
    if (target.error) return toolError("bad_path", target.error);
    const { path: _path, overwrite: _overwrite, ...rest } = args;
    sent = { ...rest, delivery: "bytes" };
  }

  const forwarded = {
    ...message,
    params: { ...params, arguments: sent, _meta: { ...(params._meta ?? {}), ...(clientInfo ? { "boldbobbin/client": clientInfo } : {}) } },
  };
  const reachable = await peers();
  if (reachable.length === 0) return toolError("no_app", listenError ?? NO_APP);

  if (name === "boldbobbin_connect") {
    // Every app is asked; the one that minted the code says yes.
    const answers = await Promise.all(reachable.map((peer) => peer.call(forwarded).then((a) => ({ peer, a }))));
    const won = answers.find(({ a }) => a?.result && !a.result.isError);
    if (won) {
      const sessionId = won.a.result.structuredContent?.sessionId;
      if (typeof sessionId === "string") sessionPeers.set(sessionId, won.peer);
      return won.a.result;
    }
    // A code no app recognizes: the answer of the one that had a code
    // waiting says more than "no code is waiting".
    const results = answers.map(({ a }) => a?.result).filter(Boolean);
    const telling = results.find((r) => !JSON.stringify(r).includes("no code is waiting")) ?? results[0];
    return telling ?? toolError("no_app", "no Boldbobbin answered");
  }

  const sessionId = typeof args.sessionId === "string" ? args.sessionId : null;
  let peer = sessionId ? sessionPeers.get(sessionId) : undefined;
  if (peer && !reachable.includes(peer)) {
    sessionPeers.delete(sessionId);
    return toolError("session_closed", "the Boldbobbin window of this session was closed or reloaded; ask the person for a new code");
  }
  // An unknown session: a lone app can say why (it knows the sessions it ended).
  peer ??= reachable.length === 1 ? reachable[0] : undefined;
  if (!peer) return toolError("no_session", "unknown sessionId; ask the person for a new code (File > Connect an AI agent…)");
  const answer = await peer.call(forwarded);
  if (answer?.error) return toolError("app_error", answer.error.message ?? "the app could not answer");
  if (target) return writeExport(target, args, answer);
  return answer?.result ?? toolError("no_app", "Boldbobbin did not answer");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, "not JSON");
    return;
  }
  const batch = Array.isArray(message) ? message : [message];
  for (const m of batch) {
    onAgentMessage(m).catch((err) => {
      if (m && "id" in m) fail(m.id, -32603, `bridge error: ${err?.message ?? err}`);
    });
  }
});
process.stdin.on("end", () => process.exit(0));

// ---- The desktop app: it listens, the bridge dials -------------------------

const DESKTOP_URL = `http://127.0.0.1:${DESKTOP_PORT}/mcp`;

async function post(body, timeoutMs) {
  const res = await fetch(DESKTOP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 202) return null;
  if (!res.ok) throw new Error(`desktop answered ${res.status}`);
  return res.json();
}

const desktop = {
  kind: "desktop",
  call(message) {
    return post(message, DEADLINE_MS).catch(() => null);
  },
};

let desktopSeen = { at: 0, up: false };

/** Whether the desktop app has Agent connections on: a ping, remembered
 *  for two seconds. */
async function desktopUp() {
  if (Date.now() - desktopSeen.at < 2000) return desktopSeen.up;
  let up = false;
  try {
    const answer = await post({ jsonrpc: "2.0", id: "probe", method: "ping" }, 1500);
    up = answer?.result !== undefined;
  } catch {
    up = false;
  }
  desktopSeen = { at: Date.now(), up };
  return up;
}

/** Every Boldbobbin this bridge can reach now. */
async function peers() {
  return [...tabs, ...((await desktopUp()) ? [desktop] : [])];
}

// ---- Browser tabs: a minimal WebSocket server -----------------------------
//
// RFC 6455, server side, for one kind of peer: a browser sending text
// frames. Masked client frames, 16- and 64-bit lengths, continuation
// frames, ping, pong and close. Nothing else is needed.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const tabs = new Set();

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

class Tab {
  constructor(socket) {
    this.kind = "browser";
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.waiting = new Map();
    this.next = 1;
    this.heardAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.heardAt > SILENT_MS) {
        log("a Boldbobbin tab stopped answering");
        socket.destroy();
        return;
      }
      socket.write(frame(0x9, Buffer.alloc(0)));
    }, PING_MS);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => socket.destroy());
  }

  sendText(text) {
    this.socket.write(frame(0x1, Buffer.from(text, "utf8")));
  }

  /** Sends one JSON-RPC request to the tab; resolves with its answer, or
   *  null after the deadline or when the tab goes away. */
  call(message) {
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, DEADLINE_MS);
      this.waiting.set(id, (body) => {
        clearTimeout(timer);
        resolve(body === null ? null : JSON.parse(body));
      });
      this.sendText(JSON.stringify({ t: "req", id, body: JSON.stringify(message) }));
    });
  }

  onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.t === "hello") {
      log("a Boldbobbin tab connected");
      return;
    }
    if (msg.t === "res" && this.waiting.has(msg.id)) {
      const done = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      done(typeof msg.body === "string" ? msg.body : null);
    }
  }

  onData(chunk) {
    this.heardAt = Date.now();
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        at = 10;
      }
      if (len > MAX_MESSAGE || !masked) {
        this.socket.destroy();
        return;
      }
      if (b.length < at + 4 + len) return;
      const mask = b.subarray(at, at + 4);
      const payload = Buffer.from(b.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = b.subarray(at + 4 + len);

      if (opcode === 0x8) {
        this.socket.end(frame(0x8, Buffer.alloc(0)));
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.parts.push(payload);
        if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) {
          this.socket.destroy();
          return;
        }
        if (fin) {
          const text = Buffer.concat(this.parts).toString("utf8");
          this.parts = [];
          this.onMessage(text);
        }
      }
    }
  }

  onClose() {
    clearInterval(this.heartbeat);
    tabs.delete(this);
    for (const done of this.waiting.values()) done(null);
    this.waiting.clear();
    log("a Boldbobbin tab disconnected");
  }
}

function hostAllowed(host) {
  const h = String(host ?? "").toLowerCase();
  return h === `127.0.0.1:${listeningPort}` || h === `localhost:${listeningPort}`;
}

const server = createServer((_req, res) => {
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("Boldbobbin bridge: WebSocket only.\n");
});

server.on("upgrade", (req, socket) => {
  const origin = req.headers.origin;
  const key = req.headers["sec-websocket-key"];
  if (!origin || !ORIGINS.has(origin) || !hostAllowed(req.headers.host) || typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    log(`refused a connection from ${origin ?? "no origin"}`);
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  tabs.add(new Tab(socket));
});

/** Takes the first free port of the range: another agent's bridge may hold
 *  the first. */
function listen(i) {
  const port = PORTS[i];
  const onError = (err) => {
    server.off("listening", onListening);
    if (err.code === "EADDRINUSE" && i + 1 < PORTS.length) {
      listen(i + 1);
      return;
    }
    listenError =
      err.code === "EADDRINUSE"
        ? `every bridge port (${PORTS.join(", ")}) is in use, probably by other agents' Boldbobbin bridges; close one of those agents. The desktop app can still be reached.`
        : `the bridge could not listen on port ${port}: ${err.message}`;
    log(listenError);
  };
  const onListening = () => {
    server.off("error", onError);
    listeningPort = port;
    log(`waiting for Boldbobbin on ws://127.0.0.1:${port} and the desktop app on ${DESKTOP_URL}`);
  };
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port, "127.0.0.1");
}
listen(0);
