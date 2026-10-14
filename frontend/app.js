import { ethers } from "/vendor/ethers.js";
import { SHIELD_ABI, REGISTRY_ABI, TOKEN_ABI, POOL_ABI, ROLE_NAMES, CLAIM_STATUS } from "./abi.js";

/* =========================================================
 * Helpers
 * ======================================================= */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (wei, d = 2) => Number(ethers.formatEther(wei ?? 0n)).toLocaleString(undefined, { maximumFractionDigits: d });
const num = (n, d = 2) => Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: d });
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const date = (ts) => (Number(ts) ? new Date(Number(ts) * 1000).toLocaleString() : "—");
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const EXPLORERS = { 11155111: "https://sepolia.etherscan.io" };
const NETWORKS = { 11155111: "Sepolia", 31337: "Hardhat local", 1337: "Localhost" };
const txLink = (hash) => (EXPLORERS[S.chainId] ? `<a href="${EXPLORERS[S.chainId]}/tx/${hash}" target="_blank" rel="noopener">${short(hash)}</a>` : `<span class="mono">${short(hash)}</span>`);
const addrHtml = (a) => (a && a !== ethers.ZeroAddress ? `<span class="mono" title="${esc(a)}">${same(a, S.account) ? "You" : short(a)}</span>` : "—");

const ERROR_TEXT = {
  NotAuthorized: "Your wallet's role is not allowed to perform this action.",
  InvalidInput: "Invalid input — please check the values.",
  AlreadyRegistered: "This wallet already has a role.",
  LastAdminCannotBeRemoved: "You cannot remove the last Admin.",
  InsufficientBalance: "Insufficient gUSD balance (wallet or risk pool).",
  InsufficientAllowance: "gUSD allowance too low — approve the RiskPool first.",
  FaucetCooldown: (a) => `Faucet cooldown: try again after ${new Date(Number(a[0]) * 1000).toLocaleTimeString()}.`,
  InsufficientFreeCapital: (a) => `Only ${fmt(a[0])} gUSD of free capital can be withdrawn (rest is reserved for pending claims).`,
  ProductInactive: "This product is not on sale.",
  PolicyNotActive: "This policy is expired or cancelled.",
  ClaimExceedsCoverage: (a) => `Claim exceeds remaining coverage (${fmt(a[0])} gUSD).`,
  OpenClaimExists: "This policy already has an open claim.",
  ClaimNotPending: "This claim has already been decided.",
  SelfAssessment: "You cannot assess your own claim.",
  ContractPaused: "GigShield is paused by the Admin (emergency stop).",
  Reentrancy: "Re-entrant call blocked.",
};
const ifaces = [SHIELD_ABI, TOKEN_ABI, POOL_ABI, REGISTRY_ABI].map((a) => new ethers.Interface(a));

function errMsg(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001) return "Request rejected in MetaMask.";
  let rev = e?.revert;
  if (!rev) {
    const data = e?.data ?? e?.info?.error?.data?.data ?? e?.info?.error?.data ?? e?.error?.data;
    for (const i of ifaces) {
      try { const p = i.parseError(data); if (p) { rev = p; break; } } catch { /* not this ABI */ }
    }
  }
  if (rev?.name && ERROR_TEXT[rev.name]) {
    const t = ERROR_TEXT[rev.name];
    return typeof t === "function" ? t(rev.args) : t;
  }
  return e?.shortMessage || e?.reason || e?.message || String(e);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------- toasts & modal ---------- */
function toast(html, type = "info", ttl = 5000) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = html;
  $("#toasts").appendChild(el);
  const close = () => el.remove();
  if (ttl) setTimeout(close, ttl);
  return {
    update: (h) => { el.innerHTML = h; },
    done: (h, t) => { el.innerHTML = h; el.className = `toast ${t}`; setTimeout(close, t === "error" ? 9000 : 6000); },
  };
}

/** Generic modal. `fields`: [{name,label,type,placeholder,value,options}] → resolves values or null */
function modal(title, bodyHtml, fields = [], okText = "Confirm") {
  return new Promise((resolve) => {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml + fields.map((f) => `
      <label class="field">${esc(f.label)}
        ${f.type === "textarea"
          ? `<textarea name="${f.name}" placeholder="${esc(f.placeholder)}">${esc(f.value)}</textarea>`
          : `<input name="${f.name}" type="${f.type || "text"}" placeholder="${esc(f.placeholder)}" value="${esc(f.value)}" step="any" />`}
      </label>`).join("");
    $("#modalOk").textContent = okText;
    $("#modal").hidden = false;
    $("#modalBody").querySelector("input, textarea")?.focus();
    const finish = (ok) => {
      $("#modal").hidden = true;
      $("#modalOk").onclick = $("#modalCancel").onclick = null;
      if (!ok) return resolve(null);
      const out = {};
      $("#modalBody").querySelectorAll("[name]").forEach((i) => { out[i.name] = i.value.trim(); });
      resolve(out);
    };
    $("#modalOk").onclick = () => finish(true);
    $("#modalCancel").onclick = () => finish(false);
  });
}

/* =========================================================
 * State
 * ======================================================= */
