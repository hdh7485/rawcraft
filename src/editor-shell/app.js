const state = {
  snapshot: null,
  pollHandle: null
};

const elements = {
  refreshPreview: document.querySelector("#refresh-preview"),
  simulateConflict: document.querySelector("#simulate-conflict"),
  previewBadges: document.querySelector("#preview-badges"),
  previewFrame: document.querySelector("#preview-frame"),
  previewMeta: document.querySelector("#preview-meta"),
  statusSummary: document.querySelector("#status-summary"),
  operationSummary: document.querySelector("#operation-summary"),
  controlsGrid: document.querySelector("#controls-grid"),
  historyList: document.querySelector("#history-list"),
  controlCardTemplate: document.querySelector("#control-card-template")
};

elements.refreshPreview.addEventListener("click", async () => {
  await postJson("/api/operations/refresh-preview", {});
  await refreshSnapshot();
});

elements.simulateConflict.addEventListener("click", async () => {
  await postJson("/api/operations/simulate-conflict", {});
  await refreshSnapshot();
});

await refreshSnapshot();

async function refreshSnapshot() {
  state.snapshot = await getJson("/api/session");
  render();
  syncPolling();
}

function syncPolling() {
  if (state.snapshot?.activeOperation && !state.pollHandle) {
    state.pollHandle = window.setInterval(() => {
      refreshSnapshot().catch((error) => {
        renderOperationError(error.message);
      });
    }, 250);
    return;
  }

  if (!state.snapshot?.activeOperation && state.pollHandle) {
    window.clearInterval(state.pollHandle);
    state.pollHandle = null;
    window.setTimeout(() => {
      refreshSnapshot().catch((error) => {
        renderOperationError(error.message);
      });
    }, 80);
  }
}

function render() {
  renderPreview();
  renderStatus();
  renderControls();
  renderHistory();
}

function renderPreview() {
  const snapshot = state.snapshot;
  const preview = snapshot.preview;
  const documentState = snapshot.document;
  const badges = [];

  if (preview?.stale) {
    badges.push(renderBadge("Stale Preview", "warning"));
  } else {
    badges.push(renderBadge("Preview Current", "success"));
  }

  if (snapshot.pendingPreviewRevisionId) {
    badges.push(renderBadge(`Rendering ${snapshot.pendingPreviewRevisionId}`, "info"));
  }

  if (snapshot.lastOperation?.status === "conflict") {
    badges.push(renderBadge("Optimistic Conflict", "danger"));
  }

  elements.previewBadges.innerHTML = badges.join("");
  elements.previewFrame.innerHTML = renderPreviewMarkup(snapshot);
  elements.previewMeta.innerHTML = `
    <div class="meta-grid">
      <div>
        <span class="meta-label">Asset</span>
        <strong>${escapeHtml(snapshot.asset.assetId)}</strong>
      </div>
      <div>
        <span class="meta-label">Revision</span>
        <strong>${escapeHtml(documentState.currentRevisionId)}</strong>
      </div>
      <div>
        <span class="meta-label">Preview Tier</span>
        <strong>${escapeHtml(preview?.actualPreviewTier ?? "none")}</strong>
      </div>
      <div>
        <span class="meta-label">Artifact</span>
        <strong>${escapeHtml(preview?.artifact?.artifactId ?? "not rendered yet")}</strong>
      </div>
    </div>
  `;
}

function renderStatus() {
  const snapshot = state.snapshot;
  const documentState = snapshot.document;
  const operation = snapshot.activeOperation ?? snapshot.lastOperation;
  elements.statusSummary.innerHTML = `
    <div class="status-card">
      <span class="meta-label">Workspace</span>
      <strong>${escapeHtml(snapshot.workspaceRoot)}</strong>
    </div>
    <div class="status-card">
      <span class="meta-label">Document</span>
      <strong>${escapeHtml(documentState.documentId)}</strong>
    </div>
    <div class="status-card">
      <span class="meta-label">Event Sequence</span>
      <strong>${documentState.latestEventSequence}</strong>
    </div>
    <div class="status-card">
      <span class="meta-label">Pending Mutation</span>
      <strong>${escapeHtml(snapshot.pendingMutation?.requestId ?? "none")}</strong>
    </div>
  `;

  if (!operation) {
    elements.operationSummary.innerHTML = `
      <div class="callout">
        <strong>Ready.</strong> Commit a control change or force a preview refresh to inspect runtime behavior.
      </div>
    `;
    return;
  }

  const operationResult = operation.result
    ? `<pre>${escapeHtml(JSON.stringify(operation.result, null, 2))}</pre>`
    : "";
  const operationError = operation.error
    ? `<p class="error-text">${escapeHtml(operation.error)}</p>`
    : "";

  elements.operationSummary.innerHTML = `
    <div class="callout ${operation.status === "conflict" ? "callout-conflict" : ""}">
      <strong>${escapeHtml(operation.type)}</strong>
      <span>${escapeHtml(operation.status)}</span>
      <span>${escapeHtml(operation.startedAt)}</span>
    </div>
    ${operationError}
    ${operationResult}
  `;
}

