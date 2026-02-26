import { GoogleGenerativeAI } from "@google/generative-ai";

function getApiKey() {
  return (process.env.GEMINI_API_KEY || "").trim();
}

function getModelName() {
  return (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
}

function requireKey() {
  const k = getApiKey();
  if (!k) {
    throw new Error("GEMINI_API_KEY is not set. Create a .env file based on .env.example.");
  }
  return k;
}

export async function evaluateWithGemini({ expected, signals, identityMode, resolverChain }) {
  const API_KEY = requireKey();
  const MODEL_NAME = getModelName();

  const genAI = new GoogleGenerativeAI(API_KEY);

  // JSON Schema for structured output
  const schema = {
    type: "object",
    properties: {
      classification: {
        type: "string",
        enum: [
          "correct_and_accessible",
          "correct_but_paywalled_or_partial",
          "incorrect_article",
          "uncertain_needs_review"
        ]
      },
      match_confidence: { type: "number" },
      title_match_score: { type: "number" },
      paywall_detected: { type: "boolean" },
      matched_fields: { type: "array", items: { type: "string" } },
      issue_summary: { type: "string" },
      recommended_action: { type: "string" }
    },
    required: [
      "classification",
      "match_confidence",
      "title_match_score",
      "paywall_detected",
      "matched_fields",
      "issue_summary",
      "recommended_action"
    ]
  };

  // Prefer JSON mode if supported by the selected model/API.
  // If unsupported, we'll fall back to plain text parsing.
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 750,
      responseMimeType: "application/json",
      responseSchema: schema
    }
  });

  const prompt = `
You are auditing whether a visited web page is the correct target item and whether it is complete or blocked by a paywall.

AUTH CONTEXT:
- The user authenticates via OpenAthens in the browser beforehand.
- If this looks like an OpenAthens login/consent page, recommend "Check OpenAthens login".

IDENTITY MODE:
- ${identityMode === "journal" ? "Journal/Article mode: prioritize ISSN and Journal Title when present." : "Book/Chapter mode: prioritize ISBN when present."}

EXPECTED (from CSV):
${JSON.stringify(expected, null, 2)}

NAVIGATION (resolver click chain, if any):
${JSON.stringify(resolverChain || [], null, 2)}

OBSERVED (from browser extraction):
${JSON.stringify({
  final_url: signals.finalUrl,
  observed_title: signals.observedTitle,
  meta_titles: signals.metaTitles,
  content_type_guess: signals.contentTypeGuess,
  http_status: signals.httpStatus,
  paywall_signals: signals.paywallSignals,
  found_identifiers: signals.foundIdentifiers,
  openathens_hint: signals.openAthensHint,
  text_excerpt: (signals.textExcerpt || "").slice(0, 6000)
}, null, 2)}

Return ONLY valid JSON matching the provided JSON schema.`;

  let text = "";
  try {
    const result = await model.generateContent(prompt);
    text = result.response.text();
  } catch (e) {
    // Retry with non-JSON generation config if JSON mode isn't supported.
    const fallbackModel = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { temperature: 0.2, maxOutputTokens: 750 }
    });
    const result = await fallbackModel.generateContent(prompt);
    text = result.response.text();
  }

  const cleaned = stripJson(text);
  const parsed = JSON.parse(cleaned);

  parsed.match_confidence = clamp01(parsed.match_confidence);
  parsed.title_match_score = clamp01(parsed.title_match_score);

  return parsed;
}

function stripJson(s) {
  const t = (s || "").trim();
  if (!t) return "{}";

  // If response is already JSON (JSON mode), it's typically just the object.
  if (t.startsWith("{") && t.endsWith("}")) return t;

  // Remove fenced blocks
  if (t.startsWith("```")) {
    const unfenced = t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
    if (unfenced.startsWith("{") && unfenced.endsWith("}")) return unfenced;
  }

  // Attempt to extract the first JSON object
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);

  return t;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