const S = {
  provider: null, signer: null, account: null, chainId: null, role: 0,
  addr: null, c: null, backend: null,
  products: [], policies: [], claims: [], pool: {}, balance: 0n, paused: false,
  eventOffset: 0,
};
const charts = {};

/* =========================================================
 * Wallet & contracts
 * ======================================================= */
async function connect(silent = false) {
  if (!window.ethereum) {
    if (!silent) toast("MetaMask not detected — install the MetaMask extension to sign transactions.", "error");
    return;
  }
  S.provider = new ethers.BrowserProvider(window.ethereum);
  const accounts = await S.provider.send(silent ? "eth_accounts" : "eth_requestAccounts", []);
  if (!accounts.length) return;
  S.signer = await S.provider.getSigner();
  S.account = await S.signer.getAddress();
  S.chainId = Number((await S.provider.getNetwork()).chainId);
  await loadContracts();
}

function storedAddress() {
  return localStorage.getItem(`gigshield:${S.chainId}`);
}

/** Identify which GigShield-family contract lives at `address` (catches "deployed the wrong contract in Remix"). */
async function identifyContract(address) {
  const probe = new ethers.Contract(address, [
    "function registry() view returns (address)", "function manager() view returns (address)",
    "function adminCount() view returns (uint256)", "function symbol() view returns (string)",
  ], S.provider);
  const ok = async (fn) => { try { await probe[fn](); return true; } catch { return false; } };
  if (await ok("manager")) return "RiskPool";
  if (await ok("registry")) return "GigShield";
  if (await ok("adminCount")) return "RoleRegistry";
  if (await ok("symbol")) return "GUSDToken";
  return "unknown";
}

async function loadContracts(explicit = null) {
  S.c = null;
  const address = explicit || storedAddress() || (S.backend?.chainId === S.chainId ? S.backend.contractAddress : null);
  if (!address) {
    renderWallet();
    showNotice(`No GigShield contract set for ${NETWORKS[S.chainId] || `chain ${S.chainId}`}. Open the <b>Setup</b> tab and paste the address you deployed in Remix.`, "warn");
    switchTab("setup");
    return;
  }
  if ((await S.provider.getCode(address)) === "0x") {
    showNotice(`No contract found at ${esc(address)} on ${NETWORKS[S.chainId] || S.chainId}. Check the MetaMask network or the address in <b>Setup</b>.`, "warn");
    switchTab("setup");
    return false;
  }
  const kind = await identifyContract(address);
  if (kind !== "GigShield") {
    const hint = kind === "unknown" ? "This address is not a GigShield contract."
      : `This address is the <b>${kind}</b> contract, not <b>GigShield</b>.`;
    showNotice(`${hint} In Remix, choose <b>GigShield</b> in the CONTRACT dropdown (it is not selected by default) and deploy again, then paste the new address here.`, "warn");
    renderWallet();
    switchTab("setup");
    return false;
  }
  const shield = new ethers.Contract(address, SHIELD_ABI, S.signer);
  const [registry, token, pool] = await Promise.all([shield.registry(), shield.token(), shield.pool()]);
  S.addr = { shield: address, registry, token, pool };
  S.c = {
    shield,
    registry: new ethers.Contract(registry, REGISTRY_ABI, S.signer),
    token: new ethers.Contract(token, TOKEN_ABI, S.signer),
    pool: new ethers.Contract(pool, POOL_ABI, S.signer),
  };
  $("#addrInput").value = address;
  $("#addrInfo").innerHTML = `Registry ${short(registry)} · Token ${short(token)} · Pool ${short(pool)}`;
  showNotice("");
  await refreshChain();
  const roleTab = { 1: "customer", 2: "auditor", 3: "admin" }[S.role];
  switchTab(roleTab || "customer");
  return true;
}

async function refreshChain() {
  if (!S.c) return;
  const { shield, registry, token, pool } = S.c;
  const [role, balance, products, policies, claims, paused, poolBal, free, premiums, payouts, deposited, withdrawn] = await Promise.all([
    registry.roleOf(S.account), token.balanceOf(S.account),
    shield.getAllProducts(), shield.getAllPolicies(), shield.getAllClaims(), shield.paused(),
    pool.balance(), pool.freeCapital(), pool.totalPremiums(), pool.totalPayouts(),
    pool.totalCapitalDeposited(), pool.totalCapitalWithdrawn(),
  ]);
  const now = Math.floor(Date.now() / 1000);
  Object.assign(S, {
    role: Number(role), balance, paused,
    products: products.map((p, id) => ({ id, name: p.name, premium: p.premium, coverage: p.coverage, durationDays: Number(p.durationDays), active: p.active })),
    policies: policies.map((p, id) => ({
      id, productId: Number(p.productId), holder: p.holder, startAt: Number(p.startAt), expiresAt: Number(p.expiresAt),
      hasOpenClaim: p.hasOpenClaim, premiumPaid: p.premiumPaid, remainingCoverage: p.remainingCoverage,
      state: Number(p.status) === 1 ? "Cancelled" : Number(p.expiresAt) <= now ? "Expired" : "Active",
    })),
    claims: claims.map((c, id) => ({
      id, policyId: Number(c.policyId), claimant: c.claimant, amount: c.amount, evidenceHash: c.evidenceHash,
      filedAt: Number(c.filedAt), decidedAt: Number(c.decidedAt), status: CLAIM_STATUS[Number(c.status)],
      assessor: c.assessor, note: c.decisionNote,
    })),
    pool: { balance: poolBal, free, premiums, payouts, deposited, withdrawn },
  });
  renderWallet();
  renderTabs();
  renderCustomer();
  renderAuditor();
  renderAdmin();
}

