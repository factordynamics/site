(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const BASE = document.body?.dataset.base || "";

  const money = (n) => {
    n = Number(n) || 0;
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  };
  const shares = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  };
  const pct = (w) => `${((Number(w) || 0) * 100).toFixed(2)}%`;
  const ticker = (h) => h.ticker || "—";
  const issuer = (h) => h.issuer || "";
  const shareClass = (h) => {
    const t = (h.title || "").toUpperCase();
    if (t.includes("CL A") || t.includes("CLASS A")) return "Class A";
    if (t.includes("CL C") || t.includes("CLASS C")) return "Class C";
    if (t.includes("CL B") || t.includes("CLASS B")) return "Class B";
    return "";
  };

  const menuBtn = $(".menu-btn");
  const nav = $(".nav");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", () => nav.classList.toggle("open"));
  }

  function waitlistHref(email) {
    const title = `Copy waitlist: ${email}`;
    const body = [
      "Copybook waitlist signup",
      "",
      `Email: ${email}`,
      `When: ${new Date().toISOString()}`,
      "",
      "Do not include payment details.",
    ].join("\n");
    return `https://github.com/factordynamics/site/issues/new?labels=copybook-waitlist&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }

  $$("[data-waitlist]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const email = form.querySelector('input[type="email"]')?.value.trim();
      if (!email || !email.includes("@")) return;
      window.location.href = waitlistHref(email);
    });
  });

  let catalog = [];
  fetch(`${BASE}data/index.json`)
    .then((r) => r.json())
    .then((data) => {
      catalog = (data.managers || []).filter((m) => m.ok);
      initHeaderSearch(catalog);
      if ($("#manager-grid")) renderManagers(catalog);
      if ($("#home-copycat")) renderHomeCopycat(data.copycat_top || []);
      if ($("#copycat-app")) initCopycat();
      if ($("#holdings-app")) initHoldings();
    })
    .catch(() => {});

  function initHeaderSearch(managers) {
    const input = $("#global-search");
    const box = $("#search-results");
    if (!input || !box) return;
    const render = (q) => {
      const query = q.trim().toLowerCase();
      if (!query) {
        box.classList.remove("open");
        box.innerHTML = "";
        return;
      }
      const hits = managers
        .filter((m) => {
          const hay = `${m.manager} ${m.name} ${m.slug} ${(m.top || []).map((h) => `${h.ticker || ""} ${h.issuer || ""}`).join(" ")}`.toLowerCase();
          return hay.includes(query);
        })
        .slice(0, 8);
      if (!hits.length) {
        box.classList.add("open");
        box.innerHTML = `<div class="empty" style="padding:12px">No managers for “${q}”</div>`;
        return;
      }
      box.classList.add("open");
      box.innerHTML = hits
        .map(
          (m, i) =>
            `<a href="${BASE}managers/${m.slug}.html" class="${i === 0 ? "active" : ""}"><div>${m.manager}</div><div class="sub">${m.name} · ${m.quarter}</div></a>`
        )
        .join("");
    };
    input.addEventListener("input", () => render(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = box.querySelector("a");
        if (first) {
          e.preventDefault();
          first.click();
        }
      }
      if (e.key === "Escape") box.classList.remove("open");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-wrap")) box.classList.remove("open");
    });
  }

  const FEATURED = ["warren-buffett", "bill-ackman", "ray-dalio", "stanley-druckenmiller", "carl-icahn"];

  function isStale(quarter) {
    return quarter && !String(quarter).startsWith("2026");
  }

  function managerCard(m) {
    const stale = isStale(m.quarter)
      ? `<span class="pill" style="margin-left:0;background:rgba(245,193,90,.12);color:var(--warn)">${m.quarter}</span>`
      : m.quarter;
    return `<a class="card" href="${BASE}managers/${m.slug}.html">
      <h3>${m.manager}</h3>
      <p class="muted" style="margin:0">${m.name}</p>
      <p class="stat">${money(m.total_value)} · ${m.position_count} names · ${stale}</p>
    </a>`;
  }

  function renderHomeCopycat(rows) {
    const el = $("#home-copycat");
    if (!el) return;
    const top = rows.slice(0, 20);
    const desktop = `<div class="table-wrap desktop-only"><table>
      <thead><tr><th>Ticker</th><th>Issuer</th><th class="num">Value as filed</th><th class="num">Weight</th><th class="num">Conviction</th><th>Held by</th></tr></thead>
      <tbody>${top
        .map((h) => {
          const cls = shareClass(h);
          return `<tr>
            <td class="ticker">${ticker(h)}</td>
            <td>${issuer(h)}${cls ? ` <span class="pill">${cls}</span>` : ""}</td>
            <td class="num">${money(h.total_value)}</td>
            <td class="num">${pct(h.weight)}</td>
            <td class="num">${h.num_investors}</td>
            <td>${chips(h.held_by_names, `${h.num_investors} managers`)}</td>
          </tr>`;
        })
        .join("")}</tbody></table></div>`;
    const mobile = `<div class="mobile-only cards">${top.map((h) => holdingCard(h)).join("")}</div>`;
    el.innerHTML = desktop + mobile;
  }

  function renderManagers(managers) {
    const grid = $("#manager-grid");
    const featured = $("#featured-grid");
    const search = $("#manager-search");
    const sort = $("#manager-sort");
    const run = () => {
      const q = (search?.value || "").trim().toLowerCase();
      let list = managers.filter((m) => {
        if (!q) return true;
        const hay = `${m.manager} ${m.name} ${m.slug}`.toLowerCase();
        return hay.includes(q);
      });
      const mode = sort?.value || "aum";
      if (mode === "name") list.sort((a, b) => a.manager.localeCompare(b.manager));
      else list.sort((a, b) => (b.total_value || 0) - (a.total_value || 0));
      if (featured) {
        const pins = FEATURED.map((s) => managers.find((m) => m.slug === s)).filter(Boolean);
        featured.innerHTML = pins.map(managerCard).join("");
      }
      grid.innerHTML = list.length
        ? list.map(managerCard).join("")
        : `<div class="empty">No managers match that search.</div>`;
    };
    search?.addEventListener("input", run);
    sort?.addEventListener("change", run);
    run();
  }

  function chips(names, extra) {
    const shown = (names || []).slice(0, 3);
    const more = Math.max(0, (names || []).length - shown.length);
    return `<div class="chips">${shown.map((n) => `<span class="chip">${n}</span>`).join("")}${
      more ? `<span class="chip">+${more}</span>` : ""
    }${extra ? `<span class="chip">${extra}</span>` : ""}</div>`;
  }

  function holdingCard(h, extra = "") {
    const cls = shareClass(h);
    const names = h.held_by_names || [];
    return `<article class="holding-card">
      <div class="row"><span class="ticker">${ticker(h)}</span><strong>${money(h.value ?? h.total_value)}</strong></div>
      <div>${issuer(h)}${cls ? ` · ${cls}` : ""}</div>
      <div class="faint">${shares(h.shares ?? h.total_shares)} sh · ${pct(h.weight)}${h.num_investors ? ` · ${h.num_investors} managers` : ""}</div>
      ${names.length ? chips(names) : ""}
      ${extra}
    </article>`;
  }

  function tableHead(cols) {
    return `<thead><tr>${cols
      .map((c) => `<th data-key="${c.key}" class="${c.num ? "num" : ""}">${c.label}</th>`)
      .join("")}</tr></thead>`;
  }

  function initCopycat() {
    fetch(`${BASE}data/copycat.json`)
      .then((r) => r.json())
      .then((book) => {
        let rows = book.holdings || [];
        let sortKey = "total_value";
        let sortDir = -1;
        let q = "";
        let limit = 50;
        const cols = [
          { key: "ticker", label: "Ticker" },
          { key: "issuer", label: "Issuer" },
          { key: "total_shares", label: "Shares", num: true },
          { key: "total_value", label: "Value as filed", num: true },
          { key: "weight", label: "Weight", num: true },
          { key: "num_investors", label: "Conviction", num: true },
          { key: "held_by", label: "Held by" },
        ];
        const paint = () => {
          const query = q.trim().toLowerCase();
          let list = rows.filter((h) => {
            if (!query) return true;
            return `${ticker(h)} ${issuer(h)} ${h.cusip || ""} ${(h.held_by_names || []).join(" ")}`.toLowerCase().includes(query);
          });
          list.sort((a, b) => {
            const av = a[sortKey] ?? ticker(a);
            const bv = b[sortKey] ?? ticker(b);
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
            return String(av).localeCompare(String(bv)) * sortDir;
          });
          const shown = list.slice(0, limit);
          $("#copycat-meta").textContent = `Showing ${shown.length} of ${list.length} names · ${money(book.total_value)} as-filed · ${book.num_investors} managers`;
          const desktop = `<div class="table-wrap desktop-only"><table>${tableHead(cols)}<tbody>${shown
            .map((h) => {
              const cls = shareClass(h);
              return `<tr>
                <td class="ticker">${ticker(h)}</td>
                <td>${issuer(h)}${cls ? ` <span class="pill">${cls}</span>` : ""}</td>
                <td class="num">${shares(h.total_shares)}</td>
                <td class="num">${money(h.total_value)}</td>
                <td class="num">${pct(h.weight)}</td>
                <td class="num">${h.num_investors}</td>
                <td>${chips(h.held_by_names, `${h.num_investors} managers`)}</td>
              </tr>`;
            })
            .join("")}</tbody></table></div>`;
          const mobile = `<div class="mobile-only cards">${shown.map((h) => holdingCard(h)).join("")}</div>`;
          $("#copycat-table").innerHTML = desktop + mobile;
          $$("#copycat-table th").forEach((th) => {
            th.classList.toggle("sort-asc", th.dataset.key === sortKey && sortDir === 1);
            th.classList.toggle("sort-desc", th.dataset.key === sortKey && sortDir === -1);
            th.addEventListener("click", () => {
              if (sortKey === th.dataset.key) sortDir *= -1;
              else {
                sortKey = th.dataset.key;
                sortDir = th.dataset.key === "ticker" || th.dataset.key === "issuer" ? 1 : -1;
              }
              paint();
            });
          });
          const more = $("#copycat-more");
          if (more) more.style.display = list.length > limit ? "inline-flex" : "none";
        };
        $("#copycat-search")?.addEventListener("input", (e) => {
          q = e.target.value;
          limit = 50;
          paint();
        });
        $("#copycat-more")?.addEventListener("click", () => {
          limit += 100;
          paint();
        });
        paint();
      });
  }

  function initHoldings() {
    const root = $("#holdings-app");
    const slug = root.dataset.slug;
    fetch(`${BASE}data/${slug}.json`)
      .then((r) => r.json())
      .then((m) => {
        let sortKey = "value";
        let sortDir = -1;
        let q = "";
        const paint = () => {
          const query = q.trim().toLowerCase();
          let list = (m.holdings || []).filter((h) =>
            `${ticker(h)} ${issuer(h)} ${h.cusip || ""}`.toLowerCase().includes(query)
          );
          list.sort((a, b) => {
            const av = a[sortKey] ?? ticker(a);
            const bv = b[sortKey] ?? ticker(b);
            if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
            return String(av).localeCompare(String(bv)) * sortDir;
          });
          const cols = [
            { key: "ticker", label: "Ticker" },
            { key: "issuer", label: "Issuer" },
            { key: "cusip", label: "CUSIP" },
            { key: "shares", label: "Shares", num: true },
            { key: "value", label: "Value as filed", num: true },
            { key: "weight", label: "Weight", num: true },
          ];
          const desktop = `<div class="table-wrap desktop-only"><table>${tableHead(cols)}<tbody>${list
            .map((h) => {
              const cls = shareClass(h);
              return `<tr>
                <td class="ticker">${ticker(h)}</td>
                <td>${issuer(h)}${cls ? ` <span class="pill">${cls}</span>` : ""}</td>
                <td class="mono">${h.cusip || ""}</td>
                <td class="num">${shares(h.shares)}</td>
                <td class="num">${money(h.value)}</td>
                <td class="num">${pct(h.weight)}</td>
              </tr>`;
            })
            .join("")}</tbody></table></div>`;
          const mobile = `<div class="mobile-only cards">${list.map((h) => holdingCard(h)).join("")}</div>`;
          $("#holdings-table").innerHTML =
            list.length ? desktop + mobile : `<div class="empty">No holdings match that search.</div>`;
          $$("#holdings-table th").forEach((th) => {
            th.classList.toggle("sort-asc", th.dataset.key === sortKey && sortDir === 1);
            th.classList.toggle("sort-desc", th.dataset.key === sortKey && sortDir === -1);
            th.addEventListener("click", () => {
              if (sortKey === th.dataset.key) sortDir *= -1;
              else {
                sortKey = th.dataset.key;
                sortDir = ["ticker", "issuer", "cusip"].includes(th.dataset.key) ? 1 : -1;
              }
              paint();
            });
          });
        };
        $("#holdings-search")?.addEventListener("input", (e) => {
          q = e.target.value;
          paint();
        });
        paint();
      });
  }
})();
