require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 6000;
const WAITING_STATUS_TEXT =
  "Şu anda herkes meşgul ya da eşleşecek kişi yok. Birisi ile eşleştiğinizde size bildirim göndereceğiz :)";
const CLIENT_ORIGIN = (process.env.CLIENT_ORIGIN || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const MESSAGE_RATE_LIMIT_MAX = Number(process.env.MESSAGE_RATE_LIMIT_MAX || 8);
const MESSAGE_RATE_LIMIT_WINDOW_MS = Number(process.env.MESSAGE_RATE_LIMIT_WINDOW_MS || 5000);
const JOIN_RATE_LIMIT_MAX = Number(process.env.JOIN_RATE_LIMIT_MAX || 6);
const JOIN_RATE_LIMIT_WINDOW_MS = Number(process.env.JOIN_RATE_LIMIT_WINDOW_MS || 15000);
const CALL_RATE_LIMIT_MAX = Number(process.env.CALL_RATE_LIMIT_MAX || 12);
const CALL_RATE_LIMIT_WINDOW_MS = Number(process.env.CALL_RATE_LIMIT_WINDOW_MS || 10000);

const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN.includes("*") ? "*" : CLIENT_ORIGIN,
  },
  allowRequest: (req, callback) => {
    callback(null, isOriginAllowed(req.headers.origin));
  },
});

const RECENT_MATCH_COOLDOWN_MS = 60 * 1000;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "manifest-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' https://cdn.socket.io https://www.googletagmanager.com",
  "connect-src 'self' ws: wss: https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
].join("; ");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), geolocation=(), gyroscope=(), magnetometer=(), payment=(), usb=()"
  );
  next();
});

app.use(
  express.static("public", {
    dotfiles: "deny",
  })
);
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

let queue = [];
const partners = new Map();
const waitTimers = new Map();
const recentMatches = new Map();
let scheduledTryMatchHandle = null;
let scheduledTryMatchTime = 0;
const callRequestsByCaller = new Map();
const callRequestsByCallee = new Map();
const eventRateLimits = new Map();

function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }
  if (CLIENT_ORIGIN.includes("*")) {
    return true;
  }
  return CLIENT_ORIGIN.includes(origin);
}

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
    io.to(first).emit("matched");
    io.to(second).emit("matched");
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

  socket.on("join", () => {
    if (isRateLimited(socket.id, "join", JOIN_RATE_LIMIT_MAX, JOIN_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    if (partners.has(socket.id)) return;
    enqueueSocketId(socket.id);
    tryMatch();
  });

  socket.on("message", (msg) => {
    if (
      isRateLimited(
        socket.id,
        "message",
        MESSAGE_RATE_LIMIT_MAX,
        MESSAGE_RATE_LIMIT_WINDOW_MS
      )
    ) {
      io.to(socket.id).emit("message:error", { reason: "rate-limited" });
      return;
    }
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const payload =
      msg && typeof msg === "object"
        ? {
            text: (msg.text || "").toString().slice(0, 2000),
            nickname: (msg.nickname || "").toString().slice(0, 50),
          }
        : { text: (msg || "").toString().slice(0, 2000), nickname: "" };

    io.to(partnerId).emit("message", payload);
  });

  socket.on("voice-call:request", () => {
    if (
      isRateLimited(
        socket.id,
        "voice-call:request",
        CALL_RATE_LIMIT_MAX,
        CALL_RATE_LIMIT_WINDOW_MS
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
    if (
      isRateLimited(
        socket.id,
        "voice-call:cancel-request",
        CALL_RATE_LIMIT_MAX,
        CALL_RATE_LIMIT_WINDOW_MS
      )
    ) {
      return;
    }
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
    if (
      isRateLimited(
        socket.id,
        "voice-call:request-response",
        CALL_RATE_LIMIT_MAX,
        CALL_RATE_LIMIT_WINDOW_MS
      )
    ) {
      return;
    }
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
    if (
      isRateLimited(socket.id, "voice-call:offer", CALL_RATE_LIMIT_MAX, CALL_RATE_LIMIT_WINDOW_MS)
    ) {
      return;
    }
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const data =
      payload && typeof payload === "object"
        ? { sdp: payload.sdp }
        : { sdp: null };

    io.to(partnerId).emit("voice-call:offer", data);
  });

  socket.on("voice-call:answer", (payload) => {
    if (
      isRateLimited(
        socket.id,
        "voice-call:answer",
        CALL_RATE_LIMIT_MAX,
        CALL_RATE_LIMIT_WINDOW_MS
      )
    ) {
      return;
    }
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const data =
      payload && typeof payload === "object"
        ? { sdp: payload.sdp }
        : { sdp: null };

    io.to(partnerId).emit("voice-call:answer", data);
  });

  socket.on("voice-call:candidate", (payload) => {
    if (
      isRateLimited(
        socket.id,
        "voice-call:candidate",
        CALL_RATE_LIMIT_MAX * 4,
        CALL_RATE_LIMIT_WINDOW_MS
      )
    ) {
      return;
    }
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const data =
      payload && typeof payload === "object"
        ? { candidate: payload.candidate }
        : { candidate: null };

    io.to(partnerId).emit("voice-call:candidate", data);
  });

  socket.on("voice-call:end", () => {
    if (
      isRateLimited(socket.id, "voice-call:end", CALL_RATE_LIMIT_MAX, CALL_RATE_LIMIT_WINDOW_MS)
    ) {
      return;
    }
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("voice-call:ended");
  });

  socket.on("next", () => {
    if (isRateLimited(socket.id, "next", JOIN_RATE_LIMIT_MAX, JOIN_RATE_LIMIT_WINDOW_MS)) {
      return;
    }
    endCurrentChat(socket.id);
    setTimeout(() => {
      enqueueSocketId(socket.id);
      tryMatch();
    }, 5000);
  });

  socket.on("disconnect", () => {
    eventRateLimits.delete(socket.id);
    endCurrentChat(socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Anın Sohbeti ${PORT} portunda çalışıyor.`)
);
