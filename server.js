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

app.use(express.static("public"));

let queue = [];
const partners = new Map();
const waitTimers = new Map();
const callRequestsByCaller = new Map();
const callRequestsByCallee = new Map();

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

function dequeueAvailable() {
  while (queue.length) {
    const id = queue.shift();
    const socketExists = io.sockets.sockets.get(id);
    if (!socketExists) {
      notifyWaitingStatus(id, false);
      continue;
    }
    if (partners.has(id)) {
      continue;
    }
    return id;
  }
  return null;
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
  while (queue.length >= 2) {
    const first = dequeueAvailable();
    if (!first) break;
    const second = dequeueAvailable();
    if (!second) {
      queue.unshift(first);
      startWaitTimer(first);
      break;
    }

    const firstSocket = io.sockets.sockets.get(first);
    const secondSocket = io.sockets.sockets.get(second);
    if (!firstSocket || !secondSocket) {
      if (firstSocket) {
        queue.unshift(first);
        startWaitTimer(first);
      }
      continue;
    }

    partners.set(first, second);
    partners.set(second, first);
    clearWaitTimer(first);
    clearWaitTimer(second);
    notifyWaitingStatus(first, false);
    notifyWaitingStatus(second, false);
    io.to(first).emit("matched");
    io.to(second).emit("matched");
  }
}

io.on("connection", (socket) => {
  console.log("Yeni kullanıcı:", socket.id);

  socket.on("join", () => {
    if (partners.has(socket.id)) return;
    enqueueSocketId(socket.id);
    tryMatch();
  });

  socket.on("message", (msg) => {
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
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Anın Sohbeti ${PORT} portunda çalışıyor.`)
);
