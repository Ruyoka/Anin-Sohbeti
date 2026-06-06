require("dotenv").config();

const express = require("express");
const rateLimit = require("express-rate-limit");
const { setupAllProcessGuards } = require('./src/utils/process-guard');
const {
  createSocketConnectionLimiter,
  createSocketEventRateManager,
} = require('./src/middleware/socket-rate-limit');
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PORT = process.env.PORT || 6000;
const TURNSTILE_SITE_KEY = (process.env.TURNSTILE_SITE_KEY || process.env.site_key || "").trim();
const TURNSTILE_SECRET_KEY = (process.env.TURNSTILE_SECRET_KEY || process.env.secret_key || "").trim();
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || "").trim();
const WAITING_STATUS_TEXT =
  "Şu anda herkes meşgul ya da eşleşecek kişi yok. Birisi ile eşleştiğinizde size bildirim göndereceğiz :)";
const POST_REPORT_REQUEUE_DELAY_MS = 5000;
const MESSAGE_RATE_LIMIT_MAX = Number(process.env.MESSAGE_RATE_LIMIT_MAX || 3);
const MESSAGE_RATE_LIMIT_WINDOW_MS = Number(process.env.MESSAGE_RATE_LIMIT_WINDOW_MS || 5000);
const CALL_RATE_LIMIT_MAX = Number(process.env.CALL_RATE_LIMIT_MAX || 4);
const CALL_RATE_LIMIT_WINDOW_MS = Number(process.env.CALL_RATE_LIMIT_WINDOW_MS || 10000);

// Security: Anti-spam constants
const MAX_QUEUE_SIZE = 500;               // Maksimum bekleme kuyrugu
const SOCKET_IDLE_TIMEOUT_MS = 120 * 1000; // 2 dk icinde join yapmayan socket atilir
const JOIN_RATE_LIMIT_PER_IP = 10;         // IP basina dakikada max join
const JOIN_RATE_WINDOW_MS = 60 * 1000;     // 1 dakika
const NICKNAME_MIN_LENGTH = 2;             // Minimum rumuz uzunlugu
const NICKNAME_MAX_LENGTH = 12;            // Maximum rumuz uzunlugu (display)
const BOT_DETECT_CONNECTION_BURST = 30;    // Ayni IP'den 30+ baglanti / 10sn = bot
const BOT_DETECT_BURST_WINDOW_MS = 10 * 1000;
const BOT_BLOCK_DURATION_MS = 30 * 60 * 1000; // 30 dk blok

function logSecurityEvent(level, event, details = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...details,
  };
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(`[${event}]`, payload);
}

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1" ? 1 : 0);
app.disable("x-powered-by");
app.use(express.json({ limit: '1mb' }));
const server = http.createServer(app);

// DDoS: sunucu seviyesi baglanti limitleri
server.maxConnections = 512;
server.keepAliveTimeout = 10000;
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.timeout = 60000;

const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN || '*' },
  allowRequest: (req, callback) => {
    if (!CLIENT_ORIGIN) {
      callback(null, true);
      return;
    }
    const origin = req.headers.origin || '';
    callback(null, origin === CLIENT_ORIGIN);
  },
  maxHttpBufferSize: 256 * 1024, // 256 KB maksimum paket
  pingInterval: 25000,
  pingTimeout: 20000,
  allowEIO3: false,
  connectTimeout: 30000,
  transports: ['websocket', 'polling'],
});

// Socket.IO IP bazli baglanti sinirlayici middleware - SIKILASTIRILDI
io.use(createSocketConnectionLimiter(3, 10, 10 * 60 * 1000, 60 * 1000));

// Socket event rate manager - EK EVENT'LER ILE GUCLENDIRILDI
const socketEventRateManager = createSocketEventRateManager();
socketEventRateManager.register('message', 3, 60000);     // 3/dk
socketEventRateManager.register('voice-call:request', 4, 10000); // 4/10sn
socketEventRateManager.register('join', 3, 30000);       // 3/30sn (sikilastirildi)
// YENI: spam-olasilikli event limits
socketEventRateManager.register('block-user', 10, 60000);
socketEventRateManager.register('report', 5, 60000);
socketEventRateManager.register('typing', 10, 30000);
io.socketEventRateManager = socketEventRateManager;

// IP bazli global join rate limiter (socket'ler arasi)
const ipJoinCounts = new Map(); // ip -> { count, resetAt }
const ipBotBlocked = new Map(); // ip -> blockedUntil
const ipConnectionTimestamps = new Map(); // ip -> [timestamps...]

function getClientIp(socket) {
  const trustProxy = process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1";
  if (trustProxy) {
    const forwarded = socket.handshake?.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }
  return socket.handshake?.address || socket.conn?.remoteAddress || "unknown";
}

function isIpBotBlocked(ip) {
  const blockedUntil = ipBotBlocked.get(ip);
  if (blockedUntil && blockedUntil > Date.now()) {
    return true;
  }
  if (blockedUntil) {
    ipBotBlocked.delete(ip);
  }
  return false;
}

function blockIpForBot(ip) {
  const until = Date.now() + BOT_BLOCK_DURATION_MS;
  ipBotBlocked.set(ip, until);
  logSecurityEvent('warn', 'BOT-DETECT', { ip, blockedUntil: until, reason: 'connection-burst' });
}

function trackIpConnection(ip) {
  const now = Date.now();
  let timestamps = ipConnectionTimestamps.get(ip);
  if (!timestamps) {
    timestamps = [];
    ipConnectionTimestamps.set(ip, timestamps);
  }
  timestamps.push(now);
  // Son 10sn'deki baglantilari filtrele
  const cutoff = now - BOT_DETECT_BURST_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }
  // Cok fazla baglanti varsa bot tespit et
  if (timestamps.length > BOT_DETECT_CONNECTION_BURST) {
    blockIpForBot(ip);
    return true;
  }
  return false;
}

