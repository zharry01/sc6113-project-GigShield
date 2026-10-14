// GigShield backend: REST API + SQLite persistence + on-chain event indexer + static frontend
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { db, getMeta, setMeta } from "./db.js";
import { Indexer } from "./indexer.js";
import { REGISTRY_ABI, SHIELD_ABI } from "../frontend/abi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";
const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: false });
const indexer = new Indexer(provider);
let chainId = null;

/* ---------------- helpers ---------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isAddress = (v) => typeof v === "string" && ethers.isAddress(v);
const isHash = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const fromWei = (v) => Number(ethers.formatEther(BigInt(v || 0)));

function requireContract() {
  if (!indexer.contract) throw new HttpError(409, "No GigShield contract configured yet. Set it on the Setup page.");
  return indexer.contract;
}

function intParam(value, fallback, max) {
  const n = Number.parseInt(value ?? fallback, 10);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "Pagination parameters must be non-negative integers");
  return Math.min(n, max);
}

/* ---------------- app ---------------- */

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

// Static frontend + vendored browser libraries (no CDN needed)
app.use(express.static(path.join(ROOT, "frontend")));
app.get("/vendor/ethers.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/ethers/dist/ethers.min.js")));
app.get("/vendor/chart.js", (_req, res) => res.sendFile(path.join(ROOT, "node_modules/chart.js/dist/chart.umd.js")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), indexer: indexer.status });
});

app.get("/api/config", (_req, res) => {
  res.json({
    contractAddress: indexer.addresses?.shield ?? null,
    addresses: indexer.addresses ?? null,
    chainId,
    indexer: indexer.status,
  });
});

/**
 * Register the deployed GigShield address with the backend.
 * Only an on-chain Admin may do this: the request carries a wallet signature (EIP-191)
 * which is verified against RoleRegistry.roleOf(signer) == Admin.
 */
app.post("/api/config", async (req, res) => {
  const { address, timestamp, signature } = req.body ?? {};
  if (!isAddress(address)) throw new HttpError(400, "Invalid contract address");
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000)
    throw new HttpError(400, "Signature timestamp missing or expired (5 min window)");
  if (typeof signature !== "string") throw new HttpError(400, "Missing signature");

  const message = `GigShield: register contract ${ethers.getAddress(address)} at ${timestamp}`;
  let signer;
  try {
    signer = ethers.verifyMessage(message, signature);
  } catch {
    throw new HttpError(400, "Malformed signature");
  }

  let registryAddr;
  try {
    registryAddr = await new ethers.Contract(address, SHIELD_ABI, provider).registry();
  } catch {
    throw new HttpError(400, `Address is not a GigShield contract on chain ${chainId}`);
  }
  const role = await new ethers.Contract(registryAddr, REGISTRY_ABI, provider).roleOf(signer);
  if (Number(role) !== 3) throw new HttpError(403, "Only a GigShield Admin can register the contract");

  const addresses = await indexer.setContract(ethers.getAddress(address));
  setMeta("contractAddress", addresses.shield);
  res.json({ ok: true, addresses });
});

/** Event log with optional filters: ?name=ClaimFiled&actor=0x..&limit=50&offset=0 */
app.get("/api/events", (req, res) => {
  const contract = requireContract();
  const limit = intParam(req.query.limit, 50, 500);
  const offset = intParam(req.query.offset, 0, 1e9);
  const where = ["contract = ?"];
  const params = [contract];
  if (req.query.name) { where.push("name = ?"); params.push(String(req.query.name)); }
  if (req.query.source) { where.push("source = ?"); params.push(String(req.query.source)); }
  if (req.query.actor) {
    if (!isAddress(req.query.actor)) throw new HttpError(400, "Invalid actor address");
    where.push("(actor = ? OR args LIKE ?)");
    params.push(req.query.actor.toLowerCase(), `%${req.query.actor.slice(2).toLowerCase()}%`);
  }
  const sqlWhere = where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${sqlWhere}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM events WHERE ${sqlWhere} ORDER BY block_number DESC, log_index DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
    .map((r) => ({ ...r, args: JSON.parse(r.args) }));
  res.json({ total, limit, offset, items: rows });
});