/**
 * Every write goes through here: estimate gas → show cost → sign in MetaMask →
 * wait for receipt → record in backend (gas estimate vs. actual) → refresh.
 */
async function sendTx(label, contract, method, args = []) {
  let gas;
  try {
    gas = await contract[method].estimateGas(...args);
  } catch (e) {
    toast(`<b>${esc(label)}</b> would fail: ${esc(errMsg(e))}`, "error", 9000);
    e.toasted = true;
    throw e;
  }
  const fee = await S.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const ok = await modal(`Confirm: ${label}`, `
    <table class="gas-table">
      <tr><td>Estimated gas</td><td>${gas.toLocaleString()} units</td></tr>
      <tr><td>Gas price (max)</td><td>${num(ethers.formatUnits(price, "gwei"), 3)} gwei</td></tr>
      <tr><td>Max network fee</td><td>${num(ethers.formatEther(gas * price), 6)} ETH</td></tr>
    </table>
    <p class="muted small">Next, MetaMask will ask you to sign this transaction.</p>`, [], "Sign in MetaMask");
  if (!ok) throw new Error("cancelled");

  const t = toast(`<b>${esc(label)}</b>: waiting for MetaMask signature…`, "info", 0);
  try {
    const tx = await contract[method](...args, { gasLimit: (gas * 125n) / 100n });
    t.update(`<b>${esc(label)}</b>: submitted ${txLink(tx.hash)}, waiting for confirmation…`);
    const rc = await tx.wait();
    t.done(`<b>${esc(label)}</b> confirmed ✓ — gas used ${rc.gasUsed.toLocaleString()} (estimated ${gas.toLocaleString()}) ${txLink(tx.hash)}`, "success");
    api("/api/transactions", {
      method: "POST",
      body: { hash: tx.hash, action: label, from: S.account, gasEstimate: gas.toString(), gasUsed: rc.gasUsed.toString(), gasPrice: (rc.gasPrice ?? 0n).toString(), status: "success" },
    }).catch((err) => console.warn("backend tx record failed:", err.message));
    await refreshChain();
    setTimeout(refreshBackend, 2500);
    setTimeout(refreshBackend, 9000);
    return rc;
  } catch (e) {
    t.done(`<b>${esc(label)}</b> failed: ${esc(errMsg(e))}`, "error");
    e.toasted = true;
    throw e;
  }
}

/** Wrap UI handlers: errors are already shown as toasts by sendTx. */
const run = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) {
    if (e?.message !== "cancelled" && !e?.toasted) console.error(e);
  }
};

/** Approve exactly `amount` gUSD to the RiskPool if the current allowance is too small. */
async function ensureAllowance(amount) {
  const current = await S.c.token.allowance(S.account, S.addr.pool);
  if (current < amount) await sendTx("Approve gUSD", S.c.token, "approve", [S.addr.pool, amount]);
}

/* =========================================================
 * Rendering
 * ======================================================= */
function showNotice(html, type = "") {
  $("#notice").innerHTML = html ? `<div class="notice ${type}">${html}</div>` : "";
}

function renderWallet() {
  if (!S.account) return;
  const roleName = ROLE_NAMES[S.role] || "None";
  $("#wallet").innerHTML = `
    <span class="pill">${esc(NETWORKS[S.chainId] || `Chain ${S.chainId}`)}</span>
    ${S.c ? `<span class="pill">💰 ${fmt(S.balance)} gUSD</span>` : ""}
    <span class="pill mono" title="${esc(S.account)}">${short(S.account)}</span>
    <span class="badge ${roleName.toLowerCase()}">${roleName === "None" ? "No role" : roleName}</span>`;
}

function renderTabs() {
  document.querySelectorAll("#tabs [data-role]").forEach((b) => {
    // Customers also see the Customer tab when unregistered so they can register
    const r = Number(b.dataset.role);
    b.hidden = !(S.role === r || (r === 1 && S.role === 0));
  });
}

function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  if (name === "dashboard" || name === "activity") refreshBackend();
}

const productName = (id) => S.products[id]?.name ?? `#${id}`;
const statusBadge = (s) => `<span class="badge ${s.toLowerCase()}">${s}</span>`;
const table = (heads, rows, empty) => `
  <thead><tr>${heads.map((h) => `<th class="${h.endsWith(" ") ? "num" : ""}">${h}</th>`).join("")}</tr></thead>
  <tbody>${rows.length ? rows.join("") : `<tr><td class="empty" colspan="${heads.length}">${empty}</td></tr>`}</tbody>`;