function checkIpJoinRate(ip) {
  const now = Date.now();
  let entry = ipJoinCounts.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 1, resetAt: now + JOIN_RATE_WINDOW_MS };
    ipJoinCounts.set(ip, entry);
    return true;
  }
  entry.count++;
  if (entry.count > JOIN_RATE_LIMIT_PER_IP) {
    return false;
  }
  return true;
}

// Periyodik temizlik: IP join counts, timestamps (5 dk)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipJoinCounts.entries()) {
    if (entry.resetAt <= now) ipJoinCounts.delete(ip);
  }
  for (const [ip, timestamps] of ipConnectionTimestamps.entries()) {
    const cutoff = now - BOT_DETECT_BURST_WINDOW_MS;
    while (timestamps.length > 0 && timestamps[0] < cutoff) timestamps.shift();
    if (timestamps.length === 0) ipConnectionTimestamps.delete(ip);
  }
  for (const [ip, blockedUntil] of ipBotBlocked.entries()) {
    if (blockedUntil <= now) ipBotBlocked.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// Sunucu yuk kontrolu: asiri baglanti durumunda erken reddet
let serverOverloaded = false;
server.on('connection', (socket) => {
  if (serverOverloaded) {
    socket.destroy();
    return;
  }
  if (server._connections > 400) {
    serverOverloaded = true;
    logSecurityEvent('warn', 'SERVER-OVERLOAD', { connections: server._connections });
    setTimeout(() => { serverOverloaded = false; }, 15000);
  }
});

const RECENT_MATCH_COOLDOWN_MS = 60 * 1000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "manifest-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' https://cdn.socket.io https://www.googletagmanager.com https://challenges.cloudflare.com",
  "connect-src 'self' ws: wss: https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
].join("; ");

const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_URL = process.env.CUSTOM_DOMAIN || process.env.R2_PUBLIC_URL;
const R2_REGION = process.env.R2_REGION || "auto";

const hasR2Credentials =
  Boolean(process.env.R2_ENDPOINT) &&
  Boolean(process.env.R2_ACCESS_KEY) &&
  Boolean(process.env.R2_SECRET_KEY) &&
  Boolean(R2_BUCKET);

const r2Client = hasR2Credentials
  ? new S3Client({
      region: R2_REGION,
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY,
        secretAccessKey: process.env.R2_SECRET_KEY,
      },
      forcePathStyle: true,
    })
  : null;

const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const UPLOAD_COOLDOWN_MS = 60 * 1000;
const RATE_LIMIT_MESSAGE = "Çok seri gönderiyorsun azcık bekle";

const lastSuccessfulUploadBySocket = new Map();
const lastSuccessfulUploadByNickname = new Map();

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), geolocation=(), gyroscope=(), magnetometer=(), payment=(), usb=()",
  );
  next();
});

// HTTP rate limiter: express-rate-limit ile daha guclu koruma
const globalHttpLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 dakika
  max: 200,                   // IP basina 200 istek
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: (req, res) => {
    logSecurityEvent('warn', 'HTTP-RATE-LIMIT', { ip: req.ip, method: req.method, path: req.originalUrl || req.path });
    res.status(429).json({ error: 'Cok fazla istek gonderiyorsunuz. Lutfen yavaslayin.' });
  },
});
app.use(globalHttpLimiter);

// API route'lari icin daha sıkı rate limit (60 req/min)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
});
app.use('/api', apiLimiter);

// Upload presign endpoint icin ekstra siki rate limit (5 req/min)
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: (req, res) => {
    res.status(429).json({ error: 'rate_limited', message: 'Cok fazla yukleme denemesi yaptiniz. Lutfen bekleyin.' });
  },
});
app.use('/api/uploads', uploadLimiter);

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/turnstile-config", (_req, res) => {
  res.json({
    enabled: Boolean(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY),
    siteKey: TURNSTILE_SITE_KEY,
  });
});

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
]);