/** Aggregated KPIs and chart series for the dashboard */
app.get("/api/stats", (_req, res) => {
  const contract = requireContract();
  const events = db.prepare("SELECT name, args, timestamp FROM events WHERE contract = ? ORDER BY block_number")
    .all(contract)
    .map((e) => ({ ...e, args: JSON.parse(e.args) }));

  const count = (n) => events.filter((e) => e.name === n).length;
  const sum = (n, field) => events.filter((e) => e.name === n).reduce((a, e) => a + fromWei(e.args[field]), 0);

  const daily = {};
  const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
  for (const e of events) {
    if (e.name !== "PremiumCollected" && e.name !== "PayoutSent") continue;
    const d = (daily[day(e.timestamp)] ??= { premiums: 0, payouts: 0 });
    if (e.name === "PremiumCollected") d.premiums += fromWei(e.args.amount);
    else d.payouts += fromWei(e.args.amount);
  }

  const filed = count("ClaimFiled");
  const approved = count("ClaimApproved");
  const rejected = count("ClaimRejected");
  const withdrawn = count("ClaimWithdrawn");
  const premiums = sum("PremiumCollected", "amount");
  const payouts = sum("PayoutSent", "amount");
  const claimPayouts = sum("ClaimApproved", "amount");

  // Average claim decision time (seconds) from ClaimFiled -> ClaimApproved/Rejected
  const filedAt = new Map(events.filter((e) => e.name === "ClaimFiled").map((e) => [e.args.claimId, e.timestamp]));
  const decisions = events.filter((e) => e.name === "ClaimApproved" || e.name === "ClaimRejected");
  const avgDecisionSec = decisions.length
    ? decisions.reduce((a, e) => a + (e.timestamp - (filedAt.get(e.args.claimId) ?? e.timestamp)), 0) / decisions.length
    : null;

  const gas = db.prepare(`
    SELECT action, COUNT(*) AS count,
           AVG(CAST(gas_estimate AS REAL)) AS avgEstimate,
           AVG(CAST(gas_used AS REAL)) AS avgUsed
    FROM transactions WHERE contract = ? AND status = 'success' GROUP BY action ORDER BY avgUsed DESC
  `).all(contract);

  const eventCounts = db.prepare("SELECT name, COUNT(*) AS count FROM events WHERE contract = ? GROUP BY name ORDER BY count DESC")
    .all(contract);

  res.json({
    totals: {
      products: count("ProductCreated"),
      policies: count("PolicyPurchased"),
      cancelledPolicies: count("PolicyCancelled"),
      customers: events.filter((e) => e.name === "RoleChanged" && Number(e.args.newRole) === 1).length,
      premiums,
      payouts,
      claimPayouts,
      capitalDeposited: sum("CapitalDeposited", "amount"),
      capitalWithdrawn: sum("CapitalWithdrawn", "amount"),
      poolBalance: sum("CapitalDeposited", "amount") - sum("CapitalWithdrawn", "amount") + premiums - payouts,
      lossRatio: premiums > 0 ? claimPayouts / premiums : null,
      avgDecisionSec,
      events: events.length,
    },
    claims: { filed, pending: filed - approved - rejected - withdrawn, approved, rejected, withdrawn },
    daily: Object.entries(daily).map(([date, v]) => ({ date, ...v })),
    gas,
    eventCounts,
  });
});

