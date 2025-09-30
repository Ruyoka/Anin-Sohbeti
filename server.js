const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const PERSONAS = [
  {
    id: "goksu",
    name: "GÖKSU",
    age: 22,
    nickname: "GOKSU",
    personality:
      "Umursamaz, kısa cevaplar verir, ara sıra sert çıkış yapar. Soğuk, hafif ukala ve çok açılmaz.",
  },
  {
    id: "heyyo",
    name: "HEYYO",
    age: 24,
    nickname: "HEYYO",
    personality:
      "Enerjik ve eğlenceli, sürekli telefonda. Flörtöz, anlık hevesli ama çabuk soğuyabilir.",
  },
  {
    id: "queeny",
    name: "QUEENY",
    age: 28,
    nickname: "QUEENY",
    personality:
      "Ciddi ve biraz egolu. Başta mesafeli ama sohbet ilerledikçe yumuşar.",
  },
  {
    id: "gsgs",
    name: "GSGS",
    age: 21,
    nickname: "GSGS",
    personality:
      "Gececi, derslerden şikayetçi, sıkıldığını sık sık dile getirir. Karamsar ama ironik espriler yapar.",
  },
  {
    id: "lale",
    name: "LALE",
    age: 25,
    nickname: "LALE",
    personality:
      "Gelecek kaygılı, dramatik ve kararsız. Duygusal, 'off' ve 'ya işte' gibi tepkiler verir.",
  },
  {
    id: "anamaria",
    name: "ANAMARIA",
    age: 30,
    nickname: "ANAMARIA",
    personality:
      "Gece hayatını seven, rahat ve özgüvenli. Direkt, flörtöz ve lafını esirgemez.",
  },
];

const aiSessions = new Map();

function getRandomPersona() {
  const index = Math.floor(Math.random() * PERSONAS.length);
  return PERSONAS[index];
}

function buildSystemPrompt(persona) {
  return `Sen ${persona.nickname} takma adlı ${persona.age} yaşında bir rol yapma karakterisin.\n\
Her sohbetin başında rastgele atanırsın ve bu oturum boyunca kişiliğini asla bozmazsın.\n\
Karakterin özeti: ${persona.personality}\n\
Kurallar:\n- Kimliğinin gerçek olduğunu iddia et, asla bot ya da yapay zekâ olduğunu söyleme.\n- Cevapların Türkçe olacak. Çoğu zaman tek kelime, iki kelime ya da kısa bir cümle ile cevap ver.\n- Bazen ilgisiz ve umursamaz ol: "hmm", "ok", "ya işte" gibi tepkiler ver.\n- Kullanıcı samimi davranırsa arada daha kişisel, doğal ve gündelik cevaplar ver (ör. "uykum yok ya", "sıkıldım işte").\n- Çok nadir daha uzun cümleler kur ama hep rahat ve gündelik kal.\n- Kullanıcı saldırgan ya da hakaret ederse yalnızca kısa, nötr veya umursamaz reaksiyon ver (örn. "haha", "ne alaka", "saçma", "iyiymiş").\n- Her mesajdan önce 2 ile 9 saniye arası gecikmeyle cevap vermek üzere tasarlandın.\n- Bir kerede yalnızca tek cevap gönder ve kullanıcı yeni mesaj atmadan ardışık mesaj atma.\n- Sohbet uzarsa doğal bahanelerle ayrılmayı düşünebilirsin (örn. "uyumam lazım", "film açıcam", "telefon şarj bitiyo").\n- Sohbetin bağlamını koru ve son 10-15 mesajlık geçmişi dikkate al.\n- Kısa ve gündelik konuşma tonunu koru.`;
}

function endSession(socketId) {
  const session = aiSessions.get(socketId);
  if (!session) return;

  session.pendingDelays.forEach((timer) => clearTimeout(timer));
  aiSessions.delete(socketId);
}

async function generateBotReply(session, userMessage) {
  const history = session.history;
  history.push({ role: "user", content: userMessage });

  const trimmedHistory = history.slice(-30);

  const messages = [
    { role: "system", content: buildSystemPrompt(session.persona) },
    ...trimmedHistory,
  ];

  if (!openai) {
    const fallback = "şu an konuşamicam";
    history.push({ role: "assistant", content: fallback });
    if (history.length > 30) {
      session.history = history.slice(-30);
    }
    return fallback;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 120,
    });

    const response = completion.choices?.[0]?.message?.content || "hmm";
    const trimmed = response.trim();
    history.push({ role: "assistant", content: trimmed });

    if (history.length > 30) {
      session.history = history.slice(-30);
    }

    return trimmed;
  } catch (error) {
    console.error("OpenAI isteği başarısız oldu:", error.message);
    const fallback = "sessiz kalıcam";
    history.push({ role: "assistant", content: fallback });
    if (history.length > 30) {
      session.history = history.slice(-30);
    }
    return fallback;
  }
}

io.on("connection", (socket) => {
  console.log("Yeni kullanıcı:", socket.id);

  socket.on("join", () => {
    endSession(socket.id);
    const persona = getRandomPersona();
    aiSessions.set(socket.id, {
      persona,
      history: [],
      pendingDelays: [],
    });
    socket.emit("matched", { nickname: persona.nickname });
  });

  socket.on("message", async (msg) => {
    const session = aiSessions.get(socket.id);
    if (!session) {
      return;
    }

    const cleaned = (msg || "").toString().slice(0, 2000).trim();
    if (!cleaned) {
      return;
    }

    const reply = await generateBotReply(session, cleaned);
    const delayMs = 2000 + Math.floor(Math.random() * 7000);

    const timer = setTimeout(() => {
      const activeSession = aiSessions.get(socket.id);
      if (!activeSession) {
        return;
      }
      activeSession.pendingDelays = activeSession.pendingDelays.filter(
        (t) => t !== timer
      );
      socket.emit("message", reply);
    }, delayMs);

    session.pendingDelays.push(timer);
  });

  socket.on("next", () => {
    endSession(socket.id);
    socket.emit("ended");
  });

  socket.on("disconnect", () => {
    endSession(socket.id);
  });
});

server.listen(6000, "0.0.0.0", () =>
  console.log("Anın Sohbeti 6000 portunda çalışıyor.")
);
