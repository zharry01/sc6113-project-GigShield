// Human-readable ABIs (ethers v6). Shared by the browser frontend and the Node backend.

const ERRORS = [
  "error NotAuthorized()",
  "error InvalidInput()",
  "error AlreadyRegistered()",
  "error LastAdminCannotBeRemoved()",
  "error InsufficientBalance()",
  "error InsufficientAllowance()",
  "error FaucetCooldown(uint256 availableAt)",
  "error InsufficientFreeCapital(uint256 available)",
  "error ProductInactive()",
  "error PolicyNotActive()",
  "error ClaimExceedsCoverage(uint256 remaining)",
  "error OpenClaimExists()",
  "error ClaimNotPending()",
  "error SelfAssessment()",
  "error ContractPaused()",
  "error Reentrancy()",
];

export const SHIELD_ABI = [
  ...ERRORS,
  "function registry() view returns (address)",
  "function token() view returns (address)",
  "function pool() view returns (address)",
  "function deployBlock() view returns (uint256)",
  "function paused() view returns (bool)",
  "function pendingClaimsTotal() view returns (uint256)",
  "function getAllProducts() view returns (tuple(string name, uint128 premium, uint128 coverage, uint32 durationDays, bool active)[])",
  "function getAllPolicies() view returns (tuple(uint64 productId, uint64 startAt, uint64 expiresAt, bool hasOpenClaim, uint8 status, address holder, uint128 premiumPaid, uint128 remainingCoverage)[])",
  "function getAllClaims() view returns (tuple(uint64 policyId, uint64 filedAt, uint64 decidedAt, uint8 status, address claimant, uint128 amount, address assessor, bytes32 evidenceHash, string decisionNote)[])",
  "function isPolicyActive(uint256 policyId) view returns (bool)",
  "function createProduct(string name, uint128 premium, uint128 coverage, uint32 durationDays)",
  "function setProductActive(uint256 productId, bool active)",
  "function setPaused(bool value)",
  "function buyPolicy(uint256 productId)",
  "function cancelPolicy(uint256 policyId)",
  "function fileClaim(uint256 policyId, uint128 amount, bytes32 evidenceHash)",
  "function withdrawClaim(uint256 claimId)",
  "function approveClaim(uint256 claimId, string note)",
  "function rejectClaim(uint256 claimId, string note)",
  "event ProductCreated(uint256 indexed productId, string name, uint256 premium, uint256 coverage, uint32 durationDays)",
  "event ProductStatusChanged(uint256 indexed productId, bool active)",
  "event PolicyPurchased(uint256 indexed policyId, address indexed holder, uint256 indexed productId, uint256 premium, uint256 expiresAt)",
  "event PolicyCancelled(uint256 indexed policyId, address indexed holder, uint256 refund)",
  "event ClaimFiled(uint256 indexed claimId, uint256 indexed policyId, address indexed claimant, uint256 amount, bytes32 evidenceHash)",
  "event ClaimApproved(uint256 indexed claimId, address indexed assessor, uint256 amount, string note)",
  "event ClaimRejected(uint256 indexed claimId, address indexed assessor, string note)",
  "event ClaimWithdrawn(uint256 indexed claimId, address indexed claimant)",
  "event PausedStateChanged(bool paused, address indexed by)",
];

export const REGISTRY_ABI = [
  ...ERRORS,
  "function roleOf(address) view returns (uint8)",
  "function adminCount() view returns (uint256)",
  "function registerAsCustomer()",
  "function grantRole(address account, uint8 role)",
  "function revokeRole(address account)",
  "event RoleChanged(address indexed account, uint8 oldRole, uint8 newRole, address indexed changedBy)",
];

export const TOKEN_ABI = [
  ...ERRORS,
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function lastFaucetAt(address) view returns (uint256)",
  "function faucet()",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
];

export const POOL_ABI = [
  ...ERRORS,
  "function balance() view returns (uint256)",
  "function freeCapital() view returns (uint256)",
  "function totalCapitalDeposited() view returns (uint256)",
  "function totalCapitalWithdrawn() view returns (uint256)",
  "function totalPremiums() view returns (uint256)",
  "function totalPayouts() view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "event CapitalDeposited(address indexed admin, uint256 amount)",
  "event CapitalWithdrawn(address indexed admin, uint256 amount)",
  "event PremiumCollected(address indexed payer, uint256 amount)",
  "event PayoutSent(address indexed to, uint256 amount)",
];

export const ROLE_NAMES = ["None", "Customer", "Auditor", "Admin"];
export const CLAIM_STATUS = ["Pending", "Paid", "Rejected", "Withdrawn"];