function normalizePublicUrl(base) {
  if (!base) {
    return null;
  }
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

const normalizedPublicUrl = normalizePublicUrl(R2_PUBLIC_URL);

function getClientIpForUpload(socket) {
  const trustProxy = process.env.TRUST_PROXY === "true" || process.env.TRUST_PROXY === "1";
  if (trustProxy) {
    const forwarded = socket.handshake?.headers?.["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }
  return socket.handshake?.address || socket.conn?.remoteAddress || "";
}

async function verifyTurnstileToken(token, remoteIp = "") {
  const safeToken = typeof token === "string" ? token.trim() : "";
  if (!TURNSTILE_SECRET_KEY || !safeToken) {
    return { ok: false, error: "missing_key_or_token" };
  }

  const body = new URLSearchParams({
    secret: TURNSTILE_SECRET_KEY,
    response: safeToken,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn("[TURNSTILE] Cloudflare API HTTP hatasi", { status: response.status, statusText: response.statusText });
      return { ok: false, error: "http_error" };
    }

    const result = await response.json();
    const success = result && result.success === true;

    if (!success) {
      const errorCodes = Array.isArray(result?.["error-codes"]) ? result["error-codes"] : [];
      console.warn("[TURNSTILE] dogrulama basarisiz", { errorCodes, siteKey: TURNSTILE_SITE_KEY.slice(0, 8) + "..." });
      return { ok: false, error: "invalid_token", codes: errorCodes };
    }

    return { ok: true };
  } catch (error) {
    clearTimeout(timeoutId);
    const isTimeout = error?.name === "AbortError";
    console.warn("[TURNSTILE] istek hatasi", {
      isTimeout,
      message: error?.message || String(error),
    });
    // Network hatasi / timeout -> kullaniciyi bloklama, logla ve allow (degrade)
    return { ok: true, degraded: true };
  }
}

function getRateLimitNickname(value) {
  return sanitizeNickname(typeof value === "string" ? value : "").slice(0, 50);
}

function getLastSuccessfulUploadTimestamp({ socketId, nickname }) {
  const socketTimestamp =
    socketId && lastSuccessfulUploadBySocket.has(socketId)
      ? lastSuccessfulUploadBySocket.get(socketId)
      : 0;
  const nicknameTimestamp =
    nickname && lastSuccessfulUploadByNickname.has(nickname)
      ? lastSuccessfulUploadByNickname.get(nickname)
      : 0;

  const safeSocketTimestamp =
    typeof socketTimestamp === "number" && Number.isFinite(socketTimestamp)
      ? socketTimestamp
      : 0;
  const safeNicknameTimestamp =
    typeof nicknameTimestamp === "number" && Number.isFinite(nicknameTimestamp)
      ? nicknameTimestamp
      : 0;

  return Math.max(safeSocketTimestamp, safeNicknameTimestamp, 0);
}

function getUploadCooldownRemaining({ socketId, nickname, now = Date.now() }) {
  const lastTimestamp = getLastSuccessfulUploadTimestamp({ socketId, nickname });
  if (!lastTimestamp) {
    return 0;
  }
  const expiresAt = lastTimestamp + UPLOAD_COOLDOWN_MS;
  return Math.max(0, expiresAt - now);
}

function isUploadRateLimited({ socketId, nickname, now = Date.now() }) {
  return getUploadCooldownRemaining({ socketId, nickname, now }) > 0;
}

function markSuccessfulUpload({ socketId, nickname, timestamp = Date.now() }) {
  if (socketId) {
    lastSuccessfulUploadBySocket.set(socketId, timestamp);
  }
  if (nickname) {
    lastSuccessfulUploadByNickname.set(nickname, timestamp);
  }
}

function sendUploadRateLimitMessage({ socketId, nickname }) {
  const payload = {
    text: RATE_LIMIT_MESSAGE,
    nickname: "Sistem",
  };

  const targets = new Set();
  if (socketId && io.sockets.sockets.get(socketId)) {
    targets.add(socketId);
  }

  if (nickname) {
    for (const [id, storedNickname] of nicknames.entries()) {
      if (storedNickname === nickname && io.sockets.sockets.get(id)) {
        targets.add(id);
      }
    }
  }

  for (const target of targets) {
    io.to(target).emit("message", payload);
  }

  return targets.size > 0;
}

function getExtensionFromMime(mime) {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/avif":
      return "avif";
    default:
      return "";
  }
}

function getExtensionFromName(name) {
  if (typeof name !== "string") {
    return "";
  }
  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1) {
    return "";
  }
  const ext = name.slice(lastDot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,6}$/.test(ext)) {
    return "";
  }
  return ext;
}

function formatTimestampForKey(date = new Date()) {
  const pad = (value) => value.toString().padStart(2, "0");
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "_" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function buildImageObjectKey({ nickname, extension }) {
  const safeNickname = sanitizeNickname(nickname || "")
    .toLocaleLowerCase("tr-TR")
    .slice(0, 24) || "anonim";
  const timestamp = formatTimestampForKey();
  const randomId = crypto.randomBytes(3).toString("hex");
  const suffix = extension ? `.${extension}` : "";
  return `temp-images/user_${safeNickname}_${timestamp}_${randomId}${suffix}`;
}

app.use(express.static(path.join(__dirname, "public")));

app.get(["/privacy", "/privacy.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy", "index.html"));
});

app.post("/api/uploads/presign", async (req, res) => {
  try {
    if (!r2Client || !normalizedPublicUrl) {
      res.status(503).json({ error: "storage_not_configured" });
      return;
    }

    const {
      contentType,
      fileName,
      nickname: rawNickname,
      fileSize,
      socketId: rawSocketId,
    } = req.body || {};
    const socketId = typeof rawSocketId === "string" ? rawSocketId : "";
    const sanitizedNickname = getRateLimitNickname(rawNickname);
    const now = Date.now();

    const cooldownRemaining = getUploadCooldownRemaining({
      socketId,
      nickname: sanitizedNickname,
      now,
    });

    if (cooldownRemaining > 0) {
      sendUploadRateLimitMessage({ socketId, nickname: sanitizedNickname });
      res.status(429).json({
        error: "rate_limited",
        message: RATE_LIMIT_MESSAGE,
        retryAfterSeconds: Math.ceil(cooldownRemaining / 1000),
      });
      return;
    }
    const mime = typeof contentType === "string" ? contentType.toLowerCase() : "";
    const sizeValue = Number(fileSize);
    const sizeInBytes =
      Number.isFinite(sizeValue) && sizeValue > 0 ? Math.round(sizeValue) : NaN;

    if (!ALLOWED_IMAGE_TYPES.has(mime)) {
      res.status(400).json({ error: "unsupported_type" });
      return;
    }

    if (!Number.isFinite(sizeInBytes)) {
      res.status(400).json({ error: "invalid_size" });
      return;
    }

    if (sizeInBytes > MAX_UPLOAD_SIZE_BYTES) {
      res.status(413).json({ error: "file_too_large", limit: MAX_UPLOAD_SIZE_BYTES });
      return;
    }

    const extensionFromMime = getExtensionFromMime(mime);
    const fallbackExt = getExtensionFromName(typeof fileName === "string" ? fileName : "");
    const extension = extensionFromMime || fallbackExt;

    const key = buildImageObjectKey({ nickname: rawNickname, extension });

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      ContentType: mime,
      ContentLength: sizeInBytes,
    });

    const uploadUrl = await getSignedUrl(r2Client, command, { expiresIn: 60 });
    const assetUrl = `${normalizedPublicUrl}/${key}`;

    res.json({
      uploadUrl,
      key,
      assetUrl,
      contentType: mime,
      maxSize: MAX_UPLOAD_SIZE_BYTES,
    });
  } catch (error) {
    console.error("Failed to create presigned URL", error);
    res.status(500).json({ error: "presign_failed" });
  }
});

