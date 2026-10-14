// Fill a local deployment with realistic demo data (admin = account #0, auditor = #1, customers = #2, #3)
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const API = process.env.API_URL || "http://localhost:4000";
const gUSD = (n) => ethers.parseEther(String(n));

async function evidence(text, submitter) {
  try {
    await fetch(`${API}/api/evidence`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, submitter }) });
  } catch { console.warn("backend not reachable - evidence text not stored"); }
  return ethers.id(text);
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "local-deployment.json")));
  const [admin, auditor, alice, bob] = await ethers.getSigners();
  const shield = await ethers.getContractAt("GigShield", dep.GigShield);
  const registry = await ethers.getContractAt("RoleRegistry", dep.RoleRegistry);
  const token = await ethers.getContractAt("GUSDToken", dep.GUSDToken);
  const pool = dep.RiskPool;
  const rp = await ethers.getContractAt("RiskPool", pool);

  // Send a tx like the dApp does: estimate gas, send, then record it in the backend
  async function tx(label, contract, method, args, signer = admin) {
    const c = contract.connect(signer);
    const gasEstimate = await c[method].estimateGas(...args);
    const rc = await (await c[method](...args)).wait();
    await fetch(`${API}/api/transactions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: rc.hash, action: label, from: signer.address, gasEstimate: gasEstimate.toString() }),
    }).catch(() => {});
  }

  await tx("Grant role", registry, "grantRole", [auditor.address, 2]);
  await tx("Faucet", token, "faucet", []);
  await tx("Approve gUSD", token, "approve", [pool, gUSD(800)]);
  await tx("Deposit capital", rp, "deposit", [gUSD(800)]);
  await tx("Create product", shield, "createProduct", ["Rider Accident Cover", gUSD(10), gUSD(500), 30]);
  await tx("Create product", shield, "createProduct", ["Phone & E-bike Damage", gUSD(5), gUSD(200), 14]);
  await tx("Create product", shield, "createProduct", ["Income Protection (sick days)", gUSD(15), gUSD(600), 30]);

  for (const u of [alice, bob]) {
    await tx("Register as Customer", registry, "registerAsCustomer", [], u);
    await tx("Faucet", token, "faucet", [], u);
    await tx("Approve gUSD", token, "approve", [pool, gUSD(100)], u);
  }
  await tx("Buy policy", shield, "buyPolicy", [0], alice);
  await tx("Buy policy", shield, "buyPolicy", [1], alice);
  await tx("Buy policy", shield, "buyPolicy", [0], bob);
  await tx("Buy policy", shield, "buyPolicy", [2], bob);

  const e1 = await evidence("12 Oct 2026: slipped on wet road during a GrabFood delivery in Jurong. Clinic receipt #A123, SGD 120, 2 days MC.", alice.address);
  await tx("File claim", shield, "fileClaim", [0, gUSD(120), e1], alice);
  await tx("Approve claim", shield, "approveClaim", [0, "Clinic receipt verified"], auditor);

  const e2 = await evidence("Phone screen cracked when the e-bike fell at a pickup point. Repair quote SGD 85 from MobileFix.", bob.address);
  await tx("File claim", shield, "fileClaim", [2, gUSD(400), e2], bob);
  await tx("Reject claim", shield, "rejectClaim", [1, "Wrong policy: phone damage is not covered by Accident Cover"], auditor);

  const e3 = await evidence("Phone screen cracked when the e-bike fell at a pickup point in Tampines. Repair quote SGD 85 from MobileFix.", alice.address);
  await tx("File claim", shield, "fileClaim", [1, gUSD(85), e3], alice); // left pending for the live demo

  console.log("Seeded: 3 products, 4 policies, 3 claims (1 paid, 1 rejected, 1 pending)");
}

main().catch((e) => { console.error(e); process.exit(1); });
