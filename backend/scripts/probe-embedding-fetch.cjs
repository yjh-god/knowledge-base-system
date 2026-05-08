require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const { formatFetchError } = require("../src/lib/fetchErrorDetail");

const base = process.env.EMBEDDING_API_BASE_URL;
const model = process.env.EMBEDDING_MODEL || undefined;
const apiKey = process.env.EMBEDDING_API_KEY || "";

if (!base) {
    console.error("EMBEDDING_API_BASE_URL is empty — .env not loaded or variable missing");
    process.exit(1);
}

const url = `${base.replace(/\/+$/, "")}/embeddings`;
console.log("probe url:", url);
console.log("has model:", !!model, "has apiKey:", !!apiKey);

const headers = { "Content-Type": "application/json" };
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

const body = { input: ["ping"] };
if (model) body.model = model;

(async () => {
    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body)
        });
        const text = await res.text();
        console.log("status:", res.status, "bodyHead:", text.slice(0, 300));
    } catch (e) {
        console.log("catch:", formatFetchError(url, e));
    }
})();
