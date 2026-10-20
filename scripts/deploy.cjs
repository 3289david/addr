// Usage: npx hardhat run scripts/deploy.cjs --network <localhost|custom>
// Local chains (31337) get fixture tokens + a fixed-price ETH/USD feed because no real ones exist there.
// Live networks REQUIRE real addresses via env and never deploy fixtures.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const RESERVED = [
  "admin", "support", "root", "addr", "www", "api", "app", "help", "security", "official", "team", "mail",
  "wallet", "bank", "exchange", "ens", "dns", "registry", "resolver", "registrar", "treasury",
  "bitcoin", "ethereum", "solana", "tron", "litecoin", "usdt", "usdc",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const local = chainId === 31337;
  const env = process.env;
  const need = (k) => {
    if (!env[k]) throw new Error(`missing env ${k} (required on live networks)`);
    return env[k];
  };

  const treasury = local ? env.TREASURY || deployer.address : need("TREASURY");
  const adminMultisig = local ? deployer.address : need("ADMIN_MULTISIG");
  const delay = Number(env.TIMELOCK_DELAY || (local ? 1 : 2 * 86400));
  const freeSigner = env.FREE_SIGNER || (local ? deployer.address : need("FREE_SIGNER"));
  const operator = env.PAYMENT_OPERATOR || (local ? deployer.address : need("PAYMENT_OPERATOR"));

  const deploy = async (name, ...args) => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c;
  };

  console.log(`deploying to chain ${chainId} as ${deployer.address}`);
  const registry = await deploy("AddrRegistry", deployer.address);
  const resolver = await deploy("AddrResolver", await registry.getAddress());
  const registrar = await deploy("AddrRegistrar", await registry.getAddress(), deployer.address, treasury);
  await (await registry.setController(await registrar.getAddress(), true)).wait();
  await (await registrar.setResolver(await resolver.getAddress())).wait();
  await (await registrar.setFreeSigner(freeSigner)).wait();
  await (await registrar.setPaymentOperator(operator, true)).wait();
  await (await registrar.setMinCommitmentAge(local ? Number(env.MIN_COMMIT_AGE || 2) : 60)).wait();

  let tokens = {};
  let feedAddr;
  if (local) {
    const usdc = await deploy("MockERC20", "USD Coin (local)", "USDC", 6);
    const usdt = await deploy("MockERC20", "Tether USD (local)", "USDT", 6);
    const feed = await deploy("MockAggregator", BigInt(env.LOCAL_ETH_USD || 2000) * 10n ** 8n);
    tokens = { USDC: await usdc.getAddress(), USDT: await usdt.getAddress() };
    feedAddr = await feed.getAddress();
  } else {
    tokens = { USDC: need("USDC_ADDRESS"), USDT: env.USDT_ADDRESS };
    feedAddr = need("ETH_USD_FEED");
  }
  await (await registrar.setEthUsdFeed(feedAddr)).wait();
  for (const [sym, addr] of Object.entries(tokens)) {
    if (!addr) continue;
    const dec = Number(await new ethers.Contract(addr, ["function decimals() view returns (uint8)"], deployer).decimals());
    await (await registrar.setAcceptedToken(addr, dec)).wait();
    console.log(`accepted ${sym} ${addr} (${dec} decimals)`);
  }
  await (await registrar.setReserved(RESERVED.map((l) => ethers.keccak256(ethers.toUtf8Bytes(l))), true)).wait();

  // Hand administration to a timelock.
  const timelock = await deploy("AddrTimelock", delay, [adminMultisig], [adminMultisig], ethers.ZeroAddress);
  const tlAddr = await timelock.getAddress();
  await (await registry.transferOwnership(tlAddr)).wait();
  await (await registrar.transferOwnership(tlAddr)).wait();
  const accept = registry.interface.encodeFunctionData("acceptOwnership");
  const targets = [await registry.getAddress(), await registrar.getAddress()];
  if (local) {
    // deployer is proposer + executor on local chains: complete the handoff now
    for (const t of targets) await (await timelock.schedule(t, 0, accept, ethers.ZeroHash, ethers.ZeroHash, delay)).wait();
    await network.provider.send("evm_increaseTime", [delay + 1]);
    await network.provider.send("evm_mine");
    for (const t of targets) await (await timelock.execute(t, 0, accept, ethers.ZeroHash, ethers.ZeroHash)).wait();
    console.log("ownership handed to timelock:", (await registry.owner()) === tlAddr && (await registrar.owner()) === tlAddr);
  } else {
    console.log("PENDING: ADMIN_MULTISIG must schedule + execute acceptOwnership() on registry and registrar via the timelock:");
    for (const t of targets) console.log(`  timelock.schedule(${t}, 0, ${accept}, 0x0, 0x0, ${delay})`);
  }

  const out = {
    chainId,
    deployedAt: new Date().toISOString(),
    registry: await registry.getAddress(),
    resolver: await resolver.getAddress(),
    registrar: await registrar.getAddress(),
    timelock: tlAddr,
    ethUsdFeed: feedAddr,
    tokens,
    treasury,
    startBlock: await ethers.provider.getBlockNumber(),
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${chainId}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
