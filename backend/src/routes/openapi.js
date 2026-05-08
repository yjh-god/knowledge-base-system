const fs = require("fs");
const path = require("path");

const openapiRoute = (req, res) => {
    const filePath = path.resolve(__dirname, "../../openapi/openapi.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    res.status(200).json(json);
};

module.exports = { openapiRoute };