function renderOperationError(message) {
  elements.operationSummary.innerHTML = `
    <p class="error-text">${escapeHtml(message)}</p>
  `;
}

function renderControls() {
  const snapshot = state.snapshot;
  elements.controlsGrid.innerHTML = "";

  for (const control of snapshot.controls) {
    const fragment = elements.controlCardTemplate.content.cloneNode(true);
    const form = fragment.querySelector(".control-card");
    const title = fragment.querySelector(".control-title");
    const valueOutput = fragment.querySelector(".control-value");
    const range = fragment.querySelector(".control-range");
    const input = fragment.querySelector(".control-input");

    title.textContent = control.label;
    valueOutput.textContent = formatControlValue(control.value, control.step);
    range.name = control.tool;
    range.min = String(control.min);
    range.max = String(control.max);
    range.step = String(control.step);
    range.value = String(control.value);
    input.value = String(control.value);
    input.step = String(control.step);
    input.min = String(control.min);
    input.max = String(control.max);

    const syncValue = (nextValue) => {
      range.value = String(nextValue);
      input.value = String(nextValue);
      valueOutput.textContent = formatControlValue(Number.parseFloat(nextValue), control.step);
    };

    range.addEventListener("input", () => syncValue(range.value));
    input.addEventListener("input", () => syncValue(input.value));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await postJson("/api/operations/set-global", {
        tool: control.tool,
        value: Number.parseFloat(input.value)
      });
      await refreshSnapshot();
    });

    elements.controlsGrid.append(fragment);
  }
}

function renderHistory() {
  const items = state.snapshot.history.map((event) => {
    const opList = event.ops.map((op) => `<span class="history-op">${escapeHtml(op)}</span>`).join("");
    return `
      <li class="history-entry">
        <div class="history-sequence">#${event.sequence}</div>
        <div class="history-body">
          <p class="history-intent">${escapeHtml(event.intent?.summary ?? "Committed event")}</p>
          <p class="history-meta">${escapeHtml(event.resultRevisionId)} · ${escapeHtml(event.timestamp)}</p>
          <div class="history-ops">${opList}</div>
        </div>
      </li>
    `;
  });

  elements.historyList.innerHTML = items.join("");
}

function renderPreviewMarkup(snapshot) {
  const preview = snapshot.preview;
  const documentState = snapshot.document;
  const adjustments = snapshot.controls
    .filter((control) => Math.abs(Number(control.value)) > 0.001)
    .slice(0, 5)
    .map((control) => `${control.label}: ${formatControlValue(control.value, control.step)}`);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 780" role="img" aria-label="RawCraft preview shell">
      <defs>
        <linearGradient id="sky" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f7efe0" />
          <stop offset="45%" stop-color="#e4c9a3" />
          <stop offset="100%" stop-color="#2d5158" />
        </linearGradient>
        <linearGradient id="panel" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.95)" />
          <stop offset="100%" stop-color="rgba(248,240,225,0.72)" />
        </linearGradient>
      </defs>
      <rect width="1200" height="780" fill="url(#sky)" rx="42" />
      <rect x="72" y="72" width="1056" height="636" rx="36" fill="rgba(14,33,40,0.28)" />
      <rect x="118" y="118" width="964" height="544" rx="28" fill="url(#panel)" />
      <circle cx="924" cy="202" r="146" fill="rgba(225,104,50,0.18)" />
      <circle cx="312" cy="246" r="204" fill="rgba(53,111,126,0.22)" />
      <text x="158" y="180" font-family="Georgia, serif" font-size="42" fill="#203238">
        ${escapeXml(snapshot.asset.assetId)}
      </text>
      <text x="158" y="230" font-family="ui-monospace, monospace" font-size="24" fill="#335862">
        ${escapeXml(documentState.currentRevisionId)} · ${escapeXml(preview?.actualPreviewTier ?? "no_preview")}
      </text>
      <text x="158" y="298" font-family="ui-monospace, monospace" font-size="21" fill="#203238">
        Artifact ${escapeXml(preview?.artifact?.artifactId ?? "pending")}
      </text>
      <text x="158" y="336" font-family="ui-monospace, monospace" font-size="21" fill="#203238">
        ${escapeXml(preview?.stale ? "viewport stale while runtime catches up" : "viewport synchronized with current revision")}
      </text>
      ${adjustments
        .map(
          (line, index) => `
        <text x="158" y="${420 + index * 40}" font-family="ui-monospace, monospace" font-size="24" fill="#203238">
          ${escapeXml(line)}
        </text>`
        )
        .join("")}
    </svg>
  `;

  return `<img alt="Preview viewport" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" />`;
}

function renderBadge(label, tone) {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

function formatControlValue(value, step) {
  const fractionDigits = String(step).includes(".") ? String(step).split(".")[1].length : 0;
  return Number(value).toFixed(fractionDigits);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error ?? `GET ${url} failed.`);
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? `POST ${url} failed.`);
  }

  return payload;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