/* ---------- Customer ---------- */
function renderCustomer() {
  const el = $("#tab-customer");
  if (S.role === 0) {
    el.innerHTML = `
      <div class="card">
        <h3>Welcome to GigShield 👋</h3>
        <p class="muted">Register this wallet as a <b>Customer</b> (gig worker) to buy affordable micro-insurance and file claims on-chain.</p>
        <button class="btn primary" id="btnRegister">Register as Customer</button>
      </div>`;
    $("#btnRegister").onclick = run(() => sendTx("Register as Customer", S.c.registry, "registerAsCustomer"));
    return;
  }
  if (S.role !== 1) { el.innerHTML = ""; return; }

  const myPolicies = S.policies.filter((p) => same(p.holder, S.account)).reverse();
  const myClaims = S.claims.filter((c) => same(c.claimant, S.account)).reverse();

  el.innerHTML = `
    ${S.paused ? `<div class="notice warn">⏸ GigShield is paused by the Admin. New policies and claims are temporarily disabled.</div>` : ""}
    <div class="card">
      <div class="card-head">
        <h3>Wallet</h3>
        <div class="inline">
          <b>${fmt(S.balance)} gUSD</b>
          <button class="btn" id="btnFaucet">🚰 Get 1,000 test gUSD</button>
        </div>
      </div>
      <p class="muted small">gUSD is the test stablecoin used for premiums and payouts.</p>
    </div>

    <div class="card">
      <h3>Insurance products</h3>
      <div class="products">
        ${S.products.filter((p) => p.active).map((p) => `
          <div class="product">
            <h4>${esc(p.name)}</h4>
            <div class="price">${fmt(p.premium)} gUSD</div>
            <div class="meta">Coverage up to <b>${fmt(p.coverage)} gUSD</b><br/>Valid for ${p.durationDays} days</div>
            <button class="btn primary" data-buy="${p.id}">Buy policy</button>
          </div>`).join("") || `<p class="muted">No products on sale yet — the Admin needs to create one.</p>`}
      </div>
    </div>

    <div class="card">
      <h3>My policies</h3>
      <div class="table-wrap"><table>${table(
        ["ID", "Product", "Remaining cover ", "Expires", "Status", "Actions"],
        myPolicies.map((p) => `<tr>
          <td>#${p.id}</td><td>${esc(productName(p.productId))}</td>
          <td class="num">${fmt(p.remainingCoverage)}</td><td>${date(p.expiresAt)}</td>
          <td>${statusBadge(p.state)}${p.hasOpenClaim ? ` <span class="badge pending">claim open</span>` : ""}</td>
          <td class="inline">${p.state === "Active" && !p.hasOpenClaim
            ? `<button class="btn sm primary" data-claim="${p.id}">File claim</button>
               <button class="btn sm red" data-cancel="${p.id}">Cancel</button>` : ""}</td>
        </tr>`), "You have no policies yet.")}</table></div>
    </div>

    <div class="card">
      <h3>My claims</h3>
      <div class="table-wrap"><table>${table(
        ["ID", "Policy", "Amount ", "Filed", "Status", "Auditor note", ""],
        myClaims.map((c) => `<tr>
          <td>#${c.id}</td><td>#${c.policyId}</td><td class="num">${fmt(c.amount)}</td><td>${date(c.filedAt)}</td>
          <td>${statusBadge(c.status)}</td><td>${esc(c.note) || "—"}</td>
          <td>${c.status === "Pending" ? `<button class="btn sm" data-withdraw="${c.id}">Withdraw</button>` : ""}</td>
        </tr>`), "No claims filed.")}</table></div>
    </div>`;

  $("#btnFaucet").onclick = run(() => sendTx("Faucet", S.c.token, "faucet"));
  el.querySelectorAll("[data-buy]").forEach((b) => (b.onclick = run(async () => {
    const p = S.products[Number(b.dataset.buy)];
    await ensureAllowance(p.premium);
    await sendTx("Buy policy", S.c.shield, "buyPolicy", [p.id]);
  })));
  el.querySelectorAll("[data-claim]").forEach((b) => (b.onclick = run(() => fileClaim(Number(b.dataset.claim)))));
  el.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = run(() => sendTx("Cancel policy", S.c.shield, "cancelPolicy", [Number(b.dataset.cancel)]))));
  el.querySelectorAll("[data-withdraw]").forEach((b) => (b.onclick = run(() => sendTx("Withdraw claim", S.c.shield, "withdrawClaim", [Number(b.dataset.withdraw)]))));
}

async function fileClaim(policyId) {
  const pol = S.policies[policyId];
  const v = await modal(`File claim on policy #${policyId}`,
    `<p class="muted">Remaining coverage: <b>${fmt(pol.remainingCoverage)} gUSD</b>. Your description is stored off-chain; only its keccak256 hash is written on-chain so the auditor can verify it was not altered.</p>`,
    [
      { name: "amount", label: "Claim amount (gUSD)", type: "number", placeholder: "e.g. 120" },
      { name: "text", label: "What happened? (evidence, receipts, dates)", type: "textarea", placeholder: "e.g. 12 Oct, slipped on wet road during GrabFood delivery, clinic receipt #A123 for 120 SGD" },
    ], "Continue");
  if (!v) return;
  let amount;
  try { amount = ethers.parseEther(v.amount || "0"); } catch { amount = 0n; }
  if (amount <= 0n) return toast("Enter a positive claim amount.", "error");
  if (v.text.length < 10) return toast("Please describe the incident (at least 10 characters).", "error");

  let hash;
  try {
    ({ hash } = await api("/api/evidence", { method: "POST", body: { text: v.text, submitter: S.account } }));
  } catch (e) {
    return toast(`Could not store evidence in backend: ${esc(e.message)}`, "error");
  }
  if (hash !== ethers.id(v.text)) return toast("Evidence hash mismatch from backend — aborted.", "error");
  await sendTx("File claim", S.c.shield, "fileClaim", [policyId, amount, hash]);
}

