import { pipeline } from "@huggingface/transformers";
console.log("loading whisper-tiny...");
const t0 = Date.now();
try {
  const pipe = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny");
  console.log("loaded in", (Date.now()-t0)/1000, "s");
} catch (e) {
  console.error("LOAD FAILED:", e.message);
  process.exit(1);
}
