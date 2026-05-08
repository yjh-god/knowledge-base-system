const http = require("http");
const { createApp } = require("./app");

const createServer = async () => {
    const app = createApp();
    return http.createServer(app);
};

module.exports = { createServer };

