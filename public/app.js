let uploadPath = null;
let runId = null;

const $ = (id) => document.getElementById(id);

$("uploadBtn").onclick = async () => {
  const f = $("csvFile").files?.[0];
  if (!f) return alert("Pick a CSV file first.");

  const text = await f.text();
  const res = await fetch("/api/upload-csv", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: text
  });
  const j = await res.json();
  if (!j.ok) return alert(j.error || "Upload failed.");

  uploadPath = j.uploadPath;
  $("uploadInfo").textContent = `Parsed ${j.count} rows (${j.validUrlCount} with valid URLs).`;
  $("runBtn").disabled = false;
};

$("loginBtn").onclick = async () => {
  $("loginInfo").textContent = "Launching browser…";
  const res = await fetch("/api/start-login", { method: "POST" });
  const j = await res.json();
  $("loginInfo").textContent = j.ok ? j.message : (j.error || "Failed to launch login browser.");
};

$("testGeminiBtn").onclick = async () => {
  $("status").textContent = "TESTING — Calling Gemini…";
  try {
    const res = await fetch("/api/test-gemini");
    const j = await res.json();
    if (!j.ok) {
      $("status").textContent = `GEMINI TEST FAILED — ${j.error || "Unknown error"}`;
      alert(`Gemini test failed:\n\nModel: ${j.model}\nError: ${j.error || "Unknown error"}`);
      return;
    }
    $("status").textContent = `GEMINI OK — Model: ${j.model}`;
    const v = j.verdict;
    alert(
      "Gemini test succeeded!\n\n" +
      `Model: ${j.model}\n` +
      `Classification: ${v.classification}\n` +
      `Match confidence: ${v.match_confidence}\n` +
      `Title score: ${v.title_match_score}\n` +
      `Paywall detected: ${v.paywall_detected}\n\n` +
      `Issue summary: ${v.issue_summary}\n` +
      `Recommended action: ${v.recommended_action}`
    );
  } catch (e) {
    $("status").textContent = `GEMINI TEST FAILED — ${e?.message || e}`;
    alert(`Gemini test failed:\n\n${e?.message || e}`);
  }
};

$("stopBtn").onclick = async () => {
  const res = await fetch("/api/stop", { method: "POST" });
  const j = await res.json();
  if (!j.ok) alert(j.error || "Failed to stop.");
};

$("runBtn").onclick = async () => {
  if (!uploadPath) return alert("Upload CSV first.");

  $("runInfo").textContent = "Starting run…";
  const res = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadPath })
  });
  const j = await res.json();
  if (!j.ok) {
    $("runInfo").textContent = j.error || "Failed to start run.";
    return;
  }
  runId = j.runId;
  $("runInfo").textContent = `Run started: ${runId}`;
};

async function poll() {
  try {
    const res = await fetch("/api/status");
    const j = await res.json();

    const { status, progress, lastMessage, runId: rid } = j;
    $("status").textContent = `${status.toUpperCase()} — ${lastMessage || ""}`;

    const running = status === "running" || status === "stopping";
    $("stopBtn").disabled = !running;
    if (status === "running") $("runBtn").disabled = true;

    const done = progress?.done ?? 0;
    const total = progress?.total ?? 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    $("bar").style.width = `${pct}%`;

    if ((status === "done" || status === "error") && rid) {
      await loadArtifacts(rid);
    }
  } catch {
    // ignore
  } finally {
    setTimeout(poll, 1000);
  }
}

async function loadArtifacts(rid) {
  const res = await fetch(`/api/run/${rid}/files`);
  const j = await res.json();
  if (!j.ok) return;

  const files = j.files || [];
  const links = files
    .filter((f) => ["results.csv", "report.html", "results.json", "results.jsonl"].includes(f.name))
    .map((f) => `<li><a href="${f.path}" target="_blank">${f.name}</a></li>`)
    .join("");

  $("artifacts").innerHTML = `
    <h3>Artifacts</h3>
    <ul>${links}</ul>
    <p class="muted">Screenshots are inside the run’s <code>screenshots/</code> folder.</p>
  `;
}

poll();