let queue = [];
const partners = new Map();
const nicknames = new Map();
const waitTimers = new Map();
const recentMatches = new Map();
const blockedUsers = new Map();
let scheduledTryMatchHandle = null;
let scheduledTryMatchTime = 0;
const callRequestsByCaller = new Map();
const callRequestsByCallee = new Map();
const eventRateLimits = new Map();

// Periyodik temizlik: eski event rate limit kayitlarini temizle (10 dk)
setInterval(() => {
  const now = Date.now();
  for (const [socketId, buckets] of eventRateLimits.entries()) {
    const socket = io.sockets?.sockets?.get(socketId);
    if (!socket) {
      // Baglantisi kopmus socket'in kayitlarini temizle
      eventRateLimits.delete(socketId);
      continue;
    }
    // Her bucket icindeki zamani gecmis kayitlari temizle
    for (const [eventName, timestamps] of buckets.entries()) {
      const filtered = timestamps.filter(ts => now - ts < 30000);
      if (filtered.length === 0) {
        buckets.delete(eventName);
      } else {
        buckets.set(eventName, filtered);
      }
    }
    if (buckets.size === 0) {
      eventRateLimits.delete(socketId);
    }
  }
}, 10 * 60 * 1000).unref();

// Periyodik temizlik: baglantisi kopmus bloke kullanicilari temizle (15 dk)
setInterval(() => {
  for (const [socketId, blockedSet] of blockedUsers.entries()) {
    const socket = io.sockets?.sockets?.get(socketId);
    if (!socket) {
      blockedUsers.delete(socketId);
    }
  }
}, 15 * 60 * 1000).unref();

function getPairKey(firstId, secondId) {
  return [firstId, secondId].sort().join(":");
}

function getCooldownRemaining(firstId, secondId, now = Date.now()) {
  const key = getPairKey(firstId, secondId);
  const timestamp = recentMatches.get(key);
  if (!timestamp) {
    return 0;
  }
  const remaining = RECENT_MATCH_COOLDOWN_MS - (now - timestamp);
  if (remaining <= 0) {
    recentMatches.delete(key);
    return 0;
  }
  return remaining;
}

function recordRecentMatch(firstId, secondId) {
  const key = getPairKey(firstId, secondId);
  const timestamp = Date.now();
  recentMatches.set(key, timestamp);
  setTimeout(() => {
    const stored = recentMatches.get(key);
    if (stored && stored <= timestamp) {
      recentMatches.delete(key);
    }
  }, RECENT_MATCH_COOLDOWN_MS);
}

function clearScheduledTryMatch() {
  if (scheduledTryMatchHandle) {
    clearTimeout(scheduledTryMatchHandle);
    scheduledTryMatchHandle = null;
    scheduledTryMatchTime = 0;
  }
}

function pruneEventTimestamps(socketId, eventName, windowMs, now = Date.now()) {
  const socketBuckets = eventRateLimits.get(socketId);
  if (!socketBuckets) {
    return [];
  }

  const timestamps = socketBuckets.get(eventName) || [];
  const filtered = timestamps.filter((timestamp) => now - timestamp < windowMs);
  if (filtered.length === 0) {
    socketBuckets.delete(eventName);
    if (socketBuckets.size === 0) {
      eventRateLimits.delete(socketId);
    }
    return [];
  }

  socketBuckets.set(eventName, filtered);
  return filtered;
}

function isRateLimited(socketId, eventName, maxEvents, windowMs) {
  const now = Date.now();
  const timestamps = pruneEventTimestamps(socketId, eventName, windowMs, now);
  if (timestamps.length >= maxEvents) {
    return true;
  }

  let socketBuckets = eventRateLimits.get(socketId);
  if (!socketBuckets) {
    socketBuckets = new Map();
    eventRateLimits.set(socketId, socketBuckets);
  }

  socketBuckets.set(eventName, [...timestamps, now]);
  return false;
}

function scheduleTryMatchAfter(delayMs) {
  const delay = Math.max(0, delayMs);
  const targetTime = Date.now() + delay;
  if (scheduledTryMatchHandle && scheduledTryMatchTime <= targetTime) {
    return;
  }
  clearScheduledTryMatch();
  scheduledTryMatchHandle = setTimeout(() => {
    clearScheduledTryMatch();
    tryMatch();
  }, delay);
  scheduledTryMatchTime = targetTime;
}

function removeCallRequestByCaller(callerId) {
  const request = callRequestsByCaller.get(callerId);
  if (!request) {
    return null;
  }
  callRequestsByCaller.delete(callerId);
  callRequestsByCallee.delete(request.calleeId);
  return request;
}

function removeCallRequestByCallee(calleeId) {
  const request = callRequestsByCallee.get(calleeId);
  if (!request) {
    return null;
  }
  callRequestsByCallee.delete(calleeId);
  callRequestsByCaller.delete(request.callerId);
  return request;
}

function clearCallRequestsForSocket(socketId, reason = "cancelled") {
  const outgoing = removeCallRequestByCaller(socketId);
  if (outgoing) {
    io.to(outgoing.calleeId).emit("voice-call:request:cancelled", {
      recipientRole: "callee",
      reason,
    });
    io.to(outgoing.callerId).emit("voice-call:request:cancelled", {
      recipientRole: "caller",
      reason,
    });
  }
  const incoming = removeCallRequestByCallee(socketId);
  if (incoming) {
    io.to(incoming.callerId).emit("voice-call:request:cancelled", {
      recipientRole: "caller",
      reason,
    });
    io.to(incoming.calleeId).emit("voice-call:request:cancelled", {
      recipientRole: "callee",
      reason,
    });
  }
}

