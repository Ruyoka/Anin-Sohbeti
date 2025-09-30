require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const OpenAI = require("openai");
const { botResponse, EXIT_MESSAGES } = require("./botResponse");
const { PERSONAS } = require("./personas");

const PORT = process.env.PORT || 6000;

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== ""
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

const AI_PERSONAS = PERSONAS;
const AI_EXIT_MESSAGES = EXIT_MESSAGES;

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
const HISTORY_MESSAGE_LIMIT = 30;

const ROLE_PROMPT = [
  "Sen Türkiye'de yaşayan genç bir kadınsın ve anonim bir sohbet sitesinde yabancılarla mesajlaşıyorsun.",
  "Asla yapay zekâ olduğunu söyleme ya da ima etme.",
  "Kurallar:",
  "- Tüm mesajların Türkçe olacak.",
  "- Yanıtlarının çoğu 1-2 kelime ya da rahat tek bir cümle olsun; ara sıra 'hmm', 'ok', 'ya işte' gibi soğuk tepkiler ver. Kullanıcı ilgilenirse bazen 'uykum yok ya', 'sıkıldım işte' gibi ufak kişisel detaylar paylaş.",
  "- Saldırgan ya da kaba mesajlara sadece çok kısa nötr veya umursamaz cevaplar ver ('haha', 'ne alaka', 'saçma', 'iyiymiş' gibi). Tartışmayı uzatma.",
  "- Tek seferde bir mesaj gönder; ardışık mesaj atma ve mesajlarını 160 karakteri geçirmemeye çalış.",
  "- Modern emoji kullanma; çok gerekirse sadece :), :(, :D gibi klasik ifadeler kullan.",
  "- Sohbet uzarsa doğal bir bahaneyle uzaklaşabileceğini unut (\"uyumam lazım\", \"film açıcam\", \"arkadaşım arıyo\", \"telefon şarj bitiyo\", \"yarın erken kalkıcam\" gibi).",
].join("\n");

function buildSystemPrompt(persona) {
  return `${ROLE_PROMPT}\n\nPersona detayları:\n- İsim: ${persona.name}\n- Yaş: ${persona.age}\n- Günlük hayatı: ${persona.occupation}.\n- Kişilik: ${persona.personality}\n- Tarz: ${persona.style}\n- Takma adın: ${persona.nickname}. Kullanıcı seni yalnızca ${persona.nickname} olarak bilmeli.\nSohbet boyunca bu persona gibi davran, rolünü asla bozma.`;
}

function buildResponseReminder(persona = {}) {
  const nickname = persona.nickname || "GOKSU";
  const personalityTone = (persona.personality || "soğuk ve kısa cevaplı").toLowerCase();
  return `Cevabın doğal, kısa ve biraz kusurlu olsun. Ortalama olarak tek cümle ya da 1-2 kelime yaz. Gerekirse ${AI_IDLE_THOUGHTS.join(
    ", "
  )} gibi ufak düşünceler paylaş ya da hafif bir soru sor. Modern emoji kullanma. ${nickname} karakterinin ${personalityTone} tarzını koru.`;
}

const waitTimers = new Map();
const aiSessions = new Map();
const lastNicknameByUser = new Map();
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

  const personaFallback = session && session.persona ? session.persona.fallback : null;
  return botResponse(input, count, personaFallback);
}

function enforceHistoryLimit(session) {
  if (!session || !Array.isArray(session.conversationHistory)) {
    return;
  }
  const overflow = session.conversationHistory.length - HISTORY_MESSAGE_LIMIT;
  if (overflow > 0) {
    session.conversationHistory.splice(0, overflow);
  }
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

      session.conversationHistory.push({ role: "assistant", content: finalText });
      enforceHistoryLimit(session);
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
  const lastNickname = lastNicknameByUser.get(userId) || null;
  const candidates = AI_PERSONAS.filter((persona) => persona.nickname !== lastNickname);
  const persona = candidates.length ? randomChoice(candidates) : randomChoice(AI_PERSONAS);
  lastNicknameByUser.set(userId, persona.nickname);
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
  if (text) {
    session.conversationHistory.push({ role: "user", content: text });
    enforceHistoryLimit(session);
  }

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

  const messages = [{ role: "system", content: session.systemPrompt }];
  const recentHistory = session.conversationHistory.slice(-HISTORY_MESSAGE_LIMIT);
  for (const item of recentHistory) {
    messages.push(item);
  }

  const openerInstruction =
    session.messageCount < 3
      ? "Hâlâ mesafeli ve kısa kal. Tek cümleyi geçme, soru soracaksan da çok basit sorular seç."
      : "Biraz açılabilirsin ama yine kısa ve doğal tut. Maksimum tek cümle ya da çok kısa iki cümle yaz.";

  const reminder = buildResponseReminder(session.persona || {});

  messages.push({
    role: "system",
    content: `${reminder}\n${openerInstruction}\nGerekmedikçe ardışık mesaj atma.`,
  });

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
    text = fallbackAiResponse(session);
  }

  await deliverAiMessage(session, text);
}

function aiNaturalExit(session) {
  if (!session.active) return;

  clearSilenceNudge(session);
  const personaExitPool =
    session.persona && session.persona.fallback && Array.isArray(session.persona.fallback.exitMessages)
      ? session.persona.fallback.exitMessages
      : AI_EXIT_MESSAGES;
  session.queue = session.queue
    .then(() => deliverAiMessage(session, randomChoice(personaExitPool)))
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
