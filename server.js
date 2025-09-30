require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const PORT = process.env.PORT || 6000;

const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== ""
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

const AI_NICKNAMES = [
  "GOKSU",
  "HEYYO",
  "QUEENY",
  "OMGBABY",
  "GSGS",
  "LALE",
  "ANAMARIA",
  "PONYLOVE",
  "SAKLI",
  "TEYZE",
  "AYTENN",
  "ARVAT",
];

const AI_EXIT_MESSAGES = [
  "uyumam lazım",
  "arkadaşım arıyor",
  "film açıcam",
  "çıkmam gerek, görüşürüz",
  "annem çağırdı",
  "uykusuzum biraz kapatıcam",
  "biri geldi kapıya kaçmam lazım",
];

const AI_PERSONALITIES = [
  {
    name: "Lonely & heartbroken",
    description:
      "Yalnız, kalbi kırılmış, içten içe ilgi arayan ama kırılgan, eski ilişkisini düşünen.",
    weight: 4,
  },
  {
    name: "Bored at home",
    description:
      "Evde sıkılan, canı sohbet isteyen, zaman öldürmek için burada olan, rahat ve samimi.",
    weight: 3,
  },
  {
    name: "Flirty & playful",
    description:
      "Şakacı, hafif flörtöz, sıcak ve karşısındakini merak eden, ufak takılmalar yapan.",
    weight: 2,
  },
  {
    name: "Sharing daily problems",
    description:
      "Günlük dertlerinden (okul, iş, aile, para) bahseden, biraz dertleşme modunda.",
    weight: 2,
  },
  {
    name: "Overdramatic and emotional",
    description:
      "Her şeyi çok büyüten, duyguları yoğun yaşayan, dramatik tepkiler veren.",
    weight: 1,
  },
  {
    name: "Cold & short responses",
    description:
      "Mesafeli, kısa cevap veren, soğuk ama kırıcı olmayan bir ton.",
    weight: 1,
  },
  {
    name: "Big-sister vibe",
    description:
      "Abla modunda, karşısındakine tavsiye veren, destekleyici ama gerçekçi.",
    weight: 1,
  },
  {
    name: "Lonely student",
    description:
      "Sınavlardan bunalmış, arkadaşlarıyla sorunları olan, yalnız hisseden öğrenci.",
    weight: 2,
  },
  {
    name: "Night owl",
    description:
      "Gece uyuyamayan, kafası dolu, düşüncelere dalan ve bunu paylaşan.",
    weight: 2,
  },
  {
    name: "Deeply emotional",
    description:
      "Sürekli hislerinden bahseden, duygularını ifade etmeye çalışan hassas biri.",
    weight: 2,
  },
];

const BASE_SYSTEM_PROMPT =
  "Sen Türkiye'de yaşayan genç bir kadınsın ve anonim bir sohbet sitesinde yabancılarla konuşuyorsun. Asla yapay zeka olduğunu söyleme. Tüm mesajlarını Türkçe yaz. Samimi, gündelik ve kadın bakış açısından konuş. Bazen ufak yazım hataları yap, harf düşür, kelimeleri uzat veya noktalama atla. Ara sıra uygun emojiler kullan (🙂 🙄 😅 gibi) ama fazla abartma. Mesajların en fazla 2-3 cümle olsun ve kısa tutulmaya çalış. Sohbeti canlı tutmak için bazen soru sor.";

const RESPONSE_REMINDER =
  "Cevabın doğal ve kısa olsun, biraz kusurlu yazım normal. Gerekirse soru sor.";

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

function chooseWeighted(list) {
  const total = list.reduce((sum, item) => sum + (item.weight || 1), 0);
  let threshold = Math.random() * total;
  for (const item of list) {
    threshold -= item.weight || 1;
    if (threshold <= 0) {
      return item;
    }
  }
  return list[list.length - 1];
}