function getBlockedSet(socketId) {
  let set = blockedUsers.get(socketId);
  if (!set) {
    set = new Set();
    blockedUsers.set(socketId, set);
  }
  return set;
}

function addBlockedUser(reporterId, blockedId) {
  if (!blockedId) {
    return;
  }
  const blockedSet = getBlockedSet(reporterId);
  blockedSet.add(blockedId);
}

function isPairBlocked(firstId, secondId) {
  const firstBlocked = blockedUsers.get(firstId);
  if (firstBlocked && firstBlocked.has(secondId)) {
    return true;
  }
  const secondBlocked = blockedUsers.get(secondId);
  if (secondBlocked && secondBlocked.has(firstId)) {
    return true;
  }
  return false;
}

function notifyWaitingStatus(socketId, active) {
  const socketExists = io.sockets.sockets.get(socketId);
  if (!socketExists) {
    return;
  }
  io.to(socketId).emit("waitingStatus", { active, message: WAITING_STATUS_TEXT });
}

function clearWaitTimer(socketId) {
  const timer = waitTimers.get(socketId);
  if (timer) {
    clearTimeout(timer);
    waitTimers.delete(socketId);
  }
}

function startWaitTimer(socketId) {
  clearWaitTimer(socketId);
  const timer = setTimeout(() => {
    waitTimers.delete(socketId);
    const socketExists = io.sockets.sockets.get(socketId);
    if (!socketExists) return;
    if (partners.has(socketId)) return;
    if (!queue.includes(socketId)) return;
    notifyWaitingStatus(socketId, true);
  }, 5000);
  waitTimers.set(socketId, timer);
}

function endCurrentChat(socketId, options = {}) {
  const { skipNotifyPartner = false } = options;
  clearCallRequestsForSocket(socketId, "ended");
  queue = queue.filter((id) => id !== socketId);
  clearWaitTimer(socketId);
  notifyWaitingStatus(socketId, false);

  const partnerId = partners.get(socketId);
  partners.delete(socketId);

  if (!partnerId) {
    return;
  }

  clearCallRequestsForSocket(partnerId, "ended");

  partners.delete(partnerId);
  queue = queue.filter((id) => id !== partnerId);
  clearWaitTimer(partnerId);
  notifyWaitingStatus(partnerId, false);
  io.to(partnerId).emit("typing", { isTyping: false });

  io.to(partnerId).emit("voice-call:peer-ended");

  if (!skipNotifyPartner) {
    io.to(partnerId).emit("ended");
  }
}

function enqueueSocketId(socketId) {
  const socketExists = io.sockets.sockets.get(socketId);
  if (!socketExists) return;
  if (partners.has(socketId)) return;
  if (queue.includes(socketId)) return;

  // Anti-spam: Kuyruk limiti - cok fazlaysa reddet
  if (queue.length >= MAX_QUEUE_SIZE) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit("join:error", {
        reason: "queue-full",
        message: "Sunucu su anda cok yogun. Lutfen daha sonra tekrar deneyin.",
      });
    }
    console.warn('[QUEUE] Queue limitine ulasildi, yeni kullanici reddedildi', { queueSize: queue.length, maxSize: MAX_QUEUE_SIZE });
    return;
  }

  notifyWaitingStatus(socketId, false);
  queue.push(socketId);
  startWaitTimer(socketId);
}

const nicknameLetterPattern = (() => {
  try {
    return /[\p{L}]/u;
  } catch (_error) {
    return /[A-Za-z\u00C0-\u024F]/u;
  }
})();

function sanitizeNickname(value) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized =
    typeof value.normalize === "function" ? value.normalize("NFKC") : value;

  let filtered = "";
  for (const char of normalized) {
    nicknameLetterPattern.lastIndex = 0;
    if (nicknameLetterPattern.test(char)) {
      filtered += char;
    }
  }

  // Anti-bot: minimum uzunluk kontrolu
  if (filtered.length < 2) {
    return "";
  }

  return filtered;
}

/**
 * Bot tespit: supheli rumuz pattern'leri
 * - Tamamen ayni karakter tekrari ("aaaa", "111")
 * - Sadece sayi ve ozel karakter
 * - Anlamsiz uzun rastgele diziler (hash-benzeri)
 */
function isSuspiciousNickname(nickname) {
  if (!nickname || nickname.length < 3) return false;

  // Tamamen ayni karakter: "aaaaa", "11111"
  if (new Set(nickname).size === 1) return true;

  // Sadece rakamlardan olusuyorsa ve kisa degilse
  if (/^[0-9]{5,}$/.test(nickname)) return true;

  // Rastgele gozuken uzun karakter dizileri (hash-benzeri): en az 8 karakter ve sadece hex
  if (/^[0-9a-f]{12,}$/i.test(nickname)) return true;

  // Cok fazla ardarda buyuk harf / kucuk harf degisimi (bot-generated)
  const transitions = (nickname.match(/[A-Z][a-z]|[a-z][A-Z]/g) || []).length;
  if (nickname.length >= 6 && transitions >= nickname.length * 0.5) return true;

  return false;
}

