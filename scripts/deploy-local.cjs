// Deploy GigShield to a local Hardhat node (same as clicking Deploy in Remix)
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

async function main() {
  const [admin] = await ethers.getSigners();
  const shield = await (await ethers.getContractFactory("GigShield")).deploy();
  await shield.waitForDeployment();
  const out = {
    network: (await ethers.provider.getNetwork()).chainId.toString(),
    admin: admin.address,
    GigShield: await shield.getAddress(),
    RoleRegistry: await shield.registry(),
    GUSDToken: await shield.token(),
    RiskPool: await shield.pool(),
    deployBlock: Number(await shield.deployBlock()),
  };
  fs.mkdirSync(path.join(__dirname, "..", "data"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "data", "local-deployment.json"), JSON.stringify(out, null, 2));
  console.table(out);
}

main().catch((e) => { console.error(e); process.exit(1); });
