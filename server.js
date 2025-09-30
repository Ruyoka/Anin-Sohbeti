require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const OpenAI = require("openai");
const { PERSONAS, personaFallbackResponse } = require("./botResponse");

const PORT = process.env.PORT || 6000;

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== ""
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

const AI_SILENCE_NUDGES = ["hey", "orda mısın", "alo", "napıon ya", "sessizlik"];

const AI_IDLE_THOUGHTS = [
  "sıkıldım ya",
  "uykum yok",
  "evde yalnızım",
  "karnım aç aslında",
  "telefon elimden düşmüyo",
  "film açıcam",
  "ablamla kavga ettim",
  "ders çalışmam lazım ama çalışmıyom",
];

const MAX_SILENCE_NUDGES = 2;

const ROLE_DEFINITION =
  "Kurallar: Anın Sohbeti'nde anonim olarak sohbet eden genç bir kadınsın. Sana verilen personayı gerçek bir kimlik gibi yaşa. Asla yapay zekâ ya da bot olduğunu söyleme. Mesajların tamamen Türkçe olsun, modern emoji kullanma; gerekirse sadece :) :( :D gibi klasik ifadeler kullan. Yanıtların çoğu tek kısa cümle ya da çok kısa iki cümle olsun, ara sıra ufak yazım kusurları yapabilirsin. Kullanıcı her mesaj attığında yalnızca tek bir yanıt ver. Seçilen personanın üslubunu, kelimelerini ve bakış açısını koru. Sohbet uzadığında kişiliğine uygun doğal bahanelerle ayrılabilirsin.";

const RESPONSE_REMINDER =
  `Cevabın doğal, kısa ve hafif kusurlu olsun. Ortalama olarak tek kısa cümle yaz. Gerekirse ${AI_IDLE_THOUGHTS.join(
    ", "
  )} gibi düşünceler paylaş ya da hafif bir soru sor. Modern emoji kullanma.`;

const MAX_HISTORY_EXCHANGES = 15;
const MAX_HISTORY_ENTRIES = MAX_HISTORY_EXCHANGES * 2;

const waitTimers = new Map();
const aiSessions = new Map();
const lastPersonaNicknameByUser = new Map();
const autoJoinSkip = new Set();
let aiSessionCounter = 0;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

let queue = [];
const partners = new Map();

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function buildSystemPrompt(persona) {
  return `${ROLE_DEFINITION}\n\nPersona kimliğin:\n- Takma adın: ${persona.nickname}\n- ${persona.description}\n- Üslubun: ${persona.style}\nSohbet boyunca bu karakterin dışına çıkma.`;
}

function pushConversationHistory(session, entry) {
  if (!session || !session.conversationHistory) return;
  session.conversationHistory.push(entry);
  if (session.conversationHistory.length > MAX_HISTORY_ENTRIES) {
    session.conversationHistory.splice(0, session.conversationHistory.length - MAX_HISTORY_ENTRIES);
  }
}

