const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const Role = { None: 0, Customer: 1, Auditor: 2, Admin: 3 };
const ClaimStatus = { Pending: 0, Paid: 1, Rejected: 2, Withdrawn: 3 };
const gUSD = (n) => ethers.parseEther(String(n));
const EVIDENCE = ethers.id("Motorbike accident on 12 Oct, clinic receipt #A123");

async function deployFixture() {
  const [admin, auditor, alice, bob, outsider] = await ethers.getSigners();
  const shield = await (await ethers.getContractFactory("GigShield")).deploy();
  const registry = await ethers.getContractAt("RoleRegistry", await shield.registry());
  const token = await ethers.getContractAt("GUSDToken", await shield.token());
  const pool = await ethers.getContractAt("RiskPool", await shield.pool());
  return { shield, registry, token, pool, admin, auditor, alice, bob, outsider };
}

/** Admin funds pool, creates a product; auditor + alice onboarded; alice buys policy #0. */
async function activePolicyFixture() {
  const ctx = await deployFixture();
  const { shield, registry, token, pool, admin, auditor, alice } = ctx;
  await registry.grantRole(auditor.address, Role.Auditor);
  await token.faucet();
  await token.approve(await pool.getAddress(), ethers.MaxUint256);
  await pool.deposit(gUSD(800));
  await shield.createProduct("Rider Accident Cover", gUSD(10), gUSD(500), 30);

  await registry.connect(alice).registerAsCustomer();
  await token.connect(alice).faucet();
  await token.connect(alice).approve(await pool.getAddress(), ethers.MaxUint256);
  await shield.connect(alice).buyPolicy(0);
  return ctx;
}

describe("Deployment (single-click from Remix)", () => {
  it("deploys and wires all four contracts", async () => {
    const { shield, registry, pool, token, admin } = await loadFixture(deployFixture);
    expect(await registry.roleOf(admin.address)).to.equal(Role.Admin);
    expect(await registry.adminCount()).to.equal(1);
    expect(await pool.manager()).to.equal(await shield.getAddress());
    expect(await pool.token()).to.equal(await token.getAddress());
    expect(await shield.deployBlock()).to.be.gt(0);
  });
});

describe("RoleRegistry", () => {
  it("lets wallets self-register as Customer exactly once", async () => {
    const { registry, alice } = await loadFixture(deployFixture);
    await expect(registry.connect(alice).registerAsCustomer())
      .to.emit(registry, "RoleChanged").withArgs(alice.address, Role.None, Role.Customer, alice.address);
    await expect(registry.connect(alice).registerAsCustomer()).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
  });

  it("only Admin can grant / revoke roles", async () => {
    const { registry, auditor, alice } = await loadFixture(deployFixture);
    await expect(registry.connect(alice).grantRole(alice.address, Role.Admin)).to.be.revertedWithCustomError(registry, "NotAuthorized");
    await registry.grantRole(auditor.address, Role.Auditor);
    expect(await registry.hasRole(auditor.address, Role.Auditor)).to.equal(true);
    await registry.revokeRole(auditor.address);
    expect(await registry.roleOf(auditor.address)).to.equal(Role.None);
    await expect(registry.revokeRole(auditor.address)).to.be.revertedWithCustomError(registry, "InvalidInput");
    await expect(registry.grantRole(ethers.ZeroAddress, Role.Auditor)).to.be.revertedWithCustomError(registry, "InvalidInput");
  });

  it("never removes the last Admin", async () => {
    const { registry, admin, bob } = await loadFixture(deployFixture);
    await expect(registry.revokeRole(admin.address)).to.be.revertedWithCustomError(registry, "LastAdminCannotBeRemoved");
    await registry.grantRole(bob.address, Role.Admin);
    expect(await registry.adminCount()).to.equal(2);
    await registry.connect(bob).revokeRole(admin.address);
    expect(await registry.adminCount()).to.equal(1);
  });
});

