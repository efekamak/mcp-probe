const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function safeHttpsUrl(candidate) {
  if (typeof candidate !== "string") return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function providerPill(label, p) {
  const cls = p.compatible ? (p.warnings > 0 ? "warn" : "pass") : "fail";
  const mark = p.compatible ? (p.warnings > 0 ? "!" : "✓") : "✕";
  return el(
    "span",
    `pill ${cls}`,
    `${label} ${mark} ${p.compatibleTools}/${p.totalTools}`,
  );
}

function statusPill(report) {
  const cls =
    report.status === "passed"
      ? "pass"
      : report.status === "warned"
        ? "warn"
        : "fail";
  return el("span", `pill ${cls}`, `Grade ${report.grade} · ${report.score}/100`);
}

function renderCard(entry) {
  const r = entry.report;
  const card = el("article", `card status-${r.status}`);
  card.dataset.status = r.status;

  const head = el("button", "card-head");
  head.type = "button";
  head.addEventListener("click", () => card.classList.toggle("is-open"));

  const row1 = el("div", "card-row-1");
  const titleWrap = el("div");
  titleWrap.append(el("span", "srv-title", entry.name));
  const ver = r.server.version ? `@${r.server.version}` : "";
  titleWrap.append(el("span", "srv-pkg", `${entry.package}${ver}`));

  const right = el("div", "badges-right");
  right.append(el("span", "pill neutral", r.target.transport.toUpperCase()));
  right.append(statusPill(r));
  right.append(el("span", "token-meta", "▾"));
  row1.append(titleWrap, right);

  const row2 = el("div", "card-row-2");
  const providers = el("div", "provider-grid");
  providers.append(
    providerPill("OpenAI", r.providers.openai),
    providerPill("Anthropic", r.providers.anthropic),
    providerPill("Gemini", r.providers.gemini),
    providerPill("Cursor", r.providers.cursor),
  );
  const safetyCls = r.safety.passed ? (r.safety.warnings > 0 ? "warn" : "pass") : "fail";
  providers.append(
    el("span", `pill ${safetyCls}`, `Safety ${r.safety.passed ? "✓" : "✕"}`),
  );

  const toolLabel = r.context.toolCount === 1 ? "1 tool" : `${r.context.toolCount} tools`;
  const tokLabel =
    r.context.tokenizer === "bytes4"
      ? `~${r.context.estimatedTokens.toLocaleString("en-US")} est. tokens`
      : `${r.context.estimatedTokens.toLocaleString("en-US")} tokens (o200k)`;
  const tokenMeta = el(
    "div",
    "token-meta",
    `${toolLabel} · ${tokLabel} · ${(r.context.totalBytes / 1024).toFixed(1)} KiB`,
  );

  row2.append(providers, tokenMeta);
  head.append(row1, row2);

  const body = el("div", "card-body");
  if (r.fatalError) {
    body.append(el("p", "", `Fatal error: ${r.fatalError}`));
  } else {
    if (r.context.heaviestTools && r.context.heaviestTools.length > 0) {
      const box = el("div", "heaviest-box");
      box.append(el("div", "heaviest-title", "Heaviest tools by context budget"));
      const maxTok = Math.max(1, ...r.context.heaviestTools.map((t) => t.estimatedTokens));
      for (const tool of r.context.heaviestTools) {
        const row = el("div", "bar-row");
        row.append(el("span", "bar-name", tool.name));
        const track = el("div", "bar-track");
        const fill = el("div", "bar-fill");
        fill.style.width = `${Math.max(4, Math.round((tool.estimatedTokens / maxTok) * 100))}%`;
        track.append(fill);
        row.append(track);
        row.append(el("span", "bar-val", `${r.context.tokenizer === "bytes4" ? "~" : ""}${tool.estimatedTokens} tok`));
        box.append(row);
      }
      body.append(box);
    }

    const table = el("table", "check-table");
    const thead = el("thead");
    const hr = el("tr");
    hr.append(el("th", "", "Status"), el("th", "", "Check"), el("th", "", "Summary"));
    thead.append(hr);
    table.append(thead);

    const tbody = el("tbody");
    for (const c of r.checks) {
      const tr = el("tr");
      const stCell = el("td");
      stCell.append(el("span", `pill ${c.status === "skip" ? "warn" : c.status}`, c.status.toUpperCase()));
      const titleCell = el("td", "", c.title);
      const sumCell = el("td");
      sumCell.append(el("div", "", c.summary));
      if (c.details && c.details.length > 0) {
        const ul = el("ul", "detail-list");
        for (const d of c.details) {
          ul.append(el("li", "", d));
        }
        sumCell.append(ul);
      }
      tr.append(stCell, titleCell, sumCell);
      tbody.append(tr);
    }
    table.append(tbody);
    body.append(table);
  }

  const links = el("div", "body-links");
  const safeRepoUrl = safeHttpsUrl(entry.repositoryUrl);
  if (safeRepoUrl) {
    const repoA = el("a", "", "Repository ↗");
    repoA.href = safeRepoUrl;
    repoA.target = "_blank";
    repoA.rel = "noopener noreferrer";
    links.append(repoA);
  }
  if (typeof entry.id === "string" && SAFE_SLUG_REGEX.test(entry.id)) {
    const badgeA = el("a", "", "Shields Badge JSON");
    badgeA.href = `./badges/${entry.id}.json`;
    badgeA.target = "_blank";
    badgeA.rel = "noopener noreferrer";
    links.append(badgeA);
  }
  body.append(links);

  card.append(head, body);
  return card;
}

async function init() {
  const res = await fetch(`./scorecard.json?t=${Date.now()}`);
  const data = await res.json();

  const metaEl = document.getElementById("run-meta");
  const dt = new Date(data.generatedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  metaEl.textContent = `LAST RUN ${dt} · Node ${data.runner.nodeVersion}${data.sourceCommit ? ` · ${data.sourceCommit}` : ""}`;

  const bar = document.getElementById("summary-bar");
  const s = data.summary;
  bar.replaceChildren(
    el("span", "stat", `${s.servers} SERVERS`),
    (() => { const x = el("span", "stat"); x.append(el("strong", "", `${s.avgScore}/100`), "AVG SCORE"); return x; })(),
    (() => { const x = el("span", "stat pass"); x.append(el("strong", "", String(s.passed)), "PASSED"); return x; })(),
    (() => { const x = el("span", "stat warn"); x.append(el("strong", "", String(s.warned)), "WARNED"); return x; })(),
    (() => { const x = el("span", "stat fail"); x.append(el("strong", "", String(s.failed + s.errors)), "FAILED"); return x; })(),
    (() => { const x = el("span", "stat"); x.append(el("strong", "", String(s.totalTools)), "TOTAL TOOLS"); return x; })(),
  );

  const container = document.getElementById("cards");
  const sorted = [...data.entries].sort((a, b) => a.report.score - b.report.score);
  const cardNodes = sorted.map(renderCard);
  container.replaceChildren(...cardNodes);

  const buttons = Array.from(document.querySelectorAll(".filter-btn"));
  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      for (const b of buttons) b.classList.remove("is-active");
      btn.classList.add("is-active");
      const mode = btn.dataset.filter;
      for (const node of cardNodes) {
        const st = node.dataset.status;
        const show =
          mode === "all" ||
          st === mode ||
          (mode === "failed" && st === "error");
        node.style.display = show ? "" : "none";
      }
    });
  }
}

init().catch((err) => {
  document.getElementById("run-meta").textContent = `Failed to load scorecard: ${err}`;
});
