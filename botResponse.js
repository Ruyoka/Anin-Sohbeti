const FIRST_MESSAGE_POOL = [
  "selam",
  "slm",
  "napıon",
  "uyumadın mı",
  "sıkıldım ya",
  "buralar boş mu hep",
  "yaaa",
  "offf",
];

const EXIT_MESSAGES = [
  "uyumam lazım",
  "film açıcam",
  "arkadaşım arıyo",
  "çıkmam gerek",
  "telefon şarj bitiyo",
  "canım sıkkın kapatıcam",
  "yarın erken kalkıcam",
];

const CATEGORY_POOLS = {
  short: ["hmm", "ok", "ya işte"],
  question: ["bilmiom", "boşver", "napıcan"],
  aggressive: ["haha", "ne alaka", "saçma", "iyiymiş"],
  personal: ["kolay gelsin", "aynı", "hmm"],
  neutral: ["hmm", "ya", "napıon ki"],
};

const CASUAL_SENTENCES = {
  short: ["ya öyle işte", "boş boş takılıyom"],
  question: ["bilemedim vallahi boşver", "çok da düşünme bence"],
  personal: ["aynı şeyler bende de var", "benim de kafam dolu"],
  neutral: ["uykum yok ya", "sıkıldım işte", "ev sessiz bu gece"],
};

const LONG_RESPONSES = [
  "ders çalışmam lazım ama hiç modum yok",
  "bütün gün evdeydim konuşacak kimse yok",
  "iş güç yordu ama uyku da tutmuyo",
];

const OFFENSIVE_WORDS = [
  "salak",
  "aptal",
  "gerizekalı",
  "mal",
  "oç",
  "piç",
  "orospu",
  "siktir",
  "lanet",
  "şerefsiz",
];

const PERSONAL_KEYWORDS = [
  "çalışıyorum",
  "calisiyorum",
  "işteyim",
  "isteyim",
  "okuyorum",
  "okuldayım",
  "okuldayim",
  "uyuyamıyorum",
  "uyuyamiyorum",
  "uyuyamiyom",
  "uykum yok",
  "yalnızım",
  "yalnizim",
  "yorgunum",
  "ders çalışıyorum",
  "ders calisiyorum",
  "evdeyim",
  "mesai",
  "nöbet",
  "nobet",
];

const QUESTION_WORDS = [
  "mi",
  "mı",
  "mu",
  "mü",
  "misin",
  "mısın",
  "musun",
  "müsün",
  "miyim",
  "mıyım",
  "muyum",
  "müyüm",
  "neden",
  "nasıl",
  "niye",
  "ne zaman",
  "nerede",
  "nerden",
  "hangi",
  "kim",
];

const SHORT_NEUTRAL_WORDS = ["ok", "okey", "tamam", "hmm", "hi", "selam", "sa", "nbr", "iyi", "eyv"];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAny(text, words) {
  return words.some((word) => {
    const pattern = word.includes(" ") ? word.split(/\s+/).map(escapeRegExp).join("\\s+") : escapeRegExp(word);
    const regex = new RegExp(`\\b${pattern}\\b`, "i");
    return regex.test(text);
  });
}

function normalize(text) {
  return text
    .toString()
    .replace(/[!?.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isQuestion(text) {
  if (!text) return false;
  if (text.includes("?")) return true;
  const normalized = normalize(text);
  return containsAny(normalized, QUESTION_WORDS);
}

function isPersonal(text) {
  if (!text) return false;
  return containsAny(text, PERSONAL_KEYWORDS);
}

function isShortNeutral(text) {
  if (!text) return true;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= 2 && text.length <= 14) {
    return true;
  }
  return containsAny(text, SHORT_NEUTRAL_WORDS);
}

function categorizeMessage(userMessage) {
  const raw = (userMessage || "").toString();
  const normalized = normalize(raw);

  if (!normalized) {
    return "short";
  }

  if (containsAny(normalized, OFFENSIVE_WORDS)) {
    return "aggressive";
  }

  if (isQuestion(raw)) {
    return "question";
  }

  if (isPersonal(normalized)) {
    return "personal";
  }

  if (isShortNeutral(normalized)) {
    return "short";
  }

  return "neutral";
}

function pickFromPool(pool) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return "hmm";
  }
  const index = Math.floor(Math.random() * pool.length);
  return pool[index];
}

function chooseSentence(category) {
  const pool = CASUAL_SENTENCES[category] || CASUAL_SENTENCES.neutral;
  return pickFromPool(pool);
}

function chooseLongSentence() {
  return pickFromPool(LONG_RESPONSES);
}

function botResponse(userMessage = "", messageCount = 0) {
  if (Number.isNaN(messageCount) || messageCount < 0) {
    messageCount = 0;
  }

  if (messageCount === 0) {
    return pickFromPool(FIRST_MESSAGE_POOL);
  }

  const category = categorizeMessage(userMessage);

  if (messageCount >= 12 && Math.random() < 0.08) {
    return pickFromPool(EXIT_MESSAGES);
  }

  if (category === "aggressive") {
    return pickFromPool(CATEGORY_POOLS.aggressive);
  }

  const roll = Math.random();

  if (roll < 0.7) {
    return pickFromPool(CATEGORY_POOLS[category] || CATEGORY_POOLS.neutral);
  }

  if (roll < 0.9) {
    return chooseSentence(category);
  }

  if (messageCount >= 3) {
    return chooseLongSentence();
  }

  return pickFromPool(CATEGORY_POOLS[category] || CATEGORY_POOLS.neutral);
}

module.exports = {
  botResponse,
  FIRST_MESSAGE_POOL,
  EXIT_MESSAGES,
};