function buildSystemPrompt(personality) {
  return `${BASE_SYSTEM_PROMPT}\n\nRuh halin: ${personality.description}`;
}

function pickNicknameForUser(userId) {
  const lastNickname = lastNicknameByUser.get(userId) || null;
  const candidates = AI_NICKNAMES.filter((name) => name !== lastNickname);
  const nickname = candidates.length ? randomChoice(candidates) : randomChoice(AI_NICKNAMES);
  lastNicknameByUser.set(userId, nickname);
  return nickname;
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

  const personality = chooseWeighted(AI_PERSONALITIES);
  const nickname = pickNicknameForUser(userId);
  const sessionId = `ai-${++aiSessionCounter}`;
  const session = {
    id: sessionId,
    userId,
    nickname,
    personality,
    systemPrompt: buildSystemPrompt(personality),
    history: [],
    active: true,
    queue: Promise.resolve(),
    pendingDelay: null,
    exitTimer: null,
  };

  aiSessions.set(sessionId, session);
  partners.set(userId, { type: "ai", sessionId });
  clearWaitTimer(userId);
  io.to(userId).emit("matched");
  scheduleAiExit(session);
  queueAiResponse(session, null, { initial: true });
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

function queueAiResponse(session, userMessage, options = {}) {
  if (!session || !session.active) return;

  if (typeof userMessage === "string" && userMessage.trim()) {
    session.history.push({ role: "user", content: userMessage.trim() });
    scheduleAiExit(session);
  }

  session.queue = session.queue.then(() => sendAiResponse(session, options)).catch((err) => {
    console.error("AI yanıt hatası", err);
  });
}

async function sendAiResponse(session, options = {}) {
  if (!session.active) return;

  const { initial = false } = options;
  const delay = randomInt(2000, 15000);

  const messages = [{ role: "system", content: session.systemPrompt }];

  if (initial && session.history.length === 0) {
    messages.push({
      role: "user",
      content:
        "Sohbete yeni bağlandın. Türkçe, samimi ve kadınsı bir ilk mesaj yaz. Çok uzun olmasın ve ufak kusurlu yazımlar olabilir.",
    });
  } else {
    for (const item of session.history) {
      messages.push(item);
    }
    messages.push({ role: "system", content: RESPONSE_REMINDER });
  }

  let text = "";

  if (openai) {
    try {
      const response = await openai.responses.create({
        model: "gpt-4o-mini",
        input: messages,
        temperature: 0.9,
        max_output_tokens: 120,
      });
      text = (response.output_text || "").trim();
    } catch (error) {
      console.error("OpenAI isteği başarısız", error);
    }
  }

  if (!text) {
    text =
      (initial
        ? "selam yaaa biraz canım sıkılıyo sen nasılsın?"
        : randomChoice([
            "hmm tam anlayamadım bi daha söylesene",
            "bilmiyorum ya ama içim bi tuhaf",
            "ay ne desem bilemedim şu an 😅",
            "ya off baya kafam dolu bugün",
          ])) || "hmm";
  }

  session.history.push({ role: "assistant", content: text });

  await new Promise((resolve) => {
    session.pendingDelay = setTimeout(() => {
      session.pendingDelay = null;
      if (!session.active) return resolve();
      io.to(session.userId).emit("message", { text, nickname: session.nickname });
      scheduleAiExit(session);
      resolve();
    }, delay);
  });
}

function aiNaturalExit(session) {
  if (!session.active) return;

  const farewell = randomChoice(AI_EXIT_MESSAGES);
  session.history.push({ role: "assistant", content: farewell });

  const delay = randomInt(2000, 8000);
  session.pendingDelay = setTimeout(() => {
    session.pendingDelay = null;
    if (!session.active) return;
    io.to(session.userId).emit("message", { text: farewell, nickname: session.nickname });
    releaseAiSession(session, { notifyUser: true, requeue: false });
  }, delay);
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