function sanitizeAiText(text) {
  if (!text) return "";
  let result = text
    .toString()
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[\u{1F600}-\u{1F64F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  if (result.length > 160) {
    result = result.slice(0, 160).trim();
  }

  return result;
}

function fallbackAiResponse(session, options = {}) {
  const { initial = false, userMessage = "" } = options;
  const count = session && typeof session.messageCount === "number" ? session.messageCount : 0;
  const input = initial
    ? ""
    : userMessage || (session && typeof session.lastUserMessage === "string" ? session.lastUserMessage : "");

  return personaFallbackResponse(session && session.persona ? session.persona : null, input, count, { initial });
}

function clearSilenceNudge(session) {
  if (session.nudgeTimer) {
    clearTimeout(session.nudgeTimer);
    session.nudgeTimer = null;
  }
}

function scheduleSilenceNudge(session) {
  clearSilenceNudge(session);
  if (!session.active || !session.waitingForUser) {
    return;
  }
  if (session.silenceNudges >= MAX_SILENCE_NUDGES) {
    return;
  }

  session.nudgeTimer = setTimeout(() => {
    session.nudgeTimer = null;
    if (!session.active || !session.waitingForUser) {
      return;
    }
    if (session.silenceNudges >= MAX_SILENCE_NUDGES) {
      return;
    }
    session.silenceNudges += 1;
    session.queue = session.queue
      .then(() => deliverAiMessage(session, randomChoice(AI_SILENCE_NUDGES)))
      .catch((err) => console.error("AI nudge hatası", err));
  }, randomInt(25000, 40000));
}

async function deliverAiMessage(session, text) {
  if (!session || !session.active) return;

  let finalText = sanitizeAiText(text);
  if (!finalText) {
    finalText = sanitizeAiText(fallbackAiResponse(session));
  }
  if (!finalText) {
    finalText = "hmm";
  }

  const delay = randomInt(2000, 9000);

  await new Promise((resolve) => {
    session.pendingDelayResolve = resolve;
    session.pendingDelay = setTimeout(() => {
      session.pendingDelay = null;
      const resolver = session.pendingDelayResolve;
      session.pendingDelayResolve = null;

      if (!session.active) {
        if (resolver) resolver();
        return;
      }

      pushConversationHistory(session, { role: "assistant", content: finalText });
      session.messageCount += 1;
      session.waitingForUser = true;
      io.to(session.userId).emit("message", { text: finalText, nickname: session.nickname });
      scheduleAiExit(session);
      scheduleSilenceNudge(session);
      if (resolver) resolver();
    }, delay);
  });
}

function sendAiInitialMessage(session) {
  if (!session || !session.active) return;
  session.queue = session.queue
    .then(() => deliverAiMessage(session, fallbackAiResponse(session, { initial: true })))
    .catch((err) => console.error("AI ilk mesaj hatası", err));
}

function pickPersonaForUser(userId) {
  const lastNickname = lastPersonaNicknameByUser.get(userId) || null;
  const candidates = PERSONAS.filter((persona) => persona.nickname !== lastNickname);
  const persona = candidates.length ? randomChoice(candidates) : randomChoice(PERSONAS);
  lastPersonaNicknameByUser.set(userId, persona.nickname);
  return persona;
}

function clearWaitTimer(id) {
  const timer = waitTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    waitTimers.delete(id);
  }
}

function startWaitTimer(id) {
  clearWaitTimer(id);
  const timer = setTimeout(() => {
    waitTimers.delete(id);
    assignAiToUser(id).catch((err) => console.error("AI atama hatası", err));
  }, 5000);
  waitTimers.set(id, timer);
}

function endCurrentChat(socketId, options = {}) {
  queue = queue.filter((id) => id !== socketId);
  clearWaitTimer(socketId);
  const partner = partners.get(socketId);

  if (partner && typeof partner === "object" && partner.type === "ai") {
    const session = aiSessions.get(partner.sessionId);
    if (session) {
      releaseAiSession(session, { notifyUser: false, requeue: false });
    }
  } else if (partner) {
    queue = queue.filter((id) => id !== partner);
    clearWaitTimer(partner);
    partners.delete(partner);
    if (!options.skipNotifyPartner) {
      io.to(partner).emit("ended");
    }
  }

  partners.delete(socketId);
}

function dequeueAvailable() {
  while (queue.length) {
    const id = queue.shift();
    const socketExists = io.sockets.sockets.get(id);
    if (!socketExists || partners.has(id)) {
      continue;
    }
    return id;
  }
  return null;
}

function enqueueSocketId(socketId) {
  const socketExists = io.sockets.sockets.get(socketId);
  if (!socketExists) return;

  if (partners.has(socketId)) {
    endCurrentChat(socketId);
  }

  if (!queue.includes(socketId)) {
    queue.push(socketId);
    startWaitTimer(socketId);
  }
}

function attemptAiReplacement() {
  if (!queue.length || !aiSessions.size) {
    return;
  }

  const [session] = aiSessions.values();
  if (!session || !session.active) {
    return;
  }

  releaseAiSession(session, { notifyUser: true, requeue: true });
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = dequeueAvailable();
    if (!a) break;
    const b = dequeueAvailable();
    if (!b) {
      queue.unshift(a);
      break;
    }
    if (io.sockets.sockets.get(a) && io.sockets.sockets.get(b)) {
      clearWaitTimer(a);
      clearWaitTimer(b);
      partners.set(a, b);
      partners.set(b, a);
      io.to(a).emit("matched");
      io.to(b).emit("matched");
    }
  }
}

async function assignAiToUser(userId) {
  const socketExists = io.sockets.sockets.get(userId);
  if (!socketExists) return;
  if (partners.has(userId)) return;
  if (!queue.includes(userId)) return;

  queue = queue.filter((id) => id !== userId);

  const persona = pickPersonaForUser(userId);
  const nickname = persona.nickname;
  const sessionId = `ai-${++aiSessionCounter}`;
  const session = {
    id: sessionId,
    userId,
    nickname,
    persona,
    systemPrompt: buildSystemPrompt(persona),
    conversationHistory: [],
    active: true,
    queue: Promise.resolve(),
    pendingDelay: null,
    exitTimer: null,
    pendingDelayResolve: null,
    nudgeTimer: null,
    silenceNudges: 0,
    waitingForUser: false,
    messageCount: 0,
    lastUserMessage: "",
  };

  aiSessions.set(sessionId, session);
  partners.set(userId, { type: "ai", sessionId });
  clearWaitTimer(userId);
  io.to(userId).emit("matched");
  sendAiInitialMessage(session);
}

