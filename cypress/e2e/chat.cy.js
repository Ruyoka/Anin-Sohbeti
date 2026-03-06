const TEST_NICKNAME = "CypressUser";

const installBrowserStubs = (win) => {
  class FakeNotification {
    static permission = "denied";

    static requestPermission() {
      return Promise.resolve("denied");
    }

    constructor() {}
  }

  win.Notification = FakeNotification;
  win.alert = () => {};

  if (win.navigator.permissions) {
    win.navigator.permissions.query = () =>
      Promise.resolve({
        state: "denied",
        onchange: null,
      });
  }

  if (win.navigator.serviceWorker) {
    win.navigator.serviceWorker.register = () => Promise.resolve();
  }
};

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
    cy.visit("/", {
      onBeforeLoad(win) {
        installBrowserStubs(win);
      },
    });

    cy.get("#nickname").type(TEST_NICKNAME);
    cy.get("#nickname-submit").click();

    cy.get("#log", { timeout: 10000 })
      .invoke("text")
      .should("match", /Eşleşme bekleniyor|Şu anda herkes meşgul/);
    cy.get("#send").should("be.disabled");
    cy.get("#msg").should("be.disabled");
  });

  it("matches, relays messages, truncates long messages, and handles next/disconnect flows", () => {
    cy.window()
      .then((win) => connectPartner(win))
      .as("partner1");

    cy.get("#log", { timeout: 10000 }).should(
      "contain.text",
      "✓ Bir yabancı ile eşleştiniz!"
    );
    cy.get("#msg").should("not.be.disabled");
    cy.get("#send").should("be.disabled");

    cy.get("#msg").type("Merhaba!");
    cy.get("#send").should("not.be.disabled");
    cy.get("#send").click();
    cy.get("#log div").last().should("have.text", `${TEST_NICKNAME}:Merhaba!`);

    cy.get("@partner1").should(({ events }) => {
      expect(events.messages).to.deep.include({
        text: "Merhaba!",
        nickname: TEST_NICKNAME,
      });
    });

    cy.get("@partner1").then(({ socket }) =>
      socket.emit("message", { text: "Selam!", nickname: "PartnerOne" })
    );
    cy.get("#log div").last().should("have.text", "PartnerOne:Selam!");

    const longMessage = "x".repeat(2100);
    const truncatedMessage = "x".repeat(2000);
    cy.get("@partner1").then(({ socket }) =>
      socket.emit("message", { text: longMessage, nickname: "PartnerOne" })
    );
    cy.get("#log div")
      .last()
      .should("have.text", `PartnerOne:${truncatedMessage}`);

    cy.get("#next").click();
    cy.get("#skip-confirm-confirm").click();
    cy.get('[data-waiting-status="true"] .waiting-status__message', { timeout: 10000 })
      .last()
      .should("contain.text", "Yeni eşleşme aranıyor");

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
    cy.get("#log div")
      .last()
      .should("have.text", `${TEST_NICKNAME}:Tekrar merhaba!`);

    cy.get("@partner2").should(({ events }) => {
      expect(events.messages).to.deep.include({
        text: "Tekrar merhaba!",
        nickname: TEST_NICKNAME,
      });
    });

    cy.get("@partner2").then(({ socket }) => socket.disconnect());
    cy.contains("#log div", "Bağlantı sonlandı", { timeout: 10000 }).should("exist");

    cy.window()
      .then((win) => connectPartner(win))
      .as("partner3");

    cy.get("#log", { timeout: 10000 }).should(
      "contain.text",
      "✓ Bir yabancı ile eşleştiniz!"
    );

    cy.get("@partner3").then(({ socket }) => socket.disconnect());
    cy.contains("#log div", "Bağlantı sonlandı", { timeout: 10000 }).should("exist");
  });
});