function tryMatch() {
  clearScheduledTryMatch();
  while (queue.length >= 2) {
    const pair = findNextPair();
    if (!pair) {
      break;
    }

    const { first, second } = pair;
    const firstSocket = io.sockets.sockets.get(first);
    const secondSocket = io.sockets.sockets.get(second);
    if (!firstSocket || !secondSocket) {
      if (firstSocket) {
        enqueueSocketId(first);
      }
      if (secondSocket) {
        enqueueSocketId(second);
      }
      continue;
    }

    partners.set(first, second);
    partners.set(second, first);
    clearWaitTimer(first);
    clearWaitTimer(second);
    notifyWaitingStatus(first, false);
    notifyWaitingStatus(second, false);
    recordRecentMatch(first, second);
    const firstNickname = nicknames.get(first) || "";
    const secondNickname = nicknames.get(second) || "";
    logSecurityEvent('info', 'CHAT-MATCH', {
      room: 'random-pair',
      participants: [
        { socketId: first, nickname: firstNickname, ip: getClientIp(firstSocket) },
        { socketId: second, nickname: secondNickname, ip: getClientIp(secondSocket) },
      ],
    });
    io.to(first).emit("matched", {
      partnerNickname: secondNickname,
      partnerId: second,
    });
    io.to(second).emit("matched", {
      partnerNickname: firstNickname,
      partnerId: first,
    });
  }
}

function findNextPair() {
  const now = Date.now();
  let minCooldownRemaining = null;

  for (let i = 0; i < queue.length; i++) {
    const first = queue[i];
    const firstSocket = io.sockets.sockets.get(first);
    if (!firstSocket || partners.has(first)) {
      queue.splice(i, 1);
      clearWaitTimer(first);
      i--;
      continue;
    }

    for (let j = i + 1; j < queue.length; j++) {
      const second = queue[j];
      const secondSocket = io.sockets.sockets.get(second);
      if (!secondSocket || partners.has(second)) {
        queue.splice(j, 1);
        clearWaitTimer(second);
        j--;
        continue;
      }

      const remaining = getCooldownRemaining(first, second, now);
      if (remaining > 0) {
        if (minCooldownRemaining === null || remaining < minCooldownRemaining) {
          minCooldownRemaining = remaining;
        }
        continue;
      }

      if (isPairBlocked(first, second)) {
        continue;
      }

      queue.splice(j, 1);
      queue.splice(i, 1);
      return { first, second };
    }
  }

  if (minCooldownRemaining !== null) {
    scheduleTryMatchAfter(minCooldownRemaining);
  }

  return null;
}

