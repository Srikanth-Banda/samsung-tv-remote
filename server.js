const http = require("http");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");
const WebSocket = require("ws");

const TV_HOST = "10.0.0.60";
const TV_PORT = 8002;
const TV_PATH = "/api/v2/channels/samsung.remote.control";
const TV_HTTP_PORT = 8001;
const PORT = 8080;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const TOKEN_FILE = path.join(DATA_DIR, ".tv-token");
const MAC_FILE = path.join(DATA_DIR, ".tv-mac");
const ROOT = __dirname;
const POLL_MS = 5000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

function loadToken() {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return null; }
}
function saveToken(t) { fs.writeFileSync(TOKEN_FILE, t, "utf8"); }
function loadMac() {
  try { return fs.readFileSync(MAC_FILE, "utf8").trim(); } catch { return null; }
}
function saveMac(m) { fs.writeFileSync(MAC_FILE, m, "utf8"); }

function buildName() {
  return Buffer.from(JSON.stringify({ name: "SamsungRemote", id: "home-remote" })).toString("base64");
}

// ---------- TV state polling ----------
let tvState = { power: "unknown" };
const clients = new Set();
let pollTimer = null;

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  }
}

function broadcastRaw(str) {
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  }
}

function fetchDeviceInfo() {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: TV_HOST,
      port: TV_HTTP_PORT,
      path: "/api/v2/",
      timeout: 3000,
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function pollOnce() {
  const info = await fetchDeviceInfo();
  let next;
  if (info && info.device) {
    next = { power: info.device.PowerState === "on" ? "on" : "off" };
    const mac = info.device.wifiMac;
    if (mac && mac !== loadMac()) {
      saveMac(mac);
      console.log(`[remote] cached TV MAC: ${mac}`);
    }
  } else {
    next = { power: "off" };
  }
  if (next.power !== tvState.power) {
    tvState = next;
    console.log(`[remote] tv state -> ${tvState.power}`);
    broadcast({ type: "state", ...tvState });
  }
}

function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
}
function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------- Wake-on-LAN ----------
function sendWol(mac) {
  const cleaned = mac.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length !== 12) return false;
  const macBytes = Buffer.from(cleaned, "hex");
  const packet = Buffer.alloc(102);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);

  // Derive subnet broadcast from TV IP (e.g. 10.0.0.60 → 10.0.0.255)
  const subnetBroadcast = TV_HOST.replace(/\.\d+$/, ".255");
  const targets = ["255.255.255.255", subnetBroadcast];

  // Send 3 times, 800ms apart — WiFi WoL can miss a single packet
  let attempt = 0;
  function fire() {
    const sock = dgram.createSocket("udp4");
    sock.bind(() => {
      sock.setBroadcast(true);
      let pending = targets.length * 2; // port 7 + port 9 per target
      const done = () => { if (--pending === 0) sock.close(); };
      for (const addr of targets) {
        sock.send(packet, 0, packet.length, 9, addr, done);
        sock.send(packet, 0, packet.length, 7, addr, done);
      }
    });
    attempt++;
    if (attempt < 3) setTimeout(fire, 800);
  }
  fire();
  return true;
}

// ---------- App launch via HTTP ----------
function launchApp(appId) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: TV_HOST,
      port: TV_HTTP_PORT,
      path: `/api/v2/applications/${encodeURIComponent(appId)}`,
      method: "POST",
      timeout: 3000,
      headers: { "Content-Type": "application/json", "Content-Length": 0 },
    }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ---------- Persistent TV WebSocket ----------
// One shared connection for all phones. Phone reconnects don't cycle the TV connection.
let tvWs = null;
let tvReady = false;
const tvQueue = [];
let tvReconnectTimer = null;

function sendToTV(str) {
  if (tvReady && tvWs && tvWs.readyState === WebSocket.OPEN) {
    tvWs.send(str);
  } else {
    tvQueue.push(str);
  }
}

function connectTV() {
  if (tvReconnectTimer) { clearTimeout(tvReconnectTimer); tvReconnectTimer = null; }
  const token = loadToken();
  const tvUrl = `wss://${TV_HOST}:${TV_PORT}${TV_PATH}?name=${buildName()}${token ? `&token=${token}` : ""}`;
  console.log(`[tv] connecting (token: ${token || "none"})`);
  tvWs = new WebSocket(tvUrl, { rejectUnauthorized: false });

  tvWs.on("open", () => console.log("[tv] connected"));

  tvWs.on("message", (data) => {
    const str = data.toString();
    try {
      const msg = JSON.parse(str);
      if (msg.event === "ms.channel.connect") {
        const newToken = msg.data && msg.data.token;
        if (newToken) { saveToken(newToken); console.log(`[tv] paired (token: ${newToken})`); }
        tvReady = true;
        if (tvQueue.length) {
          console.log(`[tv] flushing ${tvQueue.length} queued`);
          tvQueue.splice(0).forEach(d => tvWs.send(d));
        }
      } else if (msg.event === "ms.channel.unauthorized") {
        console.warn("[tv] rejected pairing — accept popup on TV");
        try { fs.unlinkSync(TOKEN_FILE); } catch {}
      }
    } catch {}
    broadcastRaw(str);
  });

  tvWs.on("close", () => {
    console.log("[tv] disconnected, reconnecting in 3s");
    tvReady = false;
    tvReconnectTimer = setTimeout(connectTV, 3000);
  });

  tvWs.on("error", (err) => console.error(`[tv] ${err.message}`));
}

// ---------- HTTP file server ----------
const server = http.createServer((req, res) => {
  const urlPath = (req.url === "/" ? "/index.html" : req.url).split("?")[0];
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

// ---------- Phone WebSocket handler ----------
const wss = new WebSocket.Server({ server });

wss.on("connection", (client) => {
  clients.add(client);
  startPolling();

  if (tvState.power !== "unknown") {
    client.send(JSON.stringify({ type: "state", power: tvState.power }));
  }
  // Phone just connected — if TV is already paired, tell it immediately so the
  // dot goes green without waiting for the next ms.channel.connect cycle.
  if (tvReady) {
    client.send(JSON.stringify({ event: "ms.channel.connect", data: { token: loadToken() } }));
  }

  console.log("[remote] phone connected");

  client.on("message", async (data) => {
    const str = data instanceof Buffer ? data.toString() : data;
    let msg = null;
    try { msg = JSON.parse(str); } catch {}

    if (msg && msg.type === "wol") {
      const mac = loadMac();
      if (!mac) { console.warn("[remote] WoL: no MAC cached"); return; }
      sendWol(mac);
      console.log(`[remote] WoL broadcast to ${mac}`);
      return;
    }
    if (msg && msg.type === "app") {
      console.log(`[remote] launching app ${msg.appId}`);
      const ok = await launchApp(msg.appId);
      console.log(`[remote] app launch ${msg.appId}: ${ok ? "OK" : "FAIL"}`);
      return;
    }

    sendToTV(str);
  });

  client.on("close", () => {
    clients.delete(client);
    if (clients.size === 0) stopPolling();
  });
});

server.listen(PORT, () => {
  console.log(`TV remote running on port ${PORT}`);
  connectTV();
});
