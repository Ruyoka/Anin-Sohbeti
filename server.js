const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 6000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

let queue = [];
const partners = new Map();

function endCurrentChat(socketId) {
  queue = queue.filter((id) => id !== socketId);
  const partner = partners.get(socketId);
  if (partner) {
    queue = queue.filter((id) => id !== partner);
    partners.delete(partner);
    io.to(partner).emit("ended");
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

io.on("connection", (socket) => {
  console.log("Yeni kullanıcı:", socket.id);

  function enqueue() {
    if (partners.has(socket.id)) {
      endCurrentChat(socket.id);
    }
    if (!queue.includes(socket.id)) queue.push(socket.id);
    tryMatch();
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
        partners.set(a, b);
        partners.set(b, a);
        io.to(a).emit("matched");
        io.to(b).emit("matched");
      }
    }
  }

  socket.on("join", enqueue);

  socket.on("message", (msg) => {
    const partner = partners.get(socket.id);
    if (partner) io.to(partner).emit("message", (msg||"").toString().slice(0,2000));
  });

  socket.on("next", () => {
    endCurrentChat(socket.id);
    enqueue();
  });

  socket.on("disconnect", () => {
    endCurrentChat(socket.id);
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Anın Sohbeti ${PORT} portunda çalışıyor.`)
);
