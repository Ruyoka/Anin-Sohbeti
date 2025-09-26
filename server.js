const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

let queue = [];
const partners = new Map();

io.on("connection", (socket) => {
  console.log("Yeni kullanıcı:", socket.id);

  function enqueue() {
    if (!queue.includes(socket.id)) queue.push(socket.id);
    tryMatch();
  }

  function tryMatch() {
    while (queue.length >= 2) {
      const a = queue.shift();
      const b = queue.shift();
      if (io.sockets.sockets.get(a) && io.sockets.sockets.get(b)) {
        partners.set(a, b);
        partners.set(b, a);
        io.to(a).emit("matched");
        io.to(b).emit("matched");
      } else {
        if (io.sockets.sockets.get(a)) queue.unshift(a);
        if (io.sockets.sockets.get(b)) queue.unshift(b);
        break;
      }
    }
  }

  socket.on("join", enqueue);

  socket.on("message", (msg) => {
    const partner = partners.get(socket.id);
    if (partner) io.to(partner).emit("message", (msg||"").toString().slice(0,2000));
  });

  socket.on("next", () => {
    const partner = partners.get(socket.id);
    if (partner) {
      io.to(partner).emit("ended");
      partners.delete(partner);
    }
    partners.delete(socket.id);
    enqueue();
  });

  socket.on("disconnect", () => {
    queue = queue.filter((id) => id !== socket.id);
    const partner = partners.get(socket.id);
    if (partner) {
      io.to(partner).emit("ended");
      partners.delete(partner);
    }
    partners.delete(socket.id);
  });
});

server.listen(6000, "0.0.0.0", () =>
  console.log("Anın Sohbeti 6000 portunda çalışıyor.")
);
