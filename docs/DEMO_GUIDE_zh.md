# GigShield 部署与演示指南（中文）

整个演示约 **8–10 分钟**，按 Admin → Auditor → Customer → Auditor → Dashboard 的顺序走完一条完整的「投保 → 理赔 → 自动赔付」链路。

---

## 0. 准备工作（演示前完成）

| 项目 | 说明 |
|---|---|
| MetaMask | 准备 **3 个账户**：`Admin`、`Auditor`、`Customer`，切换到 **Sepolia** 网络 |
| Sepolia ETH | 每个账户约 0.05 ETH 足够（从 Sepolia faucet 领取） |
| Node.js | ≥ 22.13（`node -v` 查看） |

### 0.1 在 Remix 部署（只需一个文件、一次点击）

1. 打开 https://remix.ethereum.org ，新建 `GigShield.sol`，粘贴 `contracts/GigShield.sol` 的全部内容。
2. **Solidity Compiler**：编译器版本选 0.8.20 及以上 → 点 **Compile GigShield.sol**。
   - 可选：勾选 *Advanced → Enable optimization (200)*，能省 gas，不勾也能部署。
3. **Deploy & Run Transactions**：
   - Environment 选 **Injected Provider - MetaMask**，MetaMask 切到 **Admin** 账户。
   - ⚠️ **Contract 下拉框必须手动选 `GigShield - GigShield.sol`**。这个文件里有 4 个合约，Remix 默认选中的往往是别的合约（比如 GUSDToken）。
     选错了也能部署成功，但网站会提示 "This address is the GUSDToken contract, not GigShield"。
     简单的判断方法：部署后在 Deployed Contracts 里展开，能看到 `createProduct`、`registry`、`pool` 这些按钮才是对的。
   - 点 **Deploy**，在 MetaMask 中确认。不需要填写构造参数。
4. 部署成功后，在 *Deployed Contracts* 中复制 GigShield 地址。
   - 构造函数会自动部署另外 3 个合约（RoleRegistry、GUSDToken、RiskPool），可以点 `registry` / `token` / `pool` 按钮查看它们的地址。
   - 建议把部署交易哈希和 4 个合约地址记下来，写进报告的「部署详情」。

### 0.2 启动网站

```bash
cd gigshield
npm install
npm start          # 打开 http://localhost:4000
```

（如果已经部署到 Render，直接打开公网 URL 即可。）

### 0.3 连接合约

1. 用 **Admin** 账户点击 **Connect MetaMask**。
2. 进入 **🔧 Setup** 页 → 粘贴合约地址 → **Use this contract**。
3. 点击 **Sign & register with backend** → MetaMask 弹出签名请求（不花 gas）→ 确认。
   后端会验证签名者是否为链上 Admin，通过后开始索引事件。

---

## 1. Admin 准备资金池与产品（约 2 分钟）

> 讲解要点：只有链上 Admin 角色才能看到这个页面，部署者自动成为第一个 Admin。

1. **⚙️ Admin** 页 → 「Risk pool capital」 → 点 **🚰 Get 1,000 test gUSD**（faucet 测试币）。
   - 每笔交易前都会弹出 **Gas 估算窗口**（预估 gas、gas price、最大手续费），点 *Sign in MetaMask* 后再到 MetaMask 确认。
2. 金额输入 `800` → **Deposit**（会依次弹出 2 笔交易：先 `approve` 授权，再 `deposit` 存入）。
3. 「Create insurance product」：保留默认值 `Rider Accident Cover / 10 / 500 / 30` → **Create product**。
4. 「User roles」：粘贴 **Auditor** 账户地址，选择 `Auditor` → **Grant role**。

## 2. Customer 投保（约 2 分钟）

1. MetaMask 切换到 **Customer** 账户（页面会自动刷新）。
2. **👤 Customer** 页 → **Register as Customer**。
3. 点 **🚰 Get 1,000 test gUSD**。
4. 在产品卡片上点 **Buy policy**（先 approve 10 gUSD，再 buyPolicy）。
   - 「My policies」中出现保单，剩余保额为 500。
5. 点 **File claim**：金额填 `120`，描述填写例如：
   `12 Oct: slipped on wet road during a food delivery, clinic receipt #A123, SGD 120`
   - 讲解要点：描述文本存放在后端数据库，链上只保存它的 **keccak256 哈希**。
6. 演示异常处理：再提交一个超过保额的理赔（如 `600`）→ 交易发出前就会提示
   *"Claim exceeds remaining coverage (500 gUSD)"*，不会浪费 gas。

## 3. Auditor 审核理赔（约 1.5 分钟）

1. MetaMask 切换到 **Auditor** 账户 → **🔍 Auditor** 页。
2. 理赔队列中会显示：理赔金额、保单信息、证据文本，以及 **✓ Evidence matches on-chain hash**（证明数据库中的证据没有被篡改）。
3. 备注填 `Receipt verified` → **Approve & pay**。
   - RiskPool **自动把 120 gUSD 打给 Customer**，不需要人工转账。
4. 可选：再让 Customer 提一个理赔，然后用 **Reject** 拒绝（拒绝必须填写原因）。

## 4. Dashboard 与审计记录（约 1.5 分钟）

1. **📊 Dashboard**：资金池余额、保费收入、赔付金额、保单数、待处理理赔、赔付率（Loss ratio）、平均审核时间，以及 4 个图表：
   - 理赔状态分布、每日保费与赔付、**Gas 预估 vs 实际**、各类链上事件数量。
2. **📜 Activity & Events**：
   - 「My transactions」：当前钱包的每笔交易，包含预估 gas、实际 gas 和手续费，点哈希可以跳到 Etherscan。
   - 「Event log」：后端从 4 个合约索引的全部事件，可以按事件类型过滤，或勾选 *Only my wallet*。
3. 切回 Customer 账户，「My claims」中可以看到状态变为 **Paid**，并附有 Auditor 的备注，钱包余额也增加了。

## 5. 可选加分演示

- **紧急暂停**：Admin 点 **⏸ Pause GigShield** → Customer 再买保单时会提示 *"GigShield is paused"* → Admin 点 **Unpause** 恢复。
- **偿付能力保护**：有待处理理赔时，Admin 尝试 Withdraw 全部资金 → 提示只能取出 *free capital*。
- **退保**：Customer 对没有理赔过的保单点 **Cancel** → 按剩余天数比例退还保费。
- **权限控制**：Customer 账户看不到 Admin/Auditor 页面；即使直接调用合约，也会因 `NotAuthorized` 被回滚。

---

## 常见问题

| 现象 | 解决 |
|---|---|
| Remix 部署时 gas 估算失败 | 确认 Contract 下拉框选的是 **GigShield**，MetaMask 在 Sepolia 上，并且账户里有 ETH |
| 页面提示 "No GigShield contract set" | 到 Setup 页粘贴地址；并确认 MetaMask 处于部署时所用的网络 |
| Dashboard 显示 "backend has no contract registered" | Admin 在 Setup 页点 *Sign & register with backend* |
| Faucet 提示 cooldown | 每个地址每 10 分钟只能领取一次 |
| 交易 "would fail: ... allowance" | 正常流程会自动先 approve；如果在 MetaMask 中拒绝了 approve，重新点击即可 |
| 事件 / 图表没有立即更新 | 后端每 8 秒轮询一次链上数据，稍等几秒即可 |