/* ---------- Auditor ---------- */
async function renderAuditor() {
  const el = $("#tab-auditor");
  if (S.role !== 2) { el.innerHTML = ""; return; }
  const pending = S.claims.filter((c) => c.status === "Pending");
  const decided = S.claims.filter((c) => c.status !== "Pending").reverse();

  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><small>Pending claims</small><b>${pending.length}</b></div>
      <div class="kpi"><small>Pool balance</small><b>${fmt(S.pool.balance)}</b> <span>gUSD</span></div>
      <div class="kpi"><small>Reserved for pending</small><b>${fmt(S.pool.balance - S.pool.free)}</b> <span>gUSD</span></div>
    </div>
    <div class="card">
      <h3>Claims queue</h3>
      <div id="queue">${pending.length ? "" : `<p class="muted">🎉 No pending claims.</p>`}</div>
    </div>
    <div class="card">
      <h3>Decision history (audit trail)</h3>
      <div class="table-wrap"><table>${table(
        ["Claim", "Claimant", "Amount ", "Status", "Decided by", "Decided at", "Note"],
        decided.map((c) => `<tr><td>#${c.id}</td><td>${addrHtml(c.claimant)}</td><td class="num">${fmt(c.amount)}</td>
          <td>${statusBadge(c.status)}</td><td>${addrHtml(c.assessor)}</td><td>${date(c.decidedAt)}</td><td>${esc(c.note) || "—"}</td></tr>`),
        "No decisions yet.")}</table></div>
    </div>`;

  const queue = $("#queue");
  const renderId = (S.auditRender = (S.auditRender || 0) + 1);
  for (const c of pending) {
    const pol = S.policies[c.policyId];
    let ev = null;
    try { ev = await api(`/api/evidence/${c.evidenceHash}`); } catch { /* missing evidence */ }
    if (renderId !== S.auditRender) return; // a newer render started meanwhile
    const intact = ev && ethers.id(ev.text) === c.evidenceHash;
    const box = document.createElement("div");
    box.className = "product";
    box.style.marginBottom = "12px";
    box.innerHTML = `
      <div class="card-head" style="margin:0">
        <h4>Claim #${c.id} · ${fmt(c.amount)} gUSD</h4>
        <span class="muted small">Filed ${date(c.filedAt)}</span>
      </div>
      <div class="meta">Policy #${c.policyId} (${esc(productName(pol.productId))}) · claimant ${addrHtml(c.claimant)} ·
        remaining cover ${fmt(pol.remainingCoverage)} gUSD</div>
      <div class="evidence">${ev ? esc(ev.text) : "<i>Evidence text not found in backend.</i>"}</div>
      <div>${intact ? `<span class="badge ok">✓ Evidence matches on-chain hash</span>` : `<span class="badge bad">✗ Evidence missing or altered</span>`}
        <span class="mono muted small" title="${c.evidenceHash}">${short(c.evidenceHash)}</span></div>
      <div class="inline">
        <input placeholder="Decision note (required for rejection)" data-note />
        <button class="btn green" data-approve>Approve &amp; pay</button>
        <button class="btn red" data-reject>Reject</button>
      </div>`;
    const note = () => box.querySelector("[data-note]").value.trim();
    box.querySelector("[data-approve]").onclick = run(() => sendTx("Approve claim", S.c.shield, "approveClaim", [c.id, note() || "Approved"]));
    box.querySelector("[data-reject]").onclick = run(async () => {
      if (!note()) return toast("Please enter a reason for the rejection.", "error");
      await sendTx("Reject claim", S.c.shield, "rejectClaim", [c.id, note()]);
    });
    queue.appendChild(box);
  }
}

/* ---------- Admin ---------- */
async function renderAdmin() {
  const el = $("#tab-admin");
  if (S.role !== 3) { el.innerHTML = ""; return; }
  const p = S.pool;
  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><small>Pool balance</small><b>${fmt(p.balance)}</b> <span>gUSD</span></div>
      <div class="kpi"><small>Free capital</small><b>${fmt(p.free)}</b> <span>gUSD</span></div>
      <div class="kpi"><small>Premiums collected</small><b>${fmt(p.premiums)}</b> <span>gUSD</span></div>
      <div class="kpi"><small>Payouts</small><b>${fmt(p.payouts)}</b> <span>gUSD</span></div>
      <div class="kpi"><small>My wallet</small><b>${fmt(S.balance)}</b> <span>gUSD</span></div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Risk pool capital</h3>
        <div class="inline" style="margin-bottom:10px">
          <input id="capAmount" type="number" placeholder="Amount (gUSD)" step="any" />
          <button class="btn primary" id="btnDeposit">Deposit</button>
          <button class="btn" id="btnWithdraw">Withdraw</button>
        </div>
        <button class="btn ghost sm" id="btnAdminFaucet">🚰 Get 1,000 test gUSD</button>
      </div>
      <div class="card">
        <h3>Emergency control</h3>
        <p class="muted">Status: ${S.paused ? `<span class="badge bad">Paused</span>` : `<span class="badge ok">Running</span>`}</p>
        <button class="btn ${S.paused ? "green" : "red"}" id="btnPause">${S.paused ? "▶ Unpause" : "⏸ Pause"} GigShield</button>
      </div>
    </div>

    <div class="card">
      <h3>Create insurance product</h3>
      <div class="form-grid">
        <label>Name<input id="pName" placeholder="Rider Accident Cover" value="Rider Accident Cover" /></label>
        <label>Premium (gUSD)<input id="pPremium" type="number" value="10" step="any" /></label>
        <label>Coverage (gUSD)<input id="pCoverage" type="number" value="500" step="any" /></label>
        <label>Duration (days)<input id="pDays" type="number" value="30" /></label>
        <button class="btn primary" id="btnCreate">Create product</button>
      </div>
      <div class="table-wrap" style="margin-top:14px"><table>${table(
        ["ID", "Name", "Premium ", "Coverage ", "Days", "Status", ""],
        S.products.map((x) => `<tr><td>#${x.id}</td><td>${esc(x.name)}</td><td class="num">${fmt(x.premium)}</td>
          <td class="num">${fmt(x.coverage)}</td><td>${x.durationDays}</td><td><span class="badge ${x.active ? "ok" : "bad"}">${x.active ? "Active" : "Inactive"}</span></td>
          <td><button class="btn sm" data-toggle="${x.id}" data-active="${x.active}">${x.active ? "Deactivate" : "Activate"}</button></td></tr>`),
        "No products yet.")}</table></div>
    </div>

    <div class="card">
      <h3>User roles</h3>
      <div class="inline">
        <input id="roleAddr" placeholder="0x… wallet address" />
        <select id="roleSel"><option value="2">Auditor</option><option value="1">Customer</option><option value="3">Admin</option></select>
        <button class="btn primary" id="btnGrant">Grant role</button>
        <button class="btn red" id="btnRevoke">Revoke role</button>
      </div>
      <div class="table-wrap" style="margin-top:14px"><table id="membersTable"></table></div>
    </div>`;

  const amount = () => {
    try { const a = ethers.parseEther($("#capAmount").value || "0"); if (a > 0n) return a; } catch { /* fallthrough */ }
    toast("Enter a positive amount.", "error");
    return null;
  };
  $("#btnDeposit").onclick = run(async () => {
    const a = amount(); if (!a) return;
    await ensureAllowance(a);
    await sendTx("Deposit capital", S.c.pool, "deposit", [a]);
  });
  $("#btnWithdraw").onclick = run(async () => { const a = amount(); if (a) await sendTx("Withdraw capital", S.c.pool, "withdraw", [a]); });
  $("#btnAdminFaucet").onclick = run(() => sendTx("Faucet", S.c.token, "faucet"));
  $("#btnPause").onclick = run(() => sendTx(S.paused ? "Unpause" : "Pause", S.c.shield, "setPaused", [!S.paused]));
  $("#btnCreate").onclick = run(async () => {
    let premium, coverage;
    try { premium = ethers.parseEther($("#pPremium").value); coverage = ethers.parseEther($("#pCoverage").value); }
    catch { return toast("Premium and coverage must be numbers.", "error"); }
    await sendTx("Create product", S.c.shield, "createProduct", [$("#pName").value.trim(), premium, coverage, Number($("#pDays").value)]);
  });
  el.querySelectorAll("[data-toggle]").forEach((b) => (b.onclick = run(() =>
    sendTx(b.dataset.active === "true" ? "Deactivate product" : "Activate product", S.c.shield, "setProductActive", [Number(b.dataset.toggle), b.dataset.active !== "true"]))));
  const target = () => {
    const a = $("#roleAddr").value.trim();
    if (!ethers.isAddress(a)) { toast("Enter a valid wallet address.", "error"); return null; }
    return a;
  };
  $("#btnGrant").onclick = run(async () => { const a = target(); if (a) await sendTx("Grant role", S.c.registry, "grantRole", [a, Number($("#roleSel").value)]); });
  $("#btnRevoke").onclick = run(async () => { const a = target(); if (a) await sendTx("Revoke role", S.c.registry, "revokeRole", [a]); });
  renderMembers();
}

