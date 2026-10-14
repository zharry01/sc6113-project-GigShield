// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/*
 * GigShield — on-chain micro-insurance for gig / platform workers
 * ----------------------------------------------------------------
 * Single-file deployment for Remix: compile this file, select "GigShield"
 * and click Deploy (no constructor arguments). The GigShield constructor
 * deploys and wires the other three contracts automatically:
 *
 *   RoleRegistry  - role-based access control (Admin / Auditor / Customer)
 *   GUSDToken     - test stablecoin "gUSD" (ERC-20 + faucet) used for premiums & payouts
 *   RiskPool      - holds capital + premiums, pays out approved claims & refunds
 *   GigShield     - product catalogue, policies and the claim workflow
 *
 * The deployer becomes the first Admin.
 */

enum Role { None, Customer, Auditor, Admin }

error NotAuthorized();
error InvalidInput();
error AlreadyRegistered();
error LastAdminCannotBeRemoved();
error InsufficientBalance();
error InsufficientAllowance();
error FaucetCooldown(uint256 availableAt);
error InsufficientFreeCapital(uint256 available);
error ProductInactive();
error PolicyNotActive();
error ClaimExceedsCoverage(uint256 remaining);
error OpenClaimExists();
error ClaimNotPending();
error SelfAssessment();
error ContractPaused();
error Reentrancy();

/* ============================================================
 * 1. RoleRegistry — one role per address (separation of duties)
 * ============================================================ */
contract RoleRegistry {
    mapping(address => Role) public roleOf;
    uint256 public adminCount;

    event RoleChanged(address indexed account, Role oldRole, Role newRole, address indexed changedBy);

    modifier onlyAdmin() {
        if (roleOf[msg.sender] != Role.Admin) revert NotAuthorized();
        _;
    }

    constructor(address firstAdmin) {
        _setRole(firstAdmin, Role.Admin, firstAdmin);
    }

    /// @notice Any new wallet can self-onboard as a Customer (policyholder).
    function registerAsCustomer() external {
        if (roleOf[msg.sender] != Role.None) revert AlreadyRegistered();
        _setRole(msg.sender, Role.Customer, msg.sender);
    }

    /// @notice Admin assigns any role (e.g. promote a wallet to Auditor).
    function grantRole(address account, Role role) external onlyAdmin {
        if (account == address(0) || role == Role.None) revert InvalidInput();
        _setRole(account, role, msg.sender);
    }

    /// @notice Admin removes a wallet's role (e.g. block a fraudulent customer).
    function revokeRole(address account) external onlyAdmin {
        if (roleOf[account] == Role.None) revert InvalidInput();
        _setRole(account, Role.None, msg.sender);
    }

    function hasRole(address account, Role role) external view returns (bool) {
        return roleOf[account] == role;
    }

    function _setRole(address account, Role newRole, address by) private {
        Role old = roleOf[account];
        if (old == Role.Admin) {
            if (newRole != Role.Admin && adminCount == 1) revert LastAdminCannotBeRemoved();
            adminCount--;
        }
        if (newRole == Role.Admin) adminCount++;
        roleOf[account] = newRole;
        emit RoleChanged(account, old, newRole, by);
    }
}

/* ============================================================
 * 2. GUSDToken — minimal ERC-20 test stablecoin with a faucet
 * ============================================================ */
