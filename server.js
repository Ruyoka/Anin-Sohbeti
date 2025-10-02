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
  queue = queue.filter((id) => id !== socketId);
  clearWaitTimer(socketId);
  notifyWaitingStatus(socketId, false);

  const partnerId = partners.get(socketId);
  partners.delete(socketId);

  if (!partnerId) {
    return;
  }

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

  socket.on("voice-call:request", () => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("voice-call:incoming-request");
  });

  socket.on("voice-call:respond", (payload = {}) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    const accepted = Boolean(payload.accepted);
    const reason =
      typeof payload.reason === "string"
        ? payload.reason.slice(0, 40)
        : "";

    if (accepted) {
      io.to(partnerId).emit("voice-call:request-accepted");
    } else {
      io
        .to(partnerId)
        .emit("voice-call:request-rejected", { reason: reason || "declined" });
    }
  });

  socket.on("voice-call:cancel-request", () => {
    const partnerId = partners.get(socket.id);
    if (!partnerId) return;

    io.to(partnerId).emit("voice-call:request-cancelled");
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