/** Current role holders, reconstructed from indexed RoleChanged events, confirmed on-chain. */
async function renderMembers() {
  const tbl = $("#membersTable");
  if (!tbl) return;
  let items = [];
  try { ({ items } = await api("/api/events?name=RoleChanged&limit=500")); } catch (e) {
    tbl.innerHTML = `<tr><td class="empty">Member list needs the backend: ${esc(e.message)}</td></tr>`;
    return;
  }
  const latest = new Map();
  for (const e of items.slice().reverse()) latest.set(e.args.account, e);
  const rows = [...latest.values()].filter((e) => Number(e.args.newRole) !== 0).map((e) => {
    const r = ROLE_NAMES[Number(e.args.newRole)];
    return `<tr><td class="mono">${esc(e.args.account)}${same(e.args.account, S.account) ? " (you)" : ""}</td>
      <td><span class="badge ${r.toLowerCase()}">${r}</span></td><td>${date(e.timestamp)}</td>
      <td><button class="btn sm ghost" data-fill="${esc(e.args.account)}">Select</button></td></tr>`;
  });
  tbl.innerHTML = table(["Wallet", "Role", "Since", ""], rows, "No members indexed yet (register the contract with the backend in Setup).");
  tbl.querySelectorAll("[data-fill]").forEach((b) => (b.onclick = () => { $("#roleAddr").value = b.dataset.fill; }));
}

