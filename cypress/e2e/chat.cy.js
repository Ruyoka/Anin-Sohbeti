const connectPartner = (win) =>
  new Cypress.Promise((resolve) => {
    const context = {
      socket: win.io({ forceNew: true, transports: ["websocket"] }),
      events: { messages: [], endedCount: 0, matchedCount: 0 },
      resolved: false,
    };

    context.socket.on("connect", () => {
      context.socket.emit("join");
    });

    context.socket.on("matched", () => {
      context.events.matchedCount += 1;
      if (!context.resolved) {
        context.resolved = true;
        resolve(context);
      }
    });

    context.socket.on("message", (msg) => {
      context.events.messages.push(msg);
    });

    context.socket.on("ended", () => {
      context.events.endedCount += 1;
    });
  });

describe("Anın Sohbeti", () => {
  beforeEach(() => {
    cy.visit("/");
    cy.get("#log", { timeout: 10000 }).should(
      "contain.text",
      "Eşleşme bekleniyor..."
    );
  });

  it("matches, relays messages, and handles next/disconnect flows", () => {
    cy.window()
      .then((win) => connectPartner(win))
      .as("partner1");

    cy.get("#log", { timeout: 10000 }).should(
      "contain.text",
      "✓ Bir yabancı ile eşleştiniz!"
    );

    cy.get("#msg").type("Merhaba!");
    cy.get("#send").click();
    cy.get("#log div").last().should("have.text", "Sen: Merhaba!");

    cy.get("@partner1").should(({ events }) => {
      expect(events.messages).to.include("Merhaba!");
    });

    cy.get("@partner1").then(({ socket }) => socket.emit("message", "Selam!"));
    cy.get("#log div").last().should("have.text", "Yabancı: Selam!");

    const longMessage = "x".repeat(2100);
    const truncatedMessage = "x".repeat(2000);
    cy.get("@partner1").then(({ socket }) => socket.emit("message", longMessage));
    cy.get("#log div")
      .last()
      .should("have.text", `Yabancı: ${truncatedMessage}`);

    cy.get("#next").click();
    cy.get("#log div").last().should("have.text", "Yeni eşleşme aranıyor...");

    cy.get("@partner1").should(({ events }) => {
      expect(events.endedCount).to.eq(1);
    });

    cy.get("@partner1").then(({ socket }) => socket.disconnect());

    cy.window()
      .then((win) => connectPartner(win))
      .as("partner2");

    cy.get("#log", { timeout: 10000 }).should(
      "contain.text",
      "✓ Bir yabancı ile eşleştiniz!"
    );

    cy.get("#msg").type("Tekrar merhaba!");
    cy.get("#send").click();
    cy.get("#log div").last().should("have.text", "Sen: Tekrar merhaba!");

    cy.get("@partner2").should(({ events }) => {
      expect(events.messages).to.include("Tekrar merhaba!");
    });

    cy.get("@partner2").then(({ socket }) => socket.disconnect());
    cy.get("#log div")
      .last()
      .should("have.text", "— Bağlantı sonlandı.");

    cy.window()
      .then((win) => connectPartner(win))
      .as("partner3");

    cy.get("#log", { timeout: 10000 }).should(
      "contain.text",
      "✓ Bir yabancı ile eşleştiniz!"
    );

    cy.get("@partner3").then(({ socket }) => socket.disconnect());
    cy.get("#log div")
      .last()
      .should("have.text", "— Bağlantı sonlandı.");
  });
});
