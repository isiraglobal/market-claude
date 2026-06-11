// api/groq.js
// Secure proxy for Groq AI completions (keeps GROQ_API_KEY hidden from client)

const https = require("https");

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const DEFAULT_MODEL = "mixtral-8x7b-32768";

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
    // Read request body
    let bodyData = "";
    await new Promise((resolve) => {
      req.on("data", (chunk) => bodyData += chunk);
      req.on("end", resolve);
    });

    const parsedBody = JSON.parse(bodyData || "{}");
    const messages = parsedBody.messages || [];
    const maxTokens = parsedBody.max_tokens || 400;

    if (messages.length === 0) {
      res.writeHead(400, CORS_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "Messages array is required" }));
      return;
    }

    // Build payload for Groq
    const payload = {
      model: DEFAULT_MODEL,
      messages: messages,
      max_tokens: maxTokens,
      temperature: 0.2
    };

    // Forward to Groq
    const groqResponse = await new Promise((resolve, reject) => {
      const options = {
        hostname: "api.groq.com",
        port: 443,
        path: "/openai/v1/chat/completions",
        method: "POST",
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
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
      groqReq.write(JSON.stringify(payload));
      groqReq.end();
    });

    if (groqResponse.status !== 200) {
      res.writeHead(groqResponse.status, CORS_HEADERS);
      res.end(JSON.stringify({
        ok: false,
        error: groqResponse.body?.error?.message || groqResponse.error || "Groq API error"
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