/* ---------- Dashboard & activity (backend data) ---------- */
async function refreshBackend() {
  try {
    S.backend = await api("/api/config");
  } catch {
    showNotice("Backend API not reachable — dashboard and event log are unavailable.", "warn");
    return;
  }
  $("#backendInfo").innerHTML = S.backend.contractAddress
    ? `Backend indexing <span class="mono">${esc(S.backend.contractAddress)}</span> on chain ${S.backend.chainId} · last block ${S.backend.indexer?.lastBlock ?? "…"}${S.backend.indexer?.lastError ? ` · ⚠ ${esc(S.backend.indexer.lastError)}` : ""}`
    : `Backend connected to chain ${S.backend.chainId ?? "?"} — no contract registered yet.`;
  if (!S.backend.contractAddress) {
    $("#kpis").innerHTML = `<div class="notice warn" style="grid-column:1/-1">The backend has no contract registered yet. Admin: open <b>Setup → Sign &amp; register with backend</b>.</div>`;
    return;
  }
  if ($("#tab-dashboard").classList.contains("active")) await renderDashboard();
  if ($("#tab-activity").classList.contains("active")) await renderActivity(true);
  if (S.role === 3) renderMembers();
}

async function renderDashboard() {
  let st;
  try { st = await api("/api/stats"); } catch (e) { $("#kpis").innerHTML = `<div class="notice warn">${esc(e.message)}</div>`; return; }
  const t = st.totals;
  const kpi = (label, value, unit = "") => `<div class="kpi"><small>${label}</small><b>${value}</b> <span>${unit}</span></div>`;
  $("#kpis").innerHTML = [
    kpi("Pool balance", num(t.poolBalance), "gUSD"),
    kpi("Premiums collected", num(t.premiums), "gUSD"),
    kpi("Claims paid", num(t.claimPayouts), "gUSD"),
    kpi("Policies sold", t.policies),
    kpi("Customers", t.customers),
    kpi("Pending claims", st.claims.pending),
    kpi("Loss ratio", t.lossRatio == null ? "—" : `${num(t.lossRatio * 100, 1)}%`, "payouts / premiums"),
    kpi("Avg. decision time", t.avgDecisionSec == null ? "—" : humanDuration(t.avgDecisionSec), "file → decision"),
  ].join("");

  const palette = ["#2f5cf0", "#15955b", "#d64545", "#c27a00", "#7b5cd6", "#1aa3b8", "#8a94a6"];
  drawChart("chartClaims", "doughnut", {
    labels: ["Pending", "Paid", "Rejected", "Withdrawn"],
    datasets: [{ data: [st.claims.pending, st.claims.approved, st.claims.rejected, st.claims.withdrawn], backgroundColor: ["#c27a00", "#15955b", "#d64545", "#8a94a6"] }],
  });
  drawChart("chartFlows", "bar", {
    labels: st.daily.map((d) => d.date),
    datasets: [
      { label: "Premiums", data: st.daily.map((d) => d.premiums), backgroundColor: "#2f5cf0" },
      { label: "Payouts", data: st.daily.map((d) => d.payouts), backgroundColor: "#d64545" },
    ],
  });
  drawChart("chartGas", "bar", {
    labels: st.gas.map((g) => g.action),
    datasets: [
      { label: "Estimated", data: st.gas.map((g) => Math.round(g.avgEstimate)), backgroundColor: "#a9bbf7" },
      { label: "Used", data: st.gas.map((g) => Math.round(g.avgUsed)), backgroundColor: "#2f5cf0" },
    ],
  }, { indexAxis: "y" });
  drawChart("chartEvents", "bar", {
    labels: st.eventCounts.map((e) => e.name),
    datasets: [{ label: "Events", data: st.eventCounts.map((e) => e.count), backgroundColor: st.eventCounts.map((_, i) => palette[i % palette.length]) }],
  }, { plugins: { legend: { display: false } } });
}

