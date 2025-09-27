const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    baseUrl: "http://127.0.0.1:6100",
    supportFile: false,
    defaultCommandTimeout: 10000,
  },
  video: false,
});
