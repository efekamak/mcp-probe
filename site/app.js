const SAFE_SLUG_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function toolNamesOf(entry) {
  const ctx = entry?.report?.context;
  const list = Array.isArray(ctx?.tools) && ctx.tools.length > 0
    ? ctx.tools
    : Array.isArray(ctx?.heaviestTools)
      ? ctx.heaviestTools
      : [];
  return list
    .map((t) => (t && typeof t.name === "string" ? t.name : ""))
    .filter((name) => name.length > 0);
}

export function buildSearchHaystack(entry) {
  return [
    entry?.name ?? "",
    entry?.package ?? "",
    entry?.id ?? "",
    ...toolNamesOf(entry),
  ]
    .join("\n")
    .toLowerCase();
}

export function matchesEntry(entry, state, precomputedHaystack) {
  const st = entry?.report?.status ?? "";
  const statusOk =
    state.status === "all" ||
    st === state.status ||
    (state.status === "failed" && st === "error");
  if (!statusOk) return false;

  const transport = entry?.report?.target?.transport ?? "";
  if (state.transport !== "all" && transport !== state.transport) {
    return false;
  }

  const q = (state.query ?? "").trim().toLowerCase();
  if (q.length > 0) {
    const haystack = precomputedHaystack ?? buildSearchHaystack(entry);
    if (!haystack.includes(q)) return false;
  }

  return true;
}

export function compareEntries(a, b, sortMode) {
  const tieBreak = () => {
    const byName = String(a?.name ?? "").localeCompare(String(b?.name ?? ""), undefined, {
      sensitivity: "base",
    });
    if (byName !== 0) return byName;
    return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
  };

  if (sortMode === "score-desc") {
    const d = (b?.report?.score ?? 0) - (a?.report?.score ?? 0);
    return d !== 0 ? d : tieBreak();
  }
  if (sortMode === "tokens-desc") {
    const d =
      (b?.report?.context?.estimatedTokens ?? 0) - (a?.report?.context?.estimatedTokens ?? 0);
    return d !== 0 ? d : tieBreak();
  }
  if (sortMode === "tools-desc") {
    const d = (b?.report?.context?.toolCount ?? 0) - (a?.report?.context?.toolCount ?? 0);
    return d !== 0 ? d : tieBreak();
  }
  if (sortMode === "name-asc") {
    return tieBreak();
  }
  // Default: score-asc (lowest score first)
  const d = (a?.report?.score ?? 0) - (b?.report?.score ?? 0);
  return d !== 0 ? d : tieBreak();
}

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
  head.setAttribute("aria-expanded", "false");
  head.addEventListener("click", () => {
    const isOpen = card.classList.toggle("is-open");
    head.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

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
    const isGithub = safeRepoUrl.startsWith("https://github.com/");
    const repoA = el("a", "", isGithub ? "Repository ↗" : "Official Docs ↗");
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

function statChip(value, label, cls = "") {
  const chip = el("span", cls ? `stat ${cls}` : "stat");
  chip.append(el("strong", "", String(value)), label);
  return chip;
}

async function init() {
  const res = await fetch(`./scorecard.json?t=${Date.now()}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
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
    statChip(`${s.avgScore}/100`, "AVG SCORE"),
    statChip(s.passed, "PASSED", "pass"),
    statChip(s.warned, "WARNED", "warn"),
    statChip(s.failed + s.errors, "FAILED", "fail"),
    statChip(s.totalTools, "TOTAL TOOLS"),
  );

  const items = data.entries.map((entry) => ({
    entry,
    haystack: buildSearchHaystack(entry),
    node: renderCard(entry),
  }));

  const state = {
    status: "all",
    transport: "all",
    query: "",
    sort: "score-asc",
  };

  const container = document.getElementById("cards");
  const countEl = document.getElementById("result-count");

  function applyView() {
    const matching = items
      .filter((item) => matchesEntry(item.entry, state, item.haystack))
      .sort((a, b) => compareEntries(a.entry, b.entry, state.sort));

    if (matching.length === 0) {
      container.replaceChildren(el("p", "empty", "No servers match."));
    } else {
      container.replaceChildren(...matching.map((item) => item.node));
    }

    if (countEl) {
      countEl.textContent = `Showing ${matching.length} of ${items.length} servers`;
    }
  }

  const statusButtons = Array.from(document.querySelectorAll("#filters .filter-btn"));
  for (const btn of statusButtons) {
    btn.addEventListener("click", () => {
      for (const b of statusButtons) b.classList.remove("is-active");
      btn.classList.add("is-active");
      state.status = btn.dataset.filter ?? "all";
      applyView();
    });
  }

  const transportButtons = Array.from(document.querySelectorAll("#transport-filters .filter-btn"));
  for (const btn of transportButtons) {
    btn.addEventListener("click", () => {
      for (const b of transportButtons) b.classList.remove("is-active");
      btn.classList.add("is-active");
      state.transport = btn.dataset.transport ?? "all";
      applyView();
    });
  }

  const searchInput = document.getElementById("search");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      state.query = searchInput.value;
      applyView();
    });
  }

  const sortSelect = document.getElementById("sort");
  if (sortSelect) {
    sortSelect.addEventListener("change", () => {
      state.sort = sortSelect.value;
      applyView();
    });
  }

  applyView();
}

if (typeof document !== "undefined") {
  init().catch((err) => {
    const meta = document.getElementById("run-meta");
    if (meta) meta.textContent = `Failed to load scorecard: ${err}`;
  });
}