/** Record a dApp transaction. Gas used / status are re-read from the chain when possible. */
app.post("/api/transactions", async (req, res) => {
  const contract = requireContract();
  const { hash, action, from, gasEstimate } = req.body ?? {};
  if (!isHash(hash)) throw new HttpError(400, "Invalid transaction hash");
  if (!isAddress(from)) throw new HttpError(400, "Invalid from address");
  if (typeof action !== "string" || !/^[\w .+-]{1,60}$/.test(action)) throw new HttpError(400, "Invalid action label");

  let receipt = null;
  try { receipt = await provider.getTransactionReceipt(hash); } catch { /* RPC may lag; fall back to client data */ }
  if (receipt && receipt.from.toLowerCase() !== from.toLowerCase())
    throw new HttpError(400, "Transaction sender does not match");

  const row = {
    hash,
    contract,
    from: from.toLowerCase(),
    action,
    gasEstimate: gasEstimate != null ? String(gasEstimate) : null,
    gasUsed: receipt ? receipt.gasUsed.toString() : (req.body.gasUsed != null ? String(req.body.gasUsed) : null),
    gasPrice: receipt ? (receipt.gasPrice ?? 0n).toString() : (req.body.gasPrice != null ? String(req.body.gasPrice) : null),
    status: receipt ? (receipt.status === 1 ? "success" : "failed") : (req.body.status === "failed" ? "failed" : "success"),
  };
  db.prepare(`
    INSERT INTO transactions (hash, contract, from_address, action, gas_estimate, gas_used, gas_price, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET gas_used = excluded.gas_used, status = excluded.status
  `).run(row.hash, row.contract, row.from, row.action, row.gasEstimate, row.gasUsed, row.gasPrice, row.status, Date.now());
  res.status(201).json(row);
});

/** Transaction history: ?from=0x.. to filter by wallet */
app.get("/api/transactions", (req, res) => {
  const contract = requireContract();
  const limit = intParam(req.query.limit, 50, 500);
  const params = [contract];
  let where = "contract = ?";
  if (req.query.from) {
    if (!isAddress(req.query.from)) throw new HttpError(400, "Invalid from address");
    where += " AND from_address = ?";
    params.push(req.query.from.toLowerCase());
  }
  const items = db.prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
  res.json({ items });
});

/** Store claim evidence off-chain; returns the keccak256 hash to be put on-chain. */
app.post("/api/evidence", (req, res) => {
  const { text, submitter } = req.body ?? {};
  if (typeof text !== "string" || text.trim().length < 10 || text.length > 2000)
    throw new HttpError(400, "Evidence must be 10-2000 characters");
  if (!isAddress(submitter)) throw new HttpError(400, "Invalid submitter address");
  const hash = ethers.id(text);
  db.prepare("INSERT OR IGNORE INTO evidence (hash, text, submitter, created_at) VALUES (?, ?, ?, ?)")
    .run(hash, text, submitter.toLowerCase(), Date.now());
  res.status(201).json({ hash });
});

/** Fetch evidence and re-verify that keccak256(text) matches the on-chain hash. */
app.get("/api/evidence/:hash", (req, res) => {
  if (!isHash(req.params.hash)) throw new HttpError(400, "Invalid hash");
  const row = db.prepare("SELECT * FROM evidence WHERE hash = ?").get(req.params.hash.toLowerCase());
  if (!row) throw new HttpError(404, "No evidence stored for this hash");
  res.json({ ...row, verified: ethers.id(row.text) === row.hash });
});

/* ---------------- error handling ---------------- */

app.use("/api", (_req, _res, next) => next(new HttpError(404, "API route not found")));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === "entity.parse.failed" ? 400 : 500);
  if (status >= 500) console.error("[api]", err);
  res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

/* ---------------- boot ---------------- */

async function connectChain() {
  try {
    chainId = Number((await provider.getNetwork()).chainId);
    console.log(`[rpc] connected to chain ${chainId} via ${RPC_URL}`);
    const saved = process.env.CONTRACT_ADDRESS || getMeta("contractAddress");
    if (saved) {
      await indexer.setContract(saved);
      console.log(`[indexer] watching GigShield at ${saved}`);
    }
  } catch (err) {
    console.error("[boot] RPC / contract not reachable, retrying in 15s:", err.shortMessage || err.message);
    setTimeout(connectChain, 15_000);
  }
}

app.listen(PORT, HOST, () => console.log(`GigShield listening on http://${HOST}:${PORT}`));
connectChain();