contract GUSDToken {
    string public constant name = "GigShield USD";
    string public constant symbol = "gUSD";
    uint8 public constant decimals = 18;
    uint256 public constant FAUCET_AMOUNT = 1000 ether; // 1,000 gUSD
    uint256 public constant FAUCET_COOLDOWN = 10 minutes;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lastFaucetAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Testnet only: mint 1,000 gUSD to the caller (10-minute cooldown).
    function faucet() external {
        uint256 next = lastFaucetAt[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucetAt[msg.sender] != 0 && block.timestamp < next) revert FaucetCooldown(next);
        lastFaucetAt[msg.sender] = block.timestamp;
        totalSupply += FAUCET_AMOUNT;
        unchecked { balanceOf[msg.sender] += FAUCET_AMOUNT; }
        emit Transfer(address(0), msg.sender, FAUCET_AMOUNT);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert InvalidInput();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}

/* ============================================================
 * 3. RiskPool — custody of capital & premiums, pays claims
 * ============================================================ */
interface IClaimLiability {
    function pendingClaimsTotal() external view returns (uint256);
}

contract RiskPool {
    RoleRegistry public immutable registry;
    GUSDToken public immutable token;
    address public immutable manager; // the GigShield contract

    uint256 public totalCapitalDeposited;
    uint256 public totalCapitalWithdrawn;
    uint256 public totalPremiums;
    uint256 public totalPayouts;
    uint256 private _locked = 1;

    event CapitalDeposited(address indexed admin, uint256 amount);
    event CapitalWithdrawn(address indexed admin, uint256 amount);
    event PremiumCollected(address indexed payer, uint256 amount);
    event PayoutSent(address indexed to, uint256 amount);

    modifier onlyAdmin() {
        if (registry.roleOf(msg.sender) != Role.Admin) revert NotAuthorized();
        _;
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert NotAuthorized();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(RoleRegistry _registry, GUSDToken _token, address _manager) {
        registry = _registry;
        token = _token;
        manager = _manager;
    }

    function balance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Capital that is not reserved for pending claims.
    function freeCapital() public view returns (uint256) {
        uint256 bal = balance();
        uint256 reserved = IClaimLiability(manager).pendingClaimsTotal();
        return bal > reserved ? bal - reserved : 0;
    }

    /// @notice Admin adds underwriting capital (requires gUSD approve to this pool).
    function deposit(uint256 amount) external onlyAdmin nonReentrant {
        if (amount == 0) revert InvalidInput();
        totalCapitalDeposited += amount;
        token.transferFrom(msg.sender, address(this), amount);
        emit CapitalDeposited(msg.sender, amount);
    }

    /// @notice Admin withdraws capital, but never funds reserved for pending claims.
    function withdraw(uint256 amount) external onlyAdmin nonReentrant {
        uint256 free = freeCapital();
        if (amount == 0) revert InvalidInput();
        if (amount > free) revert InsufficientFreeCapital(free);
        totalCapitalWithdrawn += amount;
        token.transfer(msg.sender, amount);
        emit CapitalWithdrawn(msg.sender, amount);
    }

    function collectPremium(address payer, uint256 amount) external onlyManager nonReentrant {
        totalPremiums += amount;
        token.transferFrom(payer, address(this), amount);
        emit PremiumCollected(payer, amount);
    }

    function payout(address to, uint256 amount) external onlyManager nonReentrant {
        if (balance() < amount) revert InsufficientBalance();
        totalPayouts += amount;
        token.transfer(to, amount);
        emit PayoutSent(to, amount);
    }
}

/* ============================================================
 * 4. GigShield — products, policies and claims (deploy this one)
 * ============================================================ */
contract GigShield is IClaimLiability {
    enum PolicyStatus { Active, Cancelled }
    enum ClaimStatus { Pending, Paid, Rejected, Withdrawn }

    struct Product {
        string name;
        uint128 premium;      // gUSD (18 decimals)
        uint128 coverage;     // max total payout per policy
        uint32 durationDays;
        bool active;
    }

    struct Policy {
        uint64 productId;
        uint64 startAt;
        uint64 expiresAt;
        bool hasOpenClaim;
        PolicyStatus status;
        address holder;
        uint128 premiumPaid;
        uint128 remainingCoverage;
    }

    struct Claim {
        uint64 policyId;
        uint64 filedAt;
        uint64 decidedAt;
        ClaimStatus status;
        address claimant;
        uint128 amount;
        address assessor;
        bytes32 evidenceHash; // keccak256 of the off-chain evidence stored by the backend
        string decisionNote;
    }

    RoleRegistry public immutable registry;
    GUSDToken public immutable token;
    RiskPool public immutable pool;
    uint256 public immutable deployBlock;

    Product[] private _products;
    Policy[] private _policies;
    Claim[] private _claims;

    uint256 public pendingClaimsTotal;
    bool public paused;
    uint256 private _locked = 1;

    event ProductCreated(uint256 indexed productId, string name, uint256 premium, uint256 coverage, uint32 durationDays);
    event ProductStatusChanged(uint256 indexed productId, bool active);
    event PolicyPurchased(uint256 indexed policyId, address indexed holder, uint256 indexed productId, uint256 premium, uint256 expiresAt);
    event PolicyCancelled(uint256 indexed policyId, address indexed holder, uint256 refund);
    event ClaimFiled(uint256 indexed claimId, uint256 indexed policyId, address indexed claimant, uint256 amount, bytes32 evidenceHash);
    event ClaimApproved(uint256 indexed claimId, address indexed assessor, uint256 amount, string note);
    event ClaimRejected(uint256 indexed claimId, address indexed assessor, string note);
    event ClaimWithdrawn(uint256 indexed claimId, address indexed claimant);
    event PausedStateChanged(bool paused, address indexed by);

    modifier onlyRole(Role role) {
        if (registry.roleOf(msg.sender) != role) revert NotAuthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor() {
        registry = new RoleRegistry(msg.sender);
        token = new GUSDToken();
        pool = new RiskPool(registry, token, address(this));
        deployBlock = block.number;
    }

    /* ---------------- Admin ---------------- */

    function createProduct(string calldata name, uint128 premium, uint128 coverage, uint32 durationDays)
        external
        onlyRole(Role.Admin)
    {
        if (bytes(name).length == 0 || premium == 0 || coverage <= premium || durationDays == 0) revert InvalidInput();
        _products.push(Product(name, premium, coverage, durationDays, true));
        emit ProductCreated(_products.length - 1, name, premium, coverage, durationDays);
    }

    function setProductActive(uint256 productId, bool active) external onlyRole(Role.Admin) {
        if (productId >= _products.length) revert InvalidInput();
        _products[productId].active = active;
        emit ProductStatusChanged(productId, active);
    }

    function setPaused(bool value) external onlyRole(Role.Admin) {
        paused = value;
        emit PausedStateChanged(value, msg.sender);
    }

    /* ---------------- Customer ---------------- */

    /// @notice Buy a policy. Requires gUSD approve(RiskPool, premium) first.
    function buyPolicy(uint256 productId) external onlyRole(Role.Customer) whenNotPaused nonReentrant {
        if (productId >= _products.length) revert InvalidInput();
        Product storage p = _products[productId];
        if (!p.active) revert ProductInactive();

        uint64 expiresAt = uint64(block.timestamp + uint256(p.durationDays) * 1 days);
        _policies.push(Policy({
            productId: uint64(productId),
            startAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            hasOpenClaim: false,
            status: PolicyStatus.Active,
            holder: msg.sender,
            premiumPaid: p.premium,
            remainingCoverage: p.coverage
        }));
        uint256 policyId = _policies.length - 1;

        pool.collectPremium(msg.sender, p.premium); // interaction last
        emit PolicyPurchased(policyId, msg.sender, productId, p.premium, expiresAt);
    }

    /// @notice Cancel an active policy. Pro-rata premium refund if no claim was ever paid.
    function cancelPolicy(uint256 policyId) external nonReentrant {
        Policy storage pol = _activePolicyOf(policyId, msg.sender);
        if (pol.hasOpenClaim) revert OpenClaimExists();

        pol.status = PolicyStatus.Cancelled;
        uint256 refund;
        if (pol.remainingCoverage == _products[pol.productId].coverage) {
            refund = uint256(pol.premiumPaid) * (pol.expiresAt - block.timestamp) / (pol.expiresAt - pol.startAt);
        }
        if (refund > 0) pool.payout(msg.sender, refund);
        emit PolicyCancelled(policyId, msg.sender, refund);
    }

    /// @notice File a claim against an active policy. `evidenceHash` = keccak256 of the evidence text.
    function fileClaim(uint256 policyId, uint128 amount, bytes32 evidenceHash)
        external
        onlyRole(Role.Customer)
        whenNotPaused
    {
        Policy storage pol = _activePolicyOf(policyId, msg.sender);
        if (pol.hasOpenClaim) revert OpenClaimExists();
        if (amount == 0 || evidenceHash == bytes32(0)) revert InvalidInput();
        if (amount > pol.remainingCoverage) revert ClaimExceedsCoverage(pol.remainingCoverage);

        pol.hasOpenClaim = true;
        pendingClaimsTotal += amount;
        _claims.push(Claim({
            policyId: uint64(policyId),
            filedAt: uint64(block.timestamp),
            decidedAt: 0,
            status: ClaimStatus.Pending,
            claimant: msg.sender,
            amount: amount,
            assessor: address(0),
            evidenceHash: evidenceHash,
            decisionNote: ""
        }));
        emit ClaimFiled(_claims.length - 1, policyId, msg.sender, amount, evidenceHash);
    }

    function withdrawClaim(uint256 claimId) external {
        Claim storage c = _pendingClaim(claimId);
        if (c.claimant != msg.sender) revert NotAuthorized();
        _closeClaim(c, ClaimStatus.Withdrawn, "");
        emit ClaimWithdrawn(claimId, msg.sender);
    }

    /* ---------------- Auditor ---------------- */

    /// @notice Approve a pending claim; payout is sent from the RiskPool immediately.
    function approveClaim(uint256 claimId, string calldata note)
        external
        onlyRole(Role.Auditor)
        whenNotPaused
        nonReentrant
    {
        Claim storage c = _pendingClaim(claimId);
        if (c.claimant == msg.sender) revert SelfAssessment();
        _policies[c.policyId].remainingCoverage -= c.amount;
        _closeClaim(c, ClaimStatus.Paid, note);
        pool.payout(c.claimant, c.amount);
        emit ClaimApproved(claimId, msg.sender, c.amount, note);
    }

    function rejectClaim(uint256 claimId, string calldata note) external onlyRole(Role.Auditor) {
        Claim storage c = _pendingClaim(claimId);
        if (c.claimant == msg.sender) revert SelfAssessment();
        if (bytes(note).length == 0) revert InvalidInput(); // a reason is mandatory
        _closeClaim(c, ClaimStatus.Rejected, note);
        emit ClaimRejected(claimId, msg.sender, note);
    }

    /* ---------------- Views ---------------- */

    function productCount() external view returns (uint256) { return _products.length; }
    function policyCount() external view returns (uint256) { return _policies.length; }
    function claimCount() external view returns (uint256) { return _claims.length; }

    function getProduct(uint256 id) external view returns (Product memory) { return _products[id]; }
    function getPolicy(uint256 id) external view returns (Policy memory) { return _policies[id]; }
    function getClaim(uint256 id) external view returns (Claim memory) { return _claims[id]; }

    function getAllProducts() external view returns (Product[] memory) { return _products; }
    function getAllPolicies() external view returns (Policy[] memory) { return _policies; }
    function getAllClaims() external view returns (Claim[] memory) { return _claims; }

    function isPolicyActive(uint256 policyId) public view returns (bool) {
        Policy storage pol = _policies[policyId];
        return pol.status == PolicyStatus.Active && block.timestamp < pol.expiresAt;
    }

    /* ---------------- Internal ---------------- */

    function _activePolicyOf(uint256 policyId, address holder) private view returns (Policy storage pol) {
        if (policyId >= _policies.length) revert InvalidInput();
        pol = _policies[policyId];
        if (pol.holder != holder) revert NotAuthorized();
        if (!isPolicyActive(policyId)) revert PolicyNotActive();
    }

    function _pendingClaim(uint256 claimId) private view returns (Claim storage c) {
        if (claimId >= _claims.length) revert InvalidInput();
        c = _claims[claimId];
        if (c.status != ClaimStatus.Pending) revert ClaimNotPending();
    }

    function _closeClaim(Claim storage c, ClaimStatus status, string memory note) private {
        c.status = status;
        c.decidedAt = uint64(block.timestamp);
        c.assessor = status == ClaimStatus.Withdrawn ? address(0) : msg.sender;
        c.decisionNote = note;
        _policies[c.policyId].hasOpenClaim = false;
        pendingClaimsTotal -= c.amount;
    }
}
