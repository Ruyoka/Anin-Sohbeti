require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PORT = process.env.PORT || 6000;
const WAITING_STATUS_TEXT =
  "Şu anda herkes meşgul ya da eşleşecek kişi yok. Birisi ile eşleştiğinizde size bildirim göndereceğiz :)";
const POST_REPORT_REQUEUE_DELAY_MS = 5000;
const MESSAGE_RATE_LIMIT_MAX = Number(process.env.MESSAGE_RATE_LIMIT_MAX || 3);
const MESSAGE_RATE_LIMIT_WINDOW_MS = Number(process.env.MESSAGE_RATE_LIMIT_WINDOW_MS || 5000);
const CALL_RATE_LIMIT_MAX = Number(process.env.CALL_RATE_LIMIT_MAX || 4);
const CALL_RATE_LIMIT_WINDOW_MS = Number(process.env.CALL_RATE_LIMIT_WINDOW_MS || 10000);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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
  "script-src 'self' 'unsafe-inline' https://cdn.socket.io https://www.googletagmanager.com",
  "connect-src 'self' ws: wss: https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
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

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
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

  notifyWaitingStatus(socketId, false);
  queue.push(socketId);
  startWaitTimer(socketId);
}

const nicknameLetterPattern = (() => {
  try {
    return new RegExp("\\\\p{L}", "u");
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

  return filtered;
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
  console.log("Yeni kullanıcı:", socket.id);
  blockedUsers.set(socket.id, new Set());

  socket.on("join", (payload) => {
    const rawNickname =
      payload && typeof payload === "object" && typeof payload.nickname === "string"
        ? payload.nickname
        : "";
    const cleanedNickname = sanitizeNickname(rawNickname).slice(0, 12);
    nicknames.set(socket.id, cleanedNickname);

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
    endCurrentChat(socket.id);
    const storedNickname = nicknames.get(socket.id) || "";
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

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Anın Sohbeti ${PORT} portunda çalışıyor.`)
);
