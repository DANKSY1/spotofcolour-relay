import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import axios from "axios";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-realtime-preview";
const AI_HANDLER = "https://spotofcolour.com/ai-caller/ai-handler.php";

// Use Render’s assigned port
const port = process.env.PORT || 8080;

// Create an HTTP server so Render can upgrade the connection
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Claire relay running - use WSS only\n");
});

// Attach WebSocketServer to that HTTP server
const wss = new WebSocketServer({ server });
server.listen(port, () => console.log(`✅ Claire relay listening on port ${port}`));

wss.on("connection", async (twilioSocket) => {
  console.log("📞 Twilio connected");

  // Log Twilio events for debugging
  twilioSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      console.log("📨 Twilio event:", data.event);
    } catch {
      console.log("⚠️ Non-JSON message from Twilio");
    }
  });

  // --- Create OpenAI realtime session ---
  let session;
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/realtime/sessions",
      { model: OPENAI_MODEL, voice: "alloy" },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    session = response.data;
  } catch (err) {
    console.error("❌ Failed to start OpenAI session:", err.response?.data || err.message);
    twilioSocket.close();
    return;
  }

  // Explicitly use ws’ WebSocket (not Node’s built-in one)
  const openaiSocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
    { headers: { Authorization: `Bearer ${session.client_secret.value}` } }
  );

  let openaiReady = false;

  openaiSocket.on("open", () => {
    openaiReady = true;
    console.log("🤖 Connected to OpenAI");
  });

  // ----- Twilio → OpenAI -----
  twilioSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (!openaiReady) return; // wait until OpenAI socket is ready

      if (data.event === "media" && data.media?.payload) {
        openaiSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }

      if (data.event === "stop") {
        openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiSocket.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (err) {
      console.error("Parse error Twilio→OpenAI:", err.message);
    }
  });

  // ----- OpenAI → Twilio -----
  openaiSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      // forward audio deltas (Claire’s speech)
      if (data.type === "response.output_audio.delta" && data.delta) {
        twilioSocket.send(
          JSON.stringify({
            event: "media",
            media: { payload: data.delta },
          })
        );
      }

      // signal that a response finished
      if (data.type === "response.completed") {
        twilioSocket.send(JSON.stringify({ event: "mark", mark: { name: "done" } }));
      }

      // handle function calls (for Derby course lookups)
      if (data.type === "response.function_call") {
        axios
          .post(AI_HANDLER, data)
          .then((res) =>
            openaiSocket.send(
              JSON.stringify({
                type: "response.function_result",
                id: data.id,
                output: res.data.response || res.data,
              })
            )
          )
          .catch((err) => console.error("Function call error:", err.message));
      }
    } catch (err) {
      console.error("Parse error OpenAI→Twilio:", err.message);
    }
  });

  // --- Cleanup and error handling ---
  twilioSocket.on("close", (code, reason) => {
    openaiSocket.close();
    console.log(`❌ Twilio disconnected (code ${code}, reason: ${reason})`);
  });

  twilioSocket.on("error", (err) => {
    console.error("⚠️ Twilio socket error:", err);
  });

  openaiSocket.on("error", (err) => {
    console.error("⚠️ OpenAI socket error:", err);
  });
});