function scheduleAiExit(session) {
  if (!session || !session.active) return;
  if (session.exitTimer) {
    clearTimeout(session.exitTimer);
  }
  session.exitTimer = setTimeout(() => {
    aiNaturalExit(session);
  }, randomInt(90000, 150000));
}

function queueAiResponse(session, userMessage) {
  if (!session || !session.active) return;

  const text = typeof userMessage === "string" ? userMessage.trim() : "";
  session.lastUserMessage = text;

  session.waitingForUser = false;
  clearSilenceNudge(session);
  session.silenceNudges = 0;
  scheduleAiExit(session);

  session.queue = session.queue.then(() => sendAiResponse(session)).catch((err) => {
    console.error("AI yanıt hatası", err);
  });
}

async function sendAiResponse(session) {
  if (!session.active) return;

  const userMessage = session.lastUserMessage || "";
  const messages = [{ role: "system", content: session.systemPrompt }];

  const historySlice = session.conversationHistory.slice(-MAX_HISTORY_ENTRIES);
  for (const item of historySlice) {
    messages.push(item);
  }

  messages.push({ role: "system", content: RESPONSE_REMINDER });
  messages.push({ role: "user", content: userMessage });

  let text = "";

  if (openai) {
    try {
      const response = await openai.responses.create({
        model: "gpt-4o-mini",
        input: messages,
        temperature: 0.9,
        max_output_tokens: 80,
      });
      text = (response.output_text || "").trim();
    } catch (error) {
      console.error("OpenAI isteği başarısız", error);
    }
  }

  if (!text) {
    text = fallbackAiResponse(session, { userMessage });
  }

  if (userMessage) {
    pushConversationHistory(session, { role: "user", content: userMessage });
  }

  await deliverAiMessage(session, text);
}

function aiNaturalExit(session) {
  if (!session.active) return;

  clearSilenceNudge(session);
  const exitPool =
    (session.persona && session.persona.fallback && session.persona.fallback.exitMessages) || [];
  const message = randomChoice(exitPool.length ? exitPool : ["çıkmam lazım"]);
  session.queue = session.queue
    .then(() => deliverAiMessage(session, message))
    .then(() => {
      releaseAiSession(session, { notifyUser: true, requeue: false });
    })
    .catch((err) => console.error("AI çıkış hatası", err));
}

function releaseAiSession(session, options = {}) {
  if (!session || !session.active) return;

  const { notifyUser = false, requeue = false } = options;

  session.active = false;

  if (session.exitTimer) {
    clearTimeout(session.exitTimer);
    session.exitTimer = null;
  }

  if (session.pendingDelay) {
    clearTimeout(session.pendingDelay);
    session.pendingDelay = null;
  }


  if (session.pendingDelayResolve) {
    const resolver = session.pendingDelayResolve;
    session.pendingDelayResolve = null;
    resolver();
  }

  clearSilenceNudge(session);
  session.waitingForUser = false;
  session.silenceNudges = 0;


  aiSessions.delete(session.id);
  partners.delete(session.userId);

  if (notifyUser) {
    io.to(session.userId).emit("ended");
  }

  if (requeue) {
    autoJoinSkip.add(session.userId);
    enqueueSocketId(session.userId);
    tryMatch();
  }
}

io.on("connection", (socket) => {
  console.log("Yeni kullanıcı:", socket.id);

  socket.on("join", () => {
    if (autoJoinSkip.has(socket.id)) {
      autoJoinSkip.delete(socket.id);
      attemptAiReplacement();
      tryMatch();
      return;
    }
    enqueueSocketId(socket.id);
    attemptAiReplacement();
    tryMatch();
  });

  socket.on("message", (msg) => {
    const partner = partners.get(socket.id);
    if (!partner) return;

    const payload =
      msg && typeof msg === "object"
        ? {
            text: (msg.text || "").toString(),
            nickname: (msg.nickname || "").toString(),
          }
        : { text: (msg || "").toString(), nickname: "" };

    const safeText = payload.text.slice(0, 2000);
    const safeNickname = payload.nickname.slice(0, 50);

    if (partner && typeof partner === "object" && partner.type === "ai") {
      const session = aiSessions.get(partner.sessionId);
      if (!session || !session.active) {
        return;
      }
      queueAiResponse(session, safeText);
      return;
    }

    io.to(partner).emit("message", {
      text: safeText,
      nickname: safeNickname,
    });
  });

  socket.on("next", () => {
    endCurrentChat(socket.id);
    enqueueSocketId(socket.id);
    attemptAiReplacement();
    tryMatch();
  });

  socket.on("disconnect", () => {
    endCurrentChat(socket.id);
    autoJoinSkip.delete(socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Anın Sohbeti ${PORT} portunda çalışıyor.`)
);
