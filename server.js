require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 6000;
const WAITING_STATUS_TEXT =
  "Şu anda herkes meşgul ya da eşleşecek kişi yok. Birisi ile eşleştiğinizde size bildirim göndereceğiz :)";
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

if (!TURNSTILE_SECRET_KEY) {
  console.warn("TURNSTILE_SECRET_KEY ortam değişkeni ayarlanmadı. Turnstile doğrulaması çalışmayacak.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static("public"));

app.post("/api/turnstile/verify", async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const rawToken =
    body.token || body.response || body["cf-turnstile-response"] || "";
  const token =
    typeof rawToken === "string"
      ? rawToken.trim()
      : String(rawToken || "").trim();

  if (!token) {
    return res
      .status(400)
      .json({ success: false, message: "Eksik Turnstile doğrulama jetonu." });
  }

  if (!TURNSTILE_SECRET_KEY) {
    return res.status(500).json({
      success: false,
      message: "Sunucu yapılandırması eksik. Lütfen daha sonra tekrar deneyin.",
    });
  }

  const params = new URLSearchParams();
  params.append("secret", TURNSTILE_SECRET_KEY);
  params.append("response", token);

  const forwardedFor = req.headers["x-forwarded-for"]; // may be string or array
  const remoteIp =
    req.headers["cf-connecting-ip"] ||
    (Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : typeof forwardedFor === "string"
        ? forwardedFor.split(",")[0].trim()
        : null) ||
    req.ip;

  if (remoteIp) {
    params.append("remoteip", remoteIp);
  }

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      }
    );

    if (!response.ok) {
      throw new Error(`Turnstile doğrulaması başarısız yanıt kodu: ${response.status}`);
    }

    const data = await response.json();

    if (data.success) {
      return res.json({ success: true });
    }

    console.warn("Turnstile doğrulaması geçersiz", data["error-codes"] || []);

    return res.status(400).json({
      success: false,
      message: "Turnstile doğrulaması başarısız oldu.",
      errors: data["error-codes"] || [],
    });
  } catch (error) {
    console.error("Turnstile doğrulaması sırasında hata oluştu:", error);
    return res.status(500).json({
      success: false,
      message: "Turnstile doğrulaması sırasında bir hata oluştu.",
    });
  }
});

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
