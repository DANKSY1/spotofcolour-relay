import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = "gpt-4o-realtime-preview";
const AI_HANDLER = "https://spotofcolour.com/ai-caller/ai-handler.php";

const wss = new WebSocketServer({ port: 8080 });
console.log("✅ Claire relay listening on port 8080");

wss.on("connection", async (twilioSocket) => {
  console.log("📞 Twilio connected");

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

  const openaiSocket = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${OPENAI_MODEL}`,
    { headers: { Authorization: `Bearer ${session.client_secret.value}` } }
  );

  openaiSocket.on("open", () => console.log("🤖 Connected to OpenAI"));

  twilioSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.event === "media" && data.media?.payload) {
        openaiSocket.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }
      if (data.event === "stop") {
        openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiSocket.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (err) {
      console.error("Parse error Twilio->OpenAI:", err.message);
    }
  });

  openaiSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "response.output_audio.delta" && data.delta) {
        twilioSocket.send(JSON.stringify({ event: "media", media: { payload: data.delta } }));
      }
      if (data.type === "response.function_call") {
        axios
          .post(AI_HANDLER, data)
          .then((res) =>
            openaiSocket.send(
              JSON.stringify({
                type: "response.function_result",
                id: data.id,
                output: res.data.response || res.data
              })
            )
          )
          .catch(console.error);
      }
    } catch (err) {
      console.error("Parse error OpenAI->Twilio:", err.message);
    }
  });

  twilioSocket.on("close", () => {
    openaiSocket.close();
    console.log("❌ Twilio disconnected");
  });
});
