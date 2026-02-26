import express from "express";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { parseCsvToRows, ensureDir } from "./utils.js";
import { startLoginSession, runAudit, requestStop } from "./runner.js";
import { evaluateWithGemini } from "./gemini.js";

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const DATA_DIR = path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const RUN_DIR = path.join(DATA_DIR, "runs");
const PROFILE_DIR = path.join(DATA_DIR, "browser_profile");

ensureDir(DATA_DIR);
ensureDir(UPLOAD_DIR);
ensureDir(RUN_DIR);
ensureDir(PROFILE_DIR);

let currentRun = {
  status: "idle",
  runId: null,
  progress: { done: 0, total: 0 },
  lastMessage: ""
};

app.use(express.static(PUBLIC_DIR));

app.get("/api/status", (req, res) => res.json(currentRun));

app.post("/api/upload-csv", express.text({ type: "*/*", limit: "20mb" }), async (req, res) => {
  try {
    const csvText = req.body;
    if (!csvText || typeof csvText !== "string") {
      return res.status(400).json({ error: "No CSV content received." });
    }

    const rows = await parseCsvToRows(csvText);

    const uploadPath = path.join(UPLOAD_DIR, `input_${Date.now()}.json`);
    fs.writeFileSync(uploadPath, JSON.stringify(rows, null, 2), "utf-8");

    const validUrlCount = rows.filter(r => !!r.url).length;
    res.json({ ok: true, count: rows.length, validUrlCount, uploadPath });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/start-login", async (req, res) => {
  try {
    await startLoginSession({ profileDir: PROFILE_DIR });
    res.json({
      ok: true,
      message:
        "Login browser launched. Use it to authenticate via OpenAthens (including MFA if needed). When done, return here and run the audit."
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});


app.get("/api/test-gemini", async (req, res) => {
  try {
    const expected = {
      title: "Example Article Title",
      author: "Example Author",
      journal_title: "Example Journal",
      issn: "1234-5678",
      isbn: ""
    };

    const signals = {
      httpStatus: 200,
      finalUrl: "https://example.com/article",
      observedTitle: "Example Article Title",
      metaTitles: ["Example Article Title"],
      contentTypeGuess: "html",
      paywallSignals: [],
      foundIdentifiers: { issn: ["1234-5678"], isbn: [] },
      openAthensHint: false,
      textExcerpt: "This is a short excerpt of an example article used only to verify Gemini connectivity."
    };

    const identityMode = "journal";
    const resolverChain = [];

    const verdict = await evaluateWithGemini({ expected, signals, identityMode, resolverChain });

    res.json({
      ok: true,
      model: (process.env.GEMINI_MODEL || "").trim() || "default",
      verdict
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      model: (process.env.GEMINI_MODEL || "").trim() || "default",
      error: e?.message || String(e)
    });
  }
});

app.post("/api/stop", (req, res) => {
  try {
    requestStop();
    currentRun.status = "stopping";
    currentRun.lastMessage = "Stop requested…";
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.post("/api/run", async (req, res) => {
  try {
    const { uploadPath } = req.body || {};
    if (!uploadPath || !fs.existsSync(uploadPath)) {
      return res.status(400).json({ error: "Missing or invalid uploadPath. Upload CSV first." });
    }

    const rows = JSON.parse(fs.readFileSync(uploadPath, "utf-8"));
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: "Uploaded data is empty." });
    }

    const runId = `run_${Date.now()}`;
    const outDir = path.join(RUN_DIR, runId);
    ensureDir(outDir);
    ensureDir(path.join(outDir, "screenshots"));

    currentRun = {
      status: "running",
      runId,
      progress: { done: 0, total: rows.length },
      lastMessage: "Starting…"
    };

    runAudit({
      rows,
      profileDir: PROFILE_DIR,
      outDir,
      onProgress: (p) => {
        currentRun.progress = p.progress;
        currentRun.lastMessage = p.message;
      },
      onDone: () => {
        currentRun.status = "done";
        currentRun.lastMessage = "Complete.";
      },
      onError: (err) => {
        currentRun.status = "error";
        currentRun.lastMessage = err?.message || String(err);
      }
    });

    res.json({ ok: true, runId, outDir });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/api/run/:runId/files", (req, res) => {
  const { runId } = req.params;
  const outDir = path.join(RUN_DIR, runId);
  if (!fs.existsSync(outDir)) return res.status(404).json({ error: "Run not found." });

  const files = fs.readdirSync(outDir).map((f) => ({ name: f, path: `/runs/${runId}/${f}` }));
  res.json({ ok: true, files });
});

app.use("/runs", express.static(RUN_DIR));

const PORT = process.env.PORT || 3877;
app.listen(PORT, () => {
  console.log(`blble running at http://localhost:${PORT}`);
});
