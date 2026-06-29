// api/groq.js
// Secure proxy for Groq AI completions (keeps GROQ_API_KEY hidden from client)

const https = require("https");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
// llama-3.3-70b-versatile is Groq's current recommended fast model
// mixtral-8x7b-32768 was deprecated and removed by Groq
const DEFAULT_MODEL = "llama-3.3-70b-versatile";
const FALLBACK_MODEL = "llama3-70b-8192";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(200, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, CORS_HEADERS);
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    return;
  }

  if (!GROQ_API_KEY) {
    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ ok: false, error: "GROQ_API_KEY environment variable is not configured." }));
    return;
  }

  try {
    let parsedBody = req.body;
    if (!parsedBody) {
      // Read request body stream manually (fallback)
      let bodyData = "";
      await new Promise((resolve) => {
        req.on("data", (chunk) => bodyData += chunk);
        req.on("end", resolve);
      });
      try {
        parsedBody = JSON.parse(bodyData || "{}");
      } catch (e) {
        parsedBody = {};
      }
    }

    const messages = parsedBody.messages || [];
    const maxTokens = parsedBody.max_tokens || 400;

    if (messages.length === 0) {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "Messages array is required" }));
      return;
    }

    // Helper to call Groq with a specific model
    async function callGroq(model) {
      const payload = {
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2
      };
      return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(payload);
        const options = {
          hostname: "api.groq.com",
          port: 443,
          path: "/openai/v1/chat/completions",
          method: "POST",
          headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr, "utf8")
          }
        };
        const groqReq = https.request(options, (groqRes) => {
          let responseBody = "";
          groqRes.on("data", (chunk) => responseBody += chunk);
          groqRes.on("end", () => {
            try {
              resolve({ status: groqRes.statusCode, body: JSON.parse(responseBody) });
            } catch(e) {
              resolve({ status: groqRes.statusCode, error: "Invalid JSON from Groq API", raw: responseBody });
            }
          });
        });
        groqReq.on("error", reject);
        groqReq.write(bodyStr);
        groqReq.end();
      });
    }

    // Try primary model, fallback to secondary if not found / deprecated
    let groqResponse = await callGroq(DEFAULT_MODEL);

    // If model not found (404) or model error, try fallback
    if (groqResponse.status !== 200) {
      const errMsg = groqResponse.body?.error?.message || "";
      const isModelErr = groqResponse.status === 404 || errMsg.toLowerCase().includes("model") || errMsg.toLowerCase().includes("not found") || errMsg.toLowerCase().includes("deprecated");
      if (isModelErr && FALLBACK_MODEL && FALLBACK_MODEL !== DEFAULT_MODEL) {
        console.warn(`[Groq] Primary model "${DEFAULT_MODEL}" unavailable (${groqResponse.status}), trying fallback "${FALLBACK_MODEL}"`);
        groqResponse = await callGroq(FALLBACK_MODEL);
      }
    }

    if (groqResponse.status !== 200) {
      res.writeHead(groqResponse.status, CORS_HEADERS);
      res.end(JSON.stringify({
        ok: false,
        error: groqResponse.body?.error?.message || groqResponse.error || `Groq API returned HTTP ${groqResponse.status}`
      }));
      return;
    }

    const aiText = groqResponse.body?.choices?.[0]?.message?.content || "";

    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify({
      ok: true,
      text: aiText
    }));
  } catch (err) {
    console.error("[Groq Proxy Error]:", err);
    res.writeHead(500, CORS_HEADERS);
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
};
