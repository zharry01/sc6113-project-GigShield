// Polls the chain for events of the four GigShield contracts and stores them in SQLite.
import { ethers } from "ethers";
import { db, getMeta, setMeta } from "./db.js";
import { SHIELD_ABI, REGISTRY_ABI, TOKEN_ABI, POOL_ABI } from "../frontend/abi.js";

const POLL_MS = Number(process.env.POLL_MS || 8000);
const CHUNK = Number(process.env.LOG_CHUNK || 2000);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (contract, source, name, args, actor, block_number, tx_hash, log_index, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function toJson(result, fragment) {
  const out = {};
  fragment.inputs.forEach((input, i) => {
    const v = result[i];
    out[input.name] = typeof v === "bigint" ? v.toString() : v;
  });
  return out;
}

// The "main" wallet an event is about, used to filter "my activity"
function actorOf(name, args) {
  return (args.holder || args.claimant || args.assessor || args.admin || args.account ||
          args.payer || args.to || args.by || args.from || null)?.toLowerCase() ?? null;
}

export class Indexer {
  constructor(provider) {
    this.provider = provider;
    this.contract = null;
    this.timer = null;
    this.status = { running: false, lastBlock: null, lastError: null, lastRunAt: null };
  }

  /** Point the indexer at a (new) GigShield deployment. */
  async setContract(address) {
    const shield = new ethers.Contract(address, SHIELD_ABI, this.provider);
    const [registry, token, pool, deployBlock] = await Promise.all([
      shield.registry(), shield.token(), shield.pool(), shield.deployBlock(),
    ]);
    this.contract = address.toLowerCase();
    this.sources = new Map([
      [address.toLowerCase(), { name: "GigShield", iface: new ethers.Interface(SHIELD_ABI) }],
      [registry.toLowerCase(), { name: "RoleRegistry", iface: new ethers.Interface(REGISTRY_ABI) }],
      [token.toLowerCase(), { name: "GUSDToken", iface: new ethers.Interface(TOKEN_ABI) }],
      [pool.toLowerCase(), { name: "RiskPool", iface: new ethers.Interface(POOL_ABI) }],
    ]);
    this.addresses = { shield: address, registry, token, pool, deployBlock: Number(deployBlock) };
    this.metaKey = `lastBlock:${this.contract}`;
    if (getMeta(this.metaKey) === null) setMeta(this.metaKey, Number(deployBlock) - 1);
    this.start();
    return this.addresses;
  }

  start() {
    if (this.timer) clearTimeout(this.timer);
    this.status.running = true;
    const loop = async () => {
      try {
        await this.syncOnce();
        this.status.lastError = null;
      } catch (err) {
        this.status.lastError = err.shortMessage || err.message;
        console.error("[indexer]", this.status.lastError);
      }
      this.status.lastRunAt = Date.now();
      this.timer = setTimeout(loop, POLL_MS);
    };
    loop();
  }

  async syncOnce() {
    if (!this.contract) return;
    const head = await this.provider.getBlockNumber();
    let from = Number(getMeta(this.metaKey)) + 1;
    if (from > head + 1) {
      // Chain was reset (e.g. local Hardhat node restarted): drop stale data and re-index
      db.prepare("DELETE FROM events WHERE contract = ?").run(this.contract);
      db.prepare("DELETE FROM transactions WHERE contract = ?").run(this.contract);
      from = this.addresses.deployBlock;
      setMeta(this.metaKey, from - 1);
    }
    const blockTimes = new Map();

    while (from <= head) {
      const to = Math.min(from + CHUNK - 1, head);
      const logs = await this.provider.getLogs({ address: [...this.sources.keys()], fromBlock: from, toBlock: to });
      for (const log of logs) {
        const src = this.sources.get(log.address.toLowerCase());
        const parsed = src?.iface.parseLog(log);
        if (!parsed) continue;
        if (!blockTimes.has(log.blockNumber)) {
          const block = await this.provider.getBlock(log.blockNumber);
          blockTimes.set(log.blockNumber, block.timestamp);
        }
        const args = toJson(parsed.args, parsed.fragment);
        insertEvent.run(this.contract, src.name, parsed.name, JSON.stringify(args), actorOf(parsed.name, args),
          log.blockNumber, log.transactionHash, log.index, blockTimes.get(log.blockNumber));
      }
      setMeta(this.metaKey, to);
      this.status.lastBlock = to;
      from = to + 1;
    }
    this.status.lastBlock = head;
  }
}