io.on("connection", (socket) => {
  const clientIp = getClientIp(socket);
  logSecurityEvent('info', 'SOCKET-CONNECT', { socketId: socket.id, ip: clientIp });

  // Bot tespit: baglanti hizi kontrolu
  if (trackIpConnection(clientIp)) {
    logSecurityEvent('warn', 'BOT-DETECT', { socketId: socket.id, ip: clientIp, reason: 'connection-burst-rejected' });
    socket.emit("join:error", {
      reason: "security-block",
      message: "Guvenlik nedeniyle baglantiniz reddedildi. Lutfen daha sonra tekrar deneyin.",
    });
    socket.disconnect(true);
    return;
  }

  // IP bot blok kontrolu
  if (isIpBotBlocked(clientIp)) {
    logSecurityEvent('warn', 'BOT-DETECT', { socketId: socket.id, ip: clientIp, reason: 'blocked-ip-retry' });
    socket.emit("join:error", {
      reason: "security-block",
      message: "IP adresiniz gecici olarak engellendi. Lutfen 30 dakika sonra tekrar deneyin.",
    });
    socket.disconnect(true);
    return;
  }

  blockedUsers.set(socket.id, new Set());
  socket.data = socket.data || {};
  socket.data.turnstileVerified = false;
  socket.data.connectedAt = Date.now();

  // Anti-spam: baglanti idle timeout - 2 dk icinde join yapmazsa at
  const idleTimer = setTimeout(() => {
    if (!partners.has(socket.id) && !nicknames.has(socket.id)) {
      logSecurityEvent('info', 'SOCKET-IDLE-TIMEOUT', { socketId: socket.id, ip: clientIp });
      socket.emit("join:error", {
        reason: "idle-timeout",
        message: "Baglantiniz cok uzun sure bos kaldi. Lutfen tekrar baglanin.",
      });
      socket.disconnect(true);
    }
  }, SOCKET_IDLE_TIMEOUT_MS);

  // Temizlik: socket disconnect oldugunda idle timer'i temizle
  const originalDisconnect = socket.disconnect.bind(socket);
  socket.on('disconnect', () => {
    clearTimeout(idleTimer);
  });

  socket.on("join", async (payload) => {
    clearTimeout(idleTimer); // Join yapti, timer'i temizle

    // IP bazli global join rate limit
    if (!checkIpJoinRate(clientIp)) {
      logSecurityEvent('warn', 'JOIN-RATE-LIMIT', { ip: clientIp, socketId: socket.id });
      socket.emit("join:error", { reason: "rate-limit", message: "Cok fazla katilma denemesi yaptiniz. Lutfen 1 dakika bekleyin." });
      return;
    }
    const rawNickname =
      payload && typeof payload === "object" && typeof payload.nickname === "string"
        ? payload.nickname
        : "";
    const cleanedNickname = sanitizeNickname(rawNickname).slice(0, NICKNAME_MAX_LENGTH);

    // Anti-bot: minimum rumuz uzunlugu kontrolu
    if (!cleanedNickname || cleanedNickname.length < NICKNAME_MIN_LENGTH) {
      socket.emit("join:error", { reason: "nickname", message: `Rumuz en az ${NICKNAME_MIN_LENGTH} karakter olmalidir.` });
      return;
    }

    // Anti-bot: supheli rumuz tespiti
    if (isSuspiciousNickname(cleanedNickname)) {
      logSecurityEvent('warn', 'BOT-DETECT', { nickname: cleanedNickname, ip: clientIp, socketId: socket.id, reason: 'suspicious-nickname' });
      socket.emit("join:error", {
        reason: "invalid-nickname",
        message: "Bu rumuz kullanilamaz. Lutfen farkli bir rumuz secin.",
      });
      return;
    }

    if (!socket.data.turnstileVerified) {
      if (!TURNSTILE_SITE_KEY || !TURNSTILE_SECRET_KEY) {
        // Turnstile yapilandirilmamis -> dogrulamayi atla
        socket.data.turnstileVerified = true;
      }
    }

    if (!socket.data.turnstileVerified) {
      // Anti-bot: honeypot kontrolu - bot'larin doldurdugu gizli alan
      if (payload && typeof payload === "object" && payload.honeypot && typeof payload.honeypot === "string" && payload.honeypot.length > 0) {
        logSecurityEvent('warn', 'BOT-DETECT', { ip: clientIp, socketId: socket.id, nickname: cleanedNickname, reason: 'honeypot' });
        socket.emit("join:error", {
          reason: "security",
          message: "Guvenlik kontrolu basarisiz. Lutfen sayfayi yenileyip tekrar deneyin.",
        });
        return;
      }

      const token =
        payload && typeof payload === "object" && typeof payload.turnstileToken === "string"
          ? payload.turnstileToken
          : "";
      const verification = await verifyTurnstileToken(token, getClientIpForUpload(socket));
      if (!verification.ok) {
        const codes = Array.isArray(verification.codes) ? verification.codes : [];
        const messages = [];
        if (codes.includes("timeout-or-duplicate")) {
          messages.push("Dogrulama suresi doldu. Lutfen tekrar deneyin.");
        } else if (codes.includes("invalid-input-response")) {
          messages.push("Gecersiz dogrulama kodu. Lutfen sayfayi yenileyip tekrar deneyin.");
        } else if (codes.includes("invalid-input-secret")) {
          console.error("[TURNSTILE] GECERSIZ SECRET KEY - servis devre disi");
          messages.push("Guvenlik dogrulamasi su anda yapilamiyor. Lutfen daha sonra tekrar deneyin.");
        }
        if (messages.length === 0) {
          messages.push("Guvenlik dogrulamasi basarisiz oldu. Lutfen tekrar deneyin.");
        }
        socket.emit("join:error", { reason: "turnstile", message: messages.join(" ") });
        return;
      }

      if (verification.degraded) {
        console.warn("[TURNSTILE] degrade modda calisiyor (network hatasi)");
      }

      socket.data.turnstileVerified = true;
    }

    nicknames.set(socket.id, cleanedNickname);
    logSecurityEvent('info', 'CHAT-JOIN', {
      socketId: socket.id,
      ip: clientIp,
      nickname: cleanedNickname,
      room: 'random-queue',
      queueSize: queue.length,
    });

    if (payload && typeof payload === "object" && Array.isArray(payload.blockedUsers)) {
      const blockedSet = getBlockedSet(socket.id);
      payload.blockedUsers
        .map((value) => value && value.toString())
        .filter((value) => typeof value === "string" && value)
        .forEach((value) => blockedSet.add(value));
    }
    if (partners.has(socket.id)) return;
    enqueueSocketId(socket.id);
    tryMatch();
  });

  socket.on("message", (msg) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;
    if (
      isRateLimited(
        socket.id,
        "message",
        MESSAGE_RATE_LIMIT_MAX,
        MESSAGE_RATE_LIMIT_WINDOW_MS,
      )
    ) {
      io.to(socket.id).emit("message:error", { reason: "rate-limited" });
      return;
    }

    const storedNickname = nicknames.get(socket.id) || "";
    const incoming =
      msg && typeof msg === "object"
        ? {
            text: (msg.text || "").toString().slice(0, 2000),
            nickname: (msg.nickname || "").toString().slice(0, 50),
          }
        : { text: (msg || "").toString().slice(0, 2000), nickname: "" };

    const providedNickname = sanitizeNickname(incoming.nickname).slice(0, 50);
    const effectiveNickname = providedNickname || storedNickname;
    const cleanedNickname = sanitizeNickname(effectiveNickname).slice(0, 50);

    io.to(partnerId).emit("message", {
      text: incoming.text,
      nickname: cleanedNickname,
    });
  });

  socket.on("image-message", (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;
    if (!payload || typeof payload !== "object") {
      return;
    }

    const storedNickname = nicknames.get(socket.id) || "";
    const providedNickname = sanitizeNickname((payload.nickname || "").toString()).slice(0, 50);
    const effectiveNickname = providedNickname || storedNickname;
    const cleanedNickname = sanitizeNickname(effectiveNickname).slice(0, 50);
    const rateLimitCheckTime = Date.now();

    if (
      isUploadRateLimited({
        socketId: socket.id,
        nickname: cleanedNickname,
        now: rateLimitCheckTime,
      })
    ) {
      sendUploadRateLimitMessage({ socketId: socket.id, nickname: cleanedNickname });
      return;
    }

    const assetUrl = typeof payload.url === "string" ? payload.url : "";
    const objectKey = typeof payload.key === "string" ? payload.key : "";
    const widthValue = Number(payload.width);
    const heightValue = Number(payload.height);
    const width = Number.isFinite(widthValue) && widthValue > 0 ? Math.round(widthValue) : undefined;
    const height = Number.isFinite(heightValue) && heightValue > 0 ? Math.round(heightValue) : undefined;

    if (!assetUrl || !objectKey) {
      return;
    }

    if (!objectKey.startsWith("temp-images/")) {
      return;
    }

    if (!normalizedPublicUrl || !assetUrl.startsWith(`${normalizedPublicUrl}/`)) {
      return;
    }

    io.to(partnerId).emit("image-message", {
      url: assetUrl,
      key: objectKey,
      width,
      height,
      nickname: cleanedNickname,
    });

    markSuccessfulUpload({
      socketId: socket.id,
      nickname: cleanedNickname,
      timestamp: Date.now(),
    });
  });

  socket.on("typing", (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const isTyping =
      payload && typeof payload === "object"
        ? Boolean(payload.isTyping)
        : Boolean(payload);

    io.to(partnerId).emit("typing", { isTyping: Boolean(isTyping) });
  });

  socket.on("voice-call:request", () => {
    if (
      isRateLimited(
        socket.id,
        "voice-call:request",
        CALL_RATE_LIMIT_MAX,
        CALL_RATE_LIMIT_WINDOW_MS,
      )
    ) {
      io.to(socket.id).emit("voice-call:request:error", { reason: "rate-limited" });
      return;
    }
    const partnerId = partners.get(socket.id);
    if (!partnerId) {
      io.to(socket.id).emit("voice-call:request:error", { reason: "no-partner" });
      return;
    }
    if (callRequestsByCaller.has(socket.id) || callRequestsByCallee.has(socket.id)) {
      return;
    }
    if (callRequestsByCaller.has(partnerId) || callRequestsByCallee.has(partnerId)) {
      io.to(socket.id).emit("voice-call:request:error", { reason: "busy" });
      return;
    }
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (!partnerSocket) {
      io.to(socket.id).emit("voice-call:request:error", { reason: "unavailable" });
      return;
    }
    const request = { callerId: socket.id, calleeId: partnerId };
    callRequestsByCaller.set(socket.id, request);
    callRequestsByCallee.set(partnerId, request);
    io.to(partnerId).emit("voice-call:request:incoming");
  });

  socket.on("voice-call:cancel-request", () => {
    const request = removeCallRequestByCaller(socket.id);
    if (!request) {
      return;
    }
    io.to(request.calleeId).emit("voice-call:request:cancelled", {
      recipientRole: "callee",
      reason: "cancelled",
    });
    io.to(request.callerId).emit("voice-call:request:cancelled", {
      recipientRole: "caller",
      reason: "cancelled",
    });
  });

  socket.on("voice-call:request-response", (payload) => {
    const request = removeCallRequestByCallee(socket.id);
    if (!request) {
      return;
    }
    const accepted = Boolean(payload && payload.accepted);
    if (accepted) {
      io.to(request.callerId).emit("voice-call:request:accepted", { role: "caller" });
      io.to(request.calleeId).emit("voice-call:request:accepted", { role: "callee" });
    } else {
      const reason =
        payload && typeof payload === "object" && typeof payload.reason === "string"
          ? payload.reason
          : "rejected";
      io.to(request.callerId).emit("voice-call:request:rejected", {
        reason,
        initiatedBy: "caller",
        recipientRole: "caller",
      });
      io.to(request.calleeId).emit("voice-call:request:rejected", {
        reason,
        initiatedBy: "caller",
        recipientRole: "callee",
      });
    }
  });

  socket.on("voice-call:offer", (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const data =
      payload && typeof payload === "object"
        ? { sdp: payload.sdp }
        : { sdp: null };

    io.to(partnerId).emit("voice-call:offer", data);
  });

  socket.on("voice-call:answer", (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const data =
      payload && typeof payload === "object"
        ? { sdp: payload.sdp }
        : { sdp: null };

    io.to(partnerId).emit("voice-call:answer", data);
  });

  socket.on("voice-call:candidate", (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const data =
      payload && typeof payload === "object"
        ? { candidate: payload.candidate }
        : { candidate: null };

    io.to(partnerId).emit("voice-call:candidate", data);
  });

  socket.on("voice-call:end", () => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("voice-call:ended");
  });

  socket.on("report", (payload) => {
    const partnerId = partners.get(socket.id);
    const reportedId =
      payload && typeof payload === "object" && typeof payload.partnerId === "string"
        ? payload.partnerId
        : partnerId;

    if (!partnerId || !reportedId || reportedId !== partnerId) {
      socket.emit("report:error", { reason: "no-partner" });
      return;
    }

    addBlockedUser(socket.id, reportedId);

    endCurrentChat(socket.id);

    socket.emit("reported", {
      message: "Kullanıcı engellendi, yeni eşleşme aranıyor...",
    });

    setTimeout(() => {
      enqueueSocketId(socket.id);
      tryMatch();
    }, POST_REPORT_REQUEUE_DELAY_MS);
  });

  socket.on("next", () => {
    endCurrentChat(socket.id);
    setTimeout(() => {
      enqueueSocketId(socket.id);
      tryMatch();
    }, 5000);
  });

  socket.on("disconnect", () => {
    eventRateLimits.delete(socket.id);
    const storedNickname = nicknames.get(socket.id) || "";
    const partnerId = partners.get(socket.id) || null;
    logSecurityEvent('info', 'CHAT-DISCONNECT', {
      socketId: socket.id,
      ip: clientIp,
      nickname: storedNickname,
      room: partnerId ? 'random-pair' : 'random-queue',
      partnerId,
    });
    endCurrentChat(socket.id);
    nicknames.delete(socket.id);
    blockedUsers.delete(socket.id);
    lastSuccessfulUploadBySocket.delete(socket.id);
    if (storedNickname) {
      let stillUsed = false;
      for (const [id, nicknameValue] of nicknames.entries()) {
        if (id !== socket.id && nicknameValue === storedNickname) {
          stillUsed = true;
          break;
        }
      }
      if (!stillUsed) {
        lastSuccessfulUploadByNickname.delete(storedNickname);
      }
    }
  });
});

// Process-level crash korumalari
setupAllProcessGuards();

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Anın Sohbeti ${PORT} portunda çalışıyor.`)
);