function humanDuration(sec) {
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${num(sec / 3600, 1)} h`;
  return `${num(sec / 86400, 1)} d`;
}

function drawChart(id, type, data, extra = {}) {
  if (!window.Chart) return;
  charts[id]?.destroy();
  charts[id] = new window.Chart(document.getElementById(id), {
    type, data,
    options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { position: "bottom" } }, ...extra },
  });
}

async function renderActivity(reset = false) {
  if (reset) S.eventOffset = 0;
  // My transactions
  if (S.account) {
    try {
      const { items } = await api(`/api/transactions?from=${S.account}`);
      $("#txTable").innerHTML = table(["Time", "Action", "Tx", "Gas est. ", "Gas used ", "Fee (ETH) ", "Status"],
        items.map((x) => `<tr><td>${new Date(x.created_at).toLocaleString()}</td><td>${esc(x.action)}</td><td>${txLink(x.hash)}</td>
          <td class="num">${Number(x.gas_estimate || 0).toLocaleString()}</td><td class="num">${Number(x.gas_used || 0).toLocaleString()}</td>
          <td class="num">${x.gas_used && x.gas_price ? num(ethers.formatEther(BigInt(x.gas_used) * BigInt(x.gas_price)), 6) : "—"}</td>
          <td><span class="badge ${x.status === "success" ? "ok" : "bad"}">${esc(x.status)}</span></td></tr>`),
        "No transactions from this wallet yet.");
    } catch (e) { $("#txTable").innerHTML = `<tr><td class="empty">${esc(e.message)}</td></tr>`; }
  } else {
    $("#txTable").innerHTML = `<tr><td class="empty">Connect MetaMask to see your transactions.</td></tr>`;
  }

  // Event log
  const name = $("#eventFilter").value;
  const qs = new URLSearchParams({ limit: 25, offset: S.eventOffset });
  if (name) qs.set("name", name);
  if ($("#eventMine").checked && S.account) qs.set("actor", S.account);
  try {
    const res = await api(`/api/events?${qs}`);
    const rows = res.items.map((e) => `<tr><td>${date(e.timestamp)}</td><td>#${e.block_number}</td><td><span class="badge">${esc(e.source)}</span></td>
      <td><b>${esc(e.name)}</b></td><td class="mono small">${esc(describeArgs(e.args))}</td><td>${txLink(e.tx_hash)}</td></tr>`);
    if (reset) $("#eventTable").innerHTML = table(["Time", "Block", "Contract", "Event", "Details", "Tx"], rows, "No events yet.");
    else $("#eventTable tbody").insertAdjacentHTML("beforeend", rows.join(""));
    S.eventOffset += res.items.length;
    $("#eventMore").hidden = S.eventOffset >= res.total;
  } catch (e) { $("#eventTable").innerHTML = `<tr><td class="empty">${esc(e.message)}</td></tr>`; }
}

function describeArgs(args) {
  return Object.entries(args).map(([k, v]) => {
    if (typeof v === "string" && /^\d{19,}$/.test(v)) v = `${num(ethers.formatEther(v))} gUSD`;
    else if (typeof v === "string" && ethers.isAddress(v)) v = same(v, S.account) ? "you" : short(v);
    else if (typeof v === "string" && v.length === 66) v = short(v);
    if (k === "oldRole" || k === "newRole") v = ROLE_NAMES[Number(v)];
    if (k === "expiresAt") v = date(v);
    return `${k}=${v}`;
  }).join("  ");
}

/* =========================================================
 * Setup tab
 * ======================================================= */
$("#addrSave").onclick = run(async () => {
  const a = $("#addrInput").value.trim();
  if (!ethers.isAddress(a)) return toast("Enter a valid contract address.", "error");
  if (!S.account) await connect();
  if (!S.chainId) return;
  if (await loadContracts(ethers.getAddress(a))) {
    localStorage.setItem(`gigshield:${S.chainId}`, ethers.getAddress(a));
    toast("Contract loaded ✓", "success");
  } else {
    localStorage.removeItem(`gigshield:${S.chainId}`);
    toast("Contract not loaded — see the message at the top of the page.", "error");
  }
});

$("#registerBackend").onclick = run(async () => {
  if (!S.c) return toast("No GigShield contract loaded yet: paste the GigShield address in step 1 and click “Use this contract” first.", "error");
  if (S.role !== 3) return toast("Only an Admin wallet can register the contract with the backend.", "error");
  const timestamp = Date.now();
  const message = `GigShield: register contract ${ethers.getAddress(S.addr.shield)} at ${timestamp}`;
  let signature;
  try { signature = await S.signer.signMessage(message); } catch (e) { return toast(esc(errMsg(e)), "error"); }
  try {
    await api("/api/config", { method: "POST", body: { address: S.addr.shield, timestamp, signature } });
    toast("Backend now indexes this contract ✓", "success");
    setTimeout(refreshBackend, 2000);
  } catch (e) { toast(`Backend registration failed: ${esc(e.message)}`, "error"); }
});

/* =========================================================
 * Boot
 * ======================================================= */
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
$("#connectBtn").onclick = run(() => connect(false));
$("#eventFilter").onchange = () => renderActivity(true);
$("#eventMine").onchange = () => renderActivity(true);
$("#eventMore").onclick = () => renderActivity(false);
[
  "RoleChanged", "Transfer", "Approval", "CapitalDeposited", "CapitalWithdrawn", "PremiumCollected", "PayoutSent",
  "ProductCreated", "ProductStatusChanged", "PolicyPurchased", "PolicyCancelled",
  "ClaimFiled", "ClaimApproved", "ClaimRejected", "ClaimWithdrawn", "PausedStateChanged",
].forEach((n) => $("#eventFilter").insertAdjacentHTML("beforeend", `<option>${n}</option>`));

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
}

(async () => {
  await refreshBackend();
  await connect(true).catch((e) => console.warn(e));
  setInterval(() => { if (!document.hidden) refreshBackend(); }, 15000);
})();
