const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
const { io } = require("socket.io-client");

const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVER_START_TIMEOUT_MS = 10000;

async function getFreePort() {
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (!port) {
    throw new Error("Boş port bulunamadı.");
  }
  return port;
}

async function startServer(envOverrides = {}) {
  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      MESSAGE_RATE_LIMIT_MAX: "3",
      MESSAGE_RATE_LIMIT_WINDOW_MS: "1000",
      JOIN_RATE_LIMIT_MAX: "10",
      JOIN_RATE_LIMIT_WINDOW_MS: "2000",
      CALL_RATE_LIMIT_MAX: "4",
      CALL_RATE_LIMIT_WINDOW_MS: "1000",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const onData = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  await Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes(`Anın Sohbeti ${port} portunda çalışıyor.`)) {
          resolve();
        }
      });
      child.once("exit", (code, signal) => {
        reject(new Error(`Sunucu erken kapandı (code=${code}, signal=${signal}).\n${output}`));
      });
    }),
    delay(SERVER_START_TIMEOUT_MS).then(() => {
      throw new Error(`Sunucu zamanında ayağa kalkmadı.\n${output}`);
    }),
  ]);

  return { child, port };
}

async function stopServer(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  const exitResult = await Promise.race([
    once(child, "exit"),
    delay(5000).then(() => {
      child.kill("SIGKILL");
      return once(child, "exit");
    }),
  ]);
  await exitResult;
}

function createClient(port, options = {}) {
  return io(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    ...options,
  });
}

function waitForEvent(socket, eventName) {
  return once(socket, eventName).then(([payload]) => payload);
}

async function connectClients(...sockets) {
  await Promise.all(sockets.map((socket) => once(socket, "connect")));
}

async function matchPair(first, second) {
  const firstMatched = waitForEvent(first, "matched");
  const secondMatched = waitForEvent(second, "matched");
  first.emit("join");
  second.emit("join");
  await Promise.all([firstMatched, secondMatched]);
}

test("health endpoint responds with ok payload", async () => {
  const { child, port } = await startServer();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy") || "", /default-src 'self'/);
  } finally {
    await stopServer(child);
  }
});

test("matched users can exchange structured messages", async () => {
  const { child, port } = await startServer();
  const first = createClient(port);
  const second = createClient(port);

  try {
    await connectClients(first, second);
    await matchPair(first, second);

    const messagePromise = waitForEvent(second, "message");
    first.emit("message", { text: "Merhaba", nickname: "Testci" });
    const payload = await messagePromise;

    assert.deepEqual(payload, {
      text: "Merhaba",
      nickname: "Testci",
    });
  } finally {
    first.disconnect();
    second.disconnect();
    await stopServer(child);
  }
});

test("message rate limiting drops messages above configured threshold", async () => {
  const { child, port } = await startServer();
  const first = createClient(port);
  const second = createClient(port);
  const receivedMessages = [];
  const senderErrors = [];

  try {
    await connectClients(first, second);
    await matchPair(first, second);

    second.on("message", (payload) => {
      receivedMessages.push(payload);
    });
    first.on("message:error", (payload) => {
      senderErrors.push(payload);
    });

    for (let index = 0; index < 5; index += 1) {
      first.emit("message", { text: `Mesaj ${index}`, nickname: "Limitci" });
    }

    await delay(400);

    assert.equal(receivedMessages.length, 3);
    assert.deepEqual(
      receivedMessages.map((message) => message.text),
      ["Mesaj 0", "Mesaj 1", "Mesaj 2"]
    );
    assert.deepEqual(senderErrors, [
      { reason: "rate-limited" },
      { reason: "rate-limited" },
    ]);
  } finally {
    first.disconnect();
    second.disconnect();
    await stopServer(child);
  }
});

test("voice call request returns no-partner error when user is unmatched", async () => {
  const { child, port } = await startServer();
  const first = createClient(port);

  try {
    await connectClients(first);

    const errorPromise = waitForEvent(first, "voice-call:request:error");
    first.emit("voice-call:request");
    const payload = await errorPromise;

    assert.deepEqual(payload, { reason: "no-partner" });
  } finally {
    first.disconnect();
    await stopServer(child);
  }
});

test("voice call request rate limiting returns rate-limited error", async () => {
  const { child, port } = await startServer();
  const first = createClient(port);
  const errors = [];

  try {
    await connectClients(first);

    first.on("voice-call:request:error", (payload) => {
      errors.push(payload);
    });

    for (let index = 0; index < 6; index += 1) {
      first.emit("voice-call:request");
    }

    await delay(250);

    assert.equal(errors.length, 6);
    assert.deepEqual(errors.slice(0, 4), [
      { reason: "no-partner" },
      { reason: "no-partner" },
      { reason: "no-partner" },
      { reason: "no-partner" },
    ]);
    assert.deepEqual(errors.slice(4), [
      { reason: "rate-limited" },
      { reason: "rate-limited" },
    ]);
  } finally {
    first.disconnect();
    await stopServer(child);
  }
});

test("socket handshake rejects origins outside CLIENT_ORIGIN", async () => {
  const { child, port } = await startServer({
    CLIENT_ORIGIN: "https://allowed.example",
  });
  const client = createClient(port, {
    extraHeaders: {
      Origin: "https://blocked.example",
    },
  });

  try {
    const error = await waitForEvent(client, "connect_error");
    assert.match(String(error && error.message), /xhr poll error|websocket error|forbidden/i);
  } finally {
    client.disconnect();
    await stopServer(child);
  }
});