describe("GUSDToken", () => {
  it("faucet mints 1,000 gUSD with a 10-minute cooldown", async () => {
    const { token, alice } = await loadFixture(deployFixture);
    await token.connect(alice).faucet();
    expect(await token.balanceOf(alice.address)).to.equal(gUSD(1000));
    await expect(token.connect(alice).faucet()).to.be.revertedWithCustomError(token, "FaucetCooldown");
    await time.increase(600);
    await token.connect(alice).faucet();
    expect(await token.totalSupply()).to.equal(gUSD(2000));
  });

  it("enforces balances and allowances", async () => {
    const { token, alice, bob } = await loadFixture(deployFixture);
    await token.connect(alice).faucet();
    await expect(token.connect(bob).transfer(alice.address, 1)).to.be.revertedWithCustomError(token, "InsufficientBalance");
    await expect(token.connect(bob).transferFrom(alice.address, bob.address, 1)).to.be.revertedWithCustomError(token, "InsufficientAllowance");
    await token.connect(alice).approve(bob.address, gUSD(5));
    await token.connect(bob).transferFrom(alice.address, bob.address, gUSD(5));
    expect(await token.allowance(alice.address, bob.address)).to.equal(0);
    await expect(token.connect(alice).transfer(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(token, "InvalidInput");
  });
});

describe("RiskPool", () => {
  it("only Admin deposits / withdraws; only GigShield moves premiums & payouts", async () => {
    const { pool, token, alice, admin } = await loadFixture(deployFixture);
    await token.connect(alice).faucet();
    await token.connect(alice).approve(await pool.getAddress(), gUSD(100));
    await expect(pool.connect(alice).deposit(gUSD(100))).to.be.revertedWithCustomError(pool, "NotAuthorized");
    await expect(pool.connect(admin).payout(admin.address, 1)).to.be.revertedWithCustomError(pool, "NotAuthorized");
    await expect(pool.connect(admin).collectPremium(alice.address, 1)).to.be.revertedWithCustomError(pool, "NotAuthorized");
  });

  it("cannot withdraw capital reserved for pending claims", async () => {
    const { shield, pool, alice } = await loadFixture(activePolicyFixture);
    await shield.connect(alice).fileClaim(0, gUSD(300), EVIDENCE);
    // pool = 800 capital + 10 premium = 810, reserved 300 -> free 510
    expect(await pool.freeCapital()).to.equal(gUSD(510));
    await expect(pool.withdraw(gUSD(511))).to.be.revertedWithCustomError(pool, "InsufficientFreeCapital").withArgs(gUSD(510));
    await expect(pool.withdraw(gUSD(510))).to.emit(pool, "CapitalWithdrawn");
  });
});

describe("GigShield — products & policies", () => {
  it("validates product parameters and admin-only access", async () => {
    const { shield, alice } = await loadFixture(deployFixture);
    await expect(shield.connect(alice).createProduct("X", 1, 2, 1)).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await expect(shield.createProduct("", 1, 2, 1)).to.be.revertedWithCustomError(shield, "InvalidInput");
    await expect(shield.createProduct("X", 5, 5, 1)).to.be.revertedWithCustomError(shield, "InvalidInput");
    await expect(shield.createProduct("X", 1, 5, 0)).to.be.revertedWithCustomError(shield, "InvalidInput");
  });

  it("customer buys a policy; premium moves into the pool", async () => {
    const { shield, pool, token, alice } = await loadFixture(activePolicyFixture);
    const pol = await shield.getPolicy(0);
    expect(pol.holder).to.equal(alice.address);
    expect(pol.remainingCoverage).to.equal(gUSD(500));
    expect(await token.balanceOf(alice.address)).to.equal(gUSD(990));
    expect(await pool.totalPremiums()).to.equal(gUSD(10));
    expect(await shield.isPolicyActive(0)).to.equal(true);
  });

  it("blocks non-customers, inactive products and paused contract", async () => {
    const { shield, registry, token, pool, bob, auditor } = await loadFixture(activePolicyFixture);
    await expect(shield.connect(bob).buyPolicy(0)).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await expect(shield.connect(auditor).buyPolicy(0)).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await registry.connect(bob).registerAsCustomer();
    await token.connect(bob).faucet();
    await token.connect(bob).approve(await pool.getAddress(), ethers.MaxUint256);
    await expect(shield.connect(bob).buyPolicy(9)).to.be.revertedWithCustomError(shield, "InvalidInput");

    await expect(shield.setProductActive(0, false)).to.emit(shield, "ProductStatusChanged").withArgs(0, false);
    await expect(shield.connect(bob).buyPolicy(0)).to.be.revertedWithCustomError(shield, "ProductInactive");
    await shield.setProductActive(0, true);

    await shield.setPaused(true);
    await expect(shield.connect(bob).buyPolicy(0)).to.be.revertedWithCustomError(shield, "ContractPaused");
    await shield.setPaused(false);
    await expect(shield.connect(bob).buyPolicy(0)).to.emit(shield, "PolicyPurchased");
  });

  it("reverts when customer has no allowance for the pool", async () => {
    const { shield, registry, token, bob } = await loadFixture(activePolicyFixture);
    await registry.connect(bob).registerAsCustomer();
    await token.connect(bob).faucet();
    await expect(shield.connect(bob).buyPolicy(0)).to.be.revertedWithCustomError(token, "InsufficientAllowance");
  });

  it("cancel refunds premium pro-rata when no claim was paid", async () => {
    const { shield, token, alice } = await loadFixture(activePolicyFixture);
    await time.increase(15 * 24 * 3600); // half of 30 days
    const before = await token.balanceOf(alice.address);
    await expect(shield.connect(alice).cancelPolicy(0)).to.emit(shield, "PolicyCancelled");
    const refund = (await token.balanceOf(alice.address)) - before;
    expect(refund).to.be.closeTo(gUSD(5), gUSD("0.01"));
    expect(await shield.isPolicyActive(0)).to.equal(false);
    await expect(shield.connect(alice).cancelPolicy(0)).to.be.revertedWithCustomError(shield, "PolicyNotActive");
  });

  it("cancel gives no refund after a paid claim; only the holder can cancel", async () => {
    const { shield, token, alice, auditor, bob } = await loadFixture(activePolicyFixture);
    await shield.connect(alice).fileClaim(0, gUSD(50), EVIDENCE);
    await shield.connect(auditor).approveClaim(0, "ok");
    await expect(shield.connect(bob).cancelPolicy(0)).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await expect(shield.connect(alice).cancelPolicy(0)).to.emit(shield, "PolicyCancelled").withArgs(0, alice.address, 0);
  });
});

describe("GigShield — claims workflow", () => {
  it("file -> approve pays claimant from the pool and reduces coverage", async () => {
    const { shield, token, pool, alice, auditor } = await loadFixture(activePolicyFixture);
    await expect(shield.connect(alice).fileClaim(0, gUSD(200), EVIDENCE))
      .to.emit(shield, "ClaimFiled").withArgs(0, 0, alice.address, gUSD(200), EVIDENCE);
    expect(await shield.pendingClaimsTotal()).to.equal(gUSD(200));

    await expect(shield.connect(auditor).approveClaim(0, "Receipt verified"))
      .to.emit(shield, "ClaimApproved").withArgs(0, auditor.address, gUSD(200), "Receipt verified")
      .and.to.emit(pool, "PayoutSent").withArgs(alice.address, gUSD(200));

    const c = await shield.getClaim(0);
    expect(c.status).to.equal(ClaimStatus.Paid);
    expect(c.assessor).to.equal(auditor.address);
    expect((await shield.getPolicy(0)).remainingCoverage).to.equal(gUSD(300));
    expect(await token.balanceOf(alice.address)).to.equal(gUSD(1190));
    expect(await shield.pendingClaimsTotal()).to.equal(0);
  });

  it("reject requires a reason and releases the reservation", async () => {
    const { shield, alice, auditor } = await loadFixture(activePolicyFixture);
    await shield.connect(alice).fileClaim(0, gUSD(100), EVIDENCE);
    await expect(shield.connect(auditor).rejectClaim(0, "")).to.be.revertedWithCustomError(shield, "InvalidInput");
    await expect(shield.connect(auditor).rejectClaim(0, "Receipt unreadable")).to.emit(shield, "ClaimRejected");
    expect((await shield.getClaim(0)).status).to.equal(ClaimStatus.Rejected);
    expect(await shield.pendingClaimsTotal()).to.equal(0);
    await expect(shield.connect(auditor).approveClaim(0, "")).to.be.revertedWithCustomError(shield, "ClaimNotPending");
  });

  it("claimant can withdraw a pending claim", async () => {
    const { shield, alice, bob } = await loadFixture(activePolicyFixture);
    await shield.connect(alice).fileClaim(0, gUSD(100), EVIDENCE);
    await expect(shield.connect(bob).withdrawClaim(0)).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await expect(shield.connect(alice).withdrawClaim(0)).to.emit(shield, "ClaimWithdrawn").withArgs(0, alice.address);
    expect((await shield.getClaim(0)).status).to.equal(ClaimStatus.Withdrawn);
  });

  it("enforces coverage limit, one open claim, evidence hash and expiry", async () => {
    const { shield, alice } = await loadFixture(activePolicyFixture);
    await expect(shield.connect(alice).fileClaim(0, gUSD(501), EVIDENCE))
      .to.be.revertedWithCustomError(shield, "ClaimExceedsCoverage").withArgs(gUSD(500));
    await expect(shield.connect(alice).fileClaim(0, gUSD(1), ethers.ZeroHash)).to.be.revertedWithCustomError(shield, "InvalidInput");
    await expect(shield.connect(alice).fileClaim(0, 0, EVIDENCE)).to.be.revertedWithCustomError(shield, "InvalidInput");
    await shield.connect(alice).fileClaim(0, gUSD(10), EVIDENCE);
    await expect(shield.connect(alice).fileClaim(0, gUSD(10), EVIDENCE)).to.be.revertedWithCustomError(shield, "OpenClaimExists");
    await expect(shield.connect(alice).cancelPolicy(0)).to.be.revertedWithCustomError(shield, "OpenClaimExists");
    await shield.connect(alice).withdrawClaim(0);

    await time.increase(31 * 24 * 3600);
    await expect(shield.connect(alice).fileClaim(0, gUSD(10), EVIDENCE)).to.be.revertedWithCustomError(shield, "PolicyNotActive");
  });

  it("only Auditors decide claims; revoked customers cannot file", async () => {
    const { shield, registry, alice, admin, bob } = await loadFixture(activePolicyFixture);
    await shield.connect(alice).fileClaim(0, gUSD(10), EVIDENCE);
    await expect(shield.connect(admin).approveClaim(0, "")).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await expect(shield.connect(alice).approveClaim(0, "")).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await expect(shield.connect(bob).rejectClaim(0, "x")).to.be.revertedWithCustomError(shield, "NotAuthorized");
    await shield.connect(alice).withdrawClaim(0);

    await registry.revokeRole(alice.address); // e.g. fraud detected
    await expect(shield.connect(alice).fileClaim(0, gUSD(10), EVIDENCE)).to.be.revertedWithCustomError(shield, "NotAuthorized");
  });

  it("payout fails safely when the pool is insolvent", async () => {
    const { shield, pool, alice, auditor } = await loadFixture(activePolicyFixture);
    await pool.withdraw(gUSD(700)); // pool keeps 110
    await shield.connect(alice).fileClaim(0, gUSD(300), EVIDENCE);
    await expect(shield.connect(auditor).approveClaim(0, "ok")).to.be.revertedWithCustomError(pool, "InsufficientBalance");
    expect((await shield.getClaim(0)).status).to.equal(ClaimStatus.Pending); // state rolled back
  });

  it("returns full lists for the dashboard", async () => {
    const { shield, alice } = await loadFixture(activePolicyFixture);
    await shield.connect(alice).fileClaim(0, gUSD(10), EVIDENCE);
    expect((await shield.getAllProducts()).length).to.equal(1);
    expect((await shield.getAllPolicies()).length).to.equal(1);
    expect((await shield.getAllClaims()).length).to.equal(1);
    expect(await shield.productCount()).to.equal(1);
    expect(await shield.policyCount()).to.equal(1);
    expect(await shield.claimCount()).to.equal(1);
  });
});
