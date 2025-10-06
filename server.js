require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 6000;
const WAITING_STATUS_TEXT =
  "Şu anda herkes meşgul ya da eşleşecek kişi yok. Birisi ile eşleştiğinizde size bildirim göndereceğiz :)";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const RECENT_MATCH_COOLDOWN_MS = 60 * 1000;

app.use(express.static("public"));

let queue = [];
const partners = new Map();
const nicknames = new Map();
const waitTimers = new Map();
const recentMatches = new Map();
let scheduledTryMatchHandle = null;
let scheduledTryMatchTime = 0;
const callRequestsByCaller = new Map();
const callRequestsByCallee = new Map();

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

function sanitizeNickname(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .toLocaleUpperCase("tr-TR")
    .replace(/[^\p{L}]/gu, "");
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
    io.to(first).emit("matched", { partnerNickname: secondNickname });
    io.to(second).emit("matched", { partnerNickname: firstNickname });
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

  socket.on("join", (payload) => {
    const rawNickname =
      payload && typeof payload === "object" && typeof payload.nickname === "string"
        ? payload.nickname
        : "";
    const cleanedNickname = sanitizeNickname(rawNickname).slice(0, 12);
    nicknames.set(socket.id, cleanedNickname);
    if (partners.has(socket.id)) return;
    enqueueSocketId(socket.id);
    tryMatch();
  });

  socket.on("message", (msg) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

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

  socket.on("voice-call:request", () => {
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

  socket.on("next", () => {
    endCurrentChat(socket.id);
    setTimeout(() => {
      enqueueSocketId(socket.id);
      tryMatch();
    }, 5000);
  });

  socket.on("disconnect", () => {
    endCurrentChat(socket.id);
    nicknames.delete(socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Anın Sohbeti ${PORT} portunda çalışıyor.`)
);
