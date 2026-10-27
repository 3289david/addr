const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

const DAY = 86400;
const YEAR = 365 * DAY;
const lh = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const nh = (name) => name.split(".").reverse().reduce((n, l) => ethers.keccak256(ethers.concat([n, lh(l)])), ethers.ZeroHash);
const bytes32FromTokenId = (tokenId) => ethers.toBeHex(tokenId, 32);

async function increase(sec) {
  await network.provider.send("evm_increaseTime", [sec]);
  await network.provider.send("evm_mine");
}
async function expectRevert(p, match) {
  try {
    await p;
  } catch (e) {
    const msg = String(e.message || e) + JSON.stringify(e.data || "") + String(e.revert?.name || "");
    if (match && !msg.includes(match)) assert.fail(`wrong revert: expected "${match}" got "${msg.slice(0, 300)}"`);
    return;
  }
  assert.fail("expected revert" + (match ? ` (${match})` : ""));
}

describe("ADDR contracts", function () {
  let admin, treasury, alice, bob, carol, op, voucherSigner, guardian;
  let registry, resolver, registrar, usdc, feed;

  async function commitAndRegister(signer, label, owner, years, token, voucher = { deadline: 0, sig: "0x" }, value = 0n) {
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const c = await registrar.makeCommitment(label, owner, secret);
    await (await registrar.connect(signer).commit(c)).wait();
    await increase(61);
    return registrar.connect(signer).register(
      { label, owner, years_: years, token, secret, deadline: voucher.deadline, voucher: voucher.sig },
      { value },
    );
  }

  async function voucherFor(owner, label) {
    const net = await ethers.provider.getNetwork();
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const domain = { name: "AddrRegistrar", version: "1", chainId: net.chainId, verifyingContract: await registrar.getAddress() };
    const types = { FreeClaim: [{ name: "owner", type: "address" }, { name: "labelhash", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
    const sig = await voucherSigner.signTypedData(domain, types, { owner, labelhash: lh(label), deadline });
    return { deadline, sig };
  }

  beforeEach(async function () {
    [admin, treasury, alice, bob, carol, op, voucherSigner, guardian] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("AddrRegistry")).deploy(admin.address);
    resolver = await (await ethers.getContractFactory("AddrResolver")).deploy(await registry.getAddress());
    registrar = await (await ethers.getContractFactory("AddrRegistrar")).deploy(await registry.getAddress(), admin.address, treasury.address);
    await registry.setController(await registrar.getAddress(), true);
    await registrar.setResolver(await resolver.getAddress());
    usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    feed = await (await ethers.getContractFactory("MockAggregator")).deploy(2000n * 10n ** 8n); // $2000/ETH
    await registrar.setEthUsdFeed(await feed.getAddress());
    await registrar.setAcceptedToken(await usdc.getAddress(), 6);
    await registrar.setPaymentOperator(op.address, true);
    await registrar.setFreeSigner(voucherSigner.address);
  });

  describe("name rules", () => {
    it("hashes names like the SDK", async () => {
      assert.equal(await registry.ROOT(), nh("addr"));
    });
    it("rejects invalid labels", async () => {
      for (const bad of ["Heelo", "he_lo", "-abc", "abc-", "a--b", "", "x".repeat(64), "héllo"]) {
        await expectRevert(commitAndRegister(alice, bad, alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, bad)), "");
      }
    });
  });

  describe("registration and pricing", () => {
    it("gives exactly one free 5+ char name per wallet and requires a valid voucher", async () => {
      const v = await voucherFor(alice.address, "heelo");
      // wrong voucher (for another label)
      const bad = await voucherFor(alice.address, "other");
      await expectRevert(commitAndRegister(alice, "heelo", alice.address, 1, ethers.ZeroAddress, bad), "BadVoucher");
      await (await commitAndRegister(alice, "heelo", alice.address, 1, ethers.ZeroAddress, v)).wait();
      assert.equal(await registry["ownerOf(bytes32)"](nh("heelo.addr")), alice.address);
      assert.equal(await registrar.freeClaimed(alice.address), true);
      // second 5+ name is paid ($5/yr): free path must not apply
      const [perYear, free] = await registrar.priceFor("second", alice.address);
      assert.equal(free, false);
      assert.equal(perYear, 5_000_000n);
      await usdc.mint(alice.address, 100_000_000n);
      await usdc.connect(alice).approve(await registrar.getAddress(), 100_000_000n);
      const before = await usdc.balanceOf(treasury.address);
      await (await commitAndRegister(alice, "second", alice.address, 2, await usdc.getAddress())).wait();
      assert.equal((await usdc.balanceOf(treasury.address)) - before, 10_000_000n);
      assert.equal(await registry["ownerOf(bytes32)"](nh("second.addr")), alice.address);
    });

    it("free benefit is not replicated by transferring the free name", async () => {
      await (await commitAndRegister(alice, "freeone", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "freeone"))).wait();
      await (await registry.connect(alice).transfer(nh("freeone.addr"), bob.address)).wait();
      assert.equal(await registrar.freeClaimed(alice.address), true);
      // alice cannot claim another free name
      const [, free] = await registrar.priceFor("another", alice.address);
      assert.equal(free, false);
    });

    it("charges short names in ETH using the oracle and refunds the excess", async () => {
      // 3-char: $50/yr -> 0.025 ETH at $2000
      const need = await registrar.ethForUsd(50_000_000n);
      assert.ok(need >= ethers.parseEther("0.025") && need <= ethers.parseEther("0.025") + 2n);
      const tBefore = await ethers.provider.getBalance(treasury.address);
      const tx = await commitAndRegister(bob, "lee", bob.address, 1, ethers.ZeroAddress, undefined, ethers.parseEther("1"));
      const rc = await tx.wait();
      const paid = (await ethers.provider.getBalance(treasury.address)) - tBefore;
      assert.equal(paid, need);
      assert.equal(await registry["ownerOf(bytes32)"](nh("lee.addr")), bob.address);
      const ev = rc.logs.map((l) => { try { return registrar.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "NameRegistered");
      assert.equal(ev.args.usdPaid, 50_000_000n);
    });

    it("rejects underpayment, single-char names, and stale oracle", async () => {
      await expectRevert(commitAndRegister(bob, "abc", bob.address, 1, ethers.ZeroAddress, undefined, 1n), "Underpaid");
      await expectRevert(commitAndRegister(bob, "a", bob.address, 1, ethers.ZeroAddress, undefined, ethers.parseEther("5")), "LengthNotOpen");
      await increase(2 * DAY);
      await expectRevert(commitAndRegister(bob, "abcd", bob.address, 1, ethers.ZeroAddress, undefined, ethers.parseEther("1")), "OracleStale");
    });

    it("enforces commit-reveal age", async () => {
      const label = "committed";
      const secret = ethers.hexlify(ethers.randomBytes(32));
      const c = await registrar.makeCommitment(label, alice.address, secret);
      const req = { label, owner: alice.address, years_: 1, token: ethers.ZeroAddress, secret, deadline: 0, voucher: "0x" };
      await expectRevert(registrar.connect(alice).register(req), "CommitmentMissing");
      await registrar.connect(alice).commit(c);
      await expectRevert(registrar.connect(alice).register(req), "CommitmentTooNew");
      await increase(DAY + 10);
      await expectRevert(registrar.connect(alice).register(req), "CommitmentExpired");
    });

    it("blocks reserved names for the public, mints them only via the owner, and admin cannot take registered names", async () => {
      await registrar.setReserved([lh("admin")], true);
      await expectRevert(commitAndRegister(alice, "admin", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "admin")), "ReservedName");
      await registrar.mintReserved("admin", admin.address, 1);
      assert.equal(await registry["ownerOf(bytes32)"](nh("admin.addr")), admin.address);
      // existing user name cannot be taken: reserving it later does not move it, and re-mint fails
      await (await commitAndRegister(alice, "mine1", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "mine1"))).wait();
      await registrar.setReserved([lh("mine1")], true);
      await expectRevert(registrar.mintReserved("mine1", admin.address, 1), "NameUnavailable");
      assert.equal(await registry["ownerOf(bytes32)"](nh("mine1.addr")), alice.address);
      // admin has no direct way to change ownership
      await expectRevert(registry.connect(admin).transfer(nh("mine1.addr"), admin.address), "NotAuthorised");
    });

    it("only a controller can register in the registry", async () => {
      await expectRevert(registry.connect(alice).register("sneaky", alice.address, 99999999999, ethers.ZeroAddress), "NotController");
    });
  });

  describe("expiry, grace and renewal", () => {
    beforeEach(async () => {
      await (await commitAndRegister(alice, "expiring", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "expiring"))).wait();
    });
    it("free names renew for free; records die at expiry and the name is re-registrable after grace", async () => {
      const node = nh("expiring.addr");
      await (await resolver.connect(alice)["setAddr(bytes32,address)"](node, alice.address)).wait();
      assert.equal(await resolver["addr(bytes32)"](node), alice.address);
      await increase(YEAR + DAY); // expired, in grace
      assert.equal(await registry["ownerOf(bytes32)"](node), ethers.ZeroAddress);
      assert.equal(await resolver["addr(bytes32)"](node), ethers.ZeroAddress);
      assert.equal(await registry.statusOf(node), 2n);
      await expectRevert(resolver.connect(alice)["setAddr(bytes32,address)"](node, alice.address), "NotAuthorised");
      await expectRevert(commitAndRegister(bob, "expiring", bob.address, 1, ethers.ZeroAddress, await voucherFor(bob.address, "expiring")), "NameUnavailable");
      // renew inside grace, free
      await (await registrar.connect(carol).renew("expiring", 1, ethers.ZeroAddress)).wait();
      assert.equal(await registry["ownerOf(bytes32)"](node), alice.address);
      assert.equal(await resolver["addr(bytes32)"](node), alice.address); // records survive a renewal in grace
    });
    it("after grace a new owner gets a clean slate", async () => {
      const node = nh("expiring.addr");
      await (await resolver.connect(alice)["setAddr(bytes32,address)"](node, alice.address)).wait();
      await resolver.connect(alice).setText(node, "url", "https://alice.example");
      await increase(YEAR + 31 * DAY);
      assert.equal(await registry.statusOf(node), 3n);
      await (await commitAndRegister(bob, "expiring", bob.address, 1, ethers.ZeroAddress, await voucherFor(bob.address, "expiring"))).wait();
      assert.equal(await registry["ownerOf(bytes32)"](node), bob.address);
      assert.equal(await resolver["addr(bytes32)"](node), ethers.ZeroAddress);
      assert.equal(await resolver.text(node, "url"), "");
    });
    it("caps total duration at 5 years", async () => {
      for (let i = 0; i < 4; i++) await registrar.renew("expiring", 1, ethers.ZeroAddress);
      await expectRevert(registrar.renew("expiring", 1, ethers.ZeroAddress), "DurationCap");
    });
  });

  describe("resolver", () => {
    const btc = "0x0014" + "11".repeat(20);
    let node;
    beforeEach(async () => {
      await (await commitAndRegister(alice, "records", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "records"))).wait();
      node = nh("records.addr");
    });
    it("stores per-coin records with metadata and versions, validates formats", async () => {
      await resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 0, btc);
      assert.equal(await resolver["addr(bytes32,uint256)"](node, 0), btc);
      const sol = "0x" + "ab".repeat(32);
      await resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 501, sol);
      const tron = "0x41" + "cd".repeat(20);
      await resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 195, tron);
      const base = (0x80000000 | 8453) >>> 0;
      await resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, base, alice.address);
      const m = await resolver.addrMeta(node, 0);
      assert.equal(m.version, 1n);
      await resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 0, "0x0014" + "22".repeat(20));
      assert.equal((await resolver.addrMeta(node, 0)).version, 2n);
      await expectRevert(resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 501, "0x1234"), "InvalidRecord");
      await expectRevert(resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 195, "0x42" + "cd".repeat(20)), "InvalidRecord");
      await expectRevert(resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 0, "0x1234"), "InvalidRecord");
      await expectRevert(resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 60, "0x1234"), "InvalidRecord");
    });
    it("only owner or approved operators may write; approvals die on transfer", async () => {
      await expectRevert(resolver.connect(bob)["setAddr(bytes32,address)"](node, bob.address), "NotAuthorised");
      await registry.connect(alice).approveName(node, bob.address, true);
      await resolver.connect(bob)["setAddr(bytes32,address)"](node, bob.address);
      await expectRevert(registry.connect(bob).transfer(node, bob.address), "NotAuthorised"); // approved != can transfer
      await registry.connect(alice).transfer(node, carol.address);
      await expectRevert(resolver.connect(bob)["setAddr(bytes32,address)"](node, bob.address), "NotAuthorised");
    });
    it("clearRecords wipes everything atomically", async () => {
      await resolver.connect(alice)["setAddr(bytes32,uint256,bytes)"](node, 0, btc);
      await resolver.connect(alice).setText(node, "url", "x");
      await resolver.connect(alice).clearRecords(node);
      assert.equal(await resolver["addr(bytes32,uint256)"](node, 0), "0x");
      assert.equal(await resolver.text(node, "url"), "");
    });
    it("multicall batches updates", async () => {
      const d1 = resolver.interface.encodeFunctionData("setAddr(bytes32,uint256,bytes)", [node, 0, btc]);
      const d2 = resolver.interface.encodeFunctionData("setText", [node, "description", "hi"]);
      await resolver.connect(alice).multicall([d1, d2]);
      assert.equal(await resolver.text(node, "description"), "hi");
    });
    it("reverse records are forward-verified and die when ownership moves", async () => {
      await resolver.connect(alice).setPrimaryName("records.addr");
      let [name] = await resolver.reverse(alice.address);
      assert.equal(name, "records.addr");
      await expectRevert(resolver.connect(bob).setPrimaryName("records.addr"), "NotVerified");
      await expectRevert(resolver.connect(alice).setPrimaryName("Records.addr"), "InvalidName");
      await registry.connect(alice).transfer(node, bob.address);
      [name] = await resolver.reverse(alice.address);
      assert.equal(name, "");
      // an address mapped via ETH record also verifies
      await resolver.connect(bob)["setAddr(bytes32,address)"](node, carol.address);
      await resolver.connect(carol).setPrimaryName("records.addr");
      assert.equal((await resolver.reverse(carol.address))[0], "records.addr");
    });
  });

  describe("transfer, lock, recovery", () => {
    let node;
    beforeEach(async () => {
      await (await commitAndRegister(alice, "movable", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "movable"))).wait();
      node = nh("movable.addr");
    });
    it("lock blocks transfer and can only be extended", async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await registry.connect(alice).lock(node, now + 10 * DAY);
      await expectRevert(registry.connect(alice).transfer(node, bob.address), "NameLockedError");
      await expectRevert(registry.connect(alice).lock(node, now + 5 * DAY), "bad lock");
      await increase(11 * DAY);
      await registry.connect(alice).transfer(node, bob.address);
      assert.equal(await registry["ownerOf(bytes32)"](node), bob.address);
    });
    it("guardian recovery respects the delay and the owner can cancel", async () => {
      await expectRevert(registry.connect(alice).setRecovery(node, guardian.address, 3600), "BadRecovery");
      await registry.connect(alice).setRecovery(node, guardian.address, 3 * DAY);
      await expectRevert(registry.connect(bob).startRecovery(node, bob.address), "NotAuthorised");
      await registry.connect(guardian).startRecovery(node, bob.address);
      await expectRevert(registry.connect(guardian).executeRecovery(node), "not ready");
      await registry.connect(alice).cancelRecovery(node);
      await increase(4 * DAY);
      await expectRevert(registry.connect(guardian).executeRecovery(node), "not ready");
      await registry.connect(guardian).startRecovery(node, bob.address);
      await increase(3 * DAY + 5);
      await registry.connect(guardian).executeRecovery(node);
      assert.equal(await registry["ownerOf(bytes32)"](node), bob.address);
      assert.equal((await registry.recoveryPolicy(node)).guardian, ethers.ZeroAddress); // policy resets for new owner
    });
  });

  describe("subnames and enterprise issuance", () => {
    let parent, relayer;
    beforeEach(async () => {
      relayer = carol;
      // enterprise buys a 6-char parent (free) and authorises a relayer for that one name only
      await (await commitAndRegister(alice, "wallet", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "wallet"))).wait();
      parent = nh("wallet.addr");
      await registry.connect(alice).approveName(parent, relayer.address, true);
    });
    it("relayer issues a subname owned by the customer with records, atomically", async () => {
      const node = nh("bob.wallet.addr");
      const eth = resolver.interface.encodeFunctionData("setAddr(bytes32,address)", [node, bob.address]);
      const btc = resolver.interface.encodeFunctionData("setAddr(bytes32,uint256,bytes)", [node, 0, "0x0014" + "33".repeat(20)]);
      await registry.connect(relayer).createSubname(parent, "bob", bob.address, await resolver.getAddress(), [eth, btc]);
      assert.equal(await registry["ownerOf(bytes32)"](node), bob.address);
      assert.equal(await resolver["addr(bytes32)"](node), bob.address);
      assert.equal(await resolver["addr(bytes32,uint256)"](node, 0), "0x0014" + "33".repeat(20));
      // the relayer does NOT own the customer's subname and cannot rewrite its records
      await expectRevert(resolver.connect(relayer)["setAddr(bytes32,address)"](node, relayer.address), "NotAuthorised");
      // but customer can
      await resolver.connect(bob)["setAddr(bytes32,address)"](node, carol.address);
    });
    it("rejects calls that target a different node or use a disallowed selector", async () => {
      const other = nh("evil.wallet.addr");
      const bad = resolver.interface.encodeFunctionData("setAddr(bytes32,address)", [other, bob.address]);
      await expectRevert(registry.connect(relayer).createSubname(parent, "bob", bob.address, await resolver.getAddress(), [bad]), "wrong node");
      const node = nh("bob.wallet.addr");
      const clear = resolver.interface.encodeFunctionData("clearRecords", [node]);
      await expectRevert(registry.connect(relayer).createSubname(parent, "bob", bob.address, await resolver.getAddress(), [clear]), "selector");
    });
    it("non-authorised cannot issue; parent expiry kills subnames; sovereign subnames cannot be removed by parent", async () => {
      await expectRevert(registry.connect(bob).createSubname(parent, "x1", bob.address, ethers.ZeroAddress, []), "NotAuthorised");
      await registry.connect(relayer).createSubname(parent, "one", bob.address, await resolver.getAddress(), []);
      await registry.connect(relayer).createSubname(parent, "two", bob.address, await resolver.getAddress(), []);
      const one = nh("one.wallet.addr"), two = nh("two.wallet.addr");
      await registry.connect(bob).burnParentControl(one);
      await expectRevert(registry.connect(relayer).removeSubname(one), "ParentControlGone");
      await registry.connect(alice).removeSubname(two); // parent owner may remove non-sovereign
      assert.equal(await registry["ownerOf(bytes32)"](two), ethers.ZeroAddress);
      await increase(YEAR + DAY);
      assert.equal(await registry["ownerOf(bytes32)"](one), ethers.ZeroAddress); // parent expired
    });
    it("a re-registered parent does not resurrect old subnames", async () => {
      await registry.connect(relayer).createSubname(parent, "ghost", bob.address, ethers.ZeroAddress, []);
      await increase(YEAR + 31 * DAY);
      await (await commitAndRegister(carol, "wallet", carol.address, 1, ethers.ZeroAddress, await voucherFor(carol.address, "wallet"))).wait();
      assert.equal(await registry["ownerOf(bytes32)"](nh("ghost.wallet.addr")), ethers.ZeroAddress);
    });
    it("subname owner can transfer a sovereign subname out", async () => {
      await registry.connect(relayer).createSubname(parent, "move", bob.address, await resolver.getAddress(), []);
      await registry.connect(bob).transfer(nh("move.wallet.addr"), carol.address);
      assert.equal(await registry["ownerOf(bytes32)"](nh("move.wallet.addr")), carol.address);
    });
  });

  describe("operator path for off-chain coin payments", () => {
    it("registers once per payment ref, honours caps, cannot touch reserved or taken names", async () => {
      const ref = ethers.id("btc:tx1");
      await registrar.connect(op).registerPaid("lonely", alice.address, 2, ref);
      assert.equal(await registry["ownerOf(bytes32)"](nh("lonely.addr")), alice.address);
      await expectRevert(registrar.connect(op).registerPaid("lonely2", alice.address, 1, ref), "RefUsed");
      await expectRevert(registrar.connect(alice).registerPaid("hacked", alice.address, 1, ethers.id("z")), "NotOperator");
      await expectRevert(registrar.connect(op).registerPaid("lonely", bob.address, 1, ethers.id("x")), "NameUnavailable");
      await registrar.setOperatorDailyCap(1);
      await expectRevert(registrar.connect(op).registerPaid("capped", alice.address, 1, ethers.id("y")), "OperatorCapReached");
      await registrar.connect(op).renewPaid("lonely", 1, ethers.id("renew")).catch((e) => assert.ok(String(e.message).includes("OperatorCapReached")));
    });
  });

  describe("ERC-721 compliance (names as NFTs)", () => {
    const ERC165 = "0x01ffc9a7", ERC721 = "0x80ac58cd", ERC721Metadata = "0x5b5e139f";

    it("declares the right interfaces and metadata", async () => {
      assert.equal(await registry.supportsInterface(ERC165), true);
      assert.equal(await registry.supportsInterface(ERC721), true);
      assert.equal(await registry.supportsInterface(ERC721Metadata), true);
      assert.equal(await registry.supportsInterface("0xffffffff"), false);
      assert.equal(await registry.name(), "ADDR Names");
      assert.equal(await registry.symbol(), "ADDR");
    });

    it("balanceOf/ownerOf(uint256) agree with the node-keyed API after register()", async () => {
      await commitAndRegister(alice, "nifty", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "nifty"));
      const node = nh("nifty.addr");
      const tokenId = BigInt(node);
      assert.equal(await registry.balanceOf(alice.address), 1n);
      assert.equal(await registry["ownerOf(uint256)"](tokenId), alice.address);
      assert.equal(await registry["ownerOf(bytes32)"](node), alice.address);
      await expectRevert(registry.balanceOf(ethers.ZeroAddress), "");
    });

    it("ownerOf(uint256) reverts for an unregistered/inactive token (unlike ownerOf(bytes32))", async () => {
      const tokenId = BigInt(nh("totallyunregistered.addr"));
      await expectRevert(registry["ownerOf(uint256)"](tokenId), "");
      assert.equal(await registry["ownerOf(bytes32)"](bytes32FromTokenId(tokenId)), ethers.ZeroAddress);
    });

    it("transferFrom moves ownership, updates balances both ways, clears approval, and the legacy transfer() API sees the exact same result", async () => {
      await commitAndRegister(alice, "movable", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "movable"));
      const node = nh("movable.addr");
      const tokenId = BigInt(node);
      await registry.connect(alice).approve(carol.address, tokenId);
      assert.equal(await registry.getApproved(tokenId), carol.address);
      await registry.connect(carol).transferFrom(alice.address, bob.address, tokenId);
      assert.equal(await registry["ownerOf(uint256)"](tokenId), bob.address);
      assert.equal(await registry["ownerOf(bytes32)"](node), bob.address);
      assert.equal(await registry.balanceOf(alice.address), 0n);
      assert.equal(await registry.balanceOf(bob.address), 1n);
      assert.equal(await registry.getApproved(tokenId), ethers.ZeroAddress); // cleared on transfer
      // now move it back using the ORIGINAL node-keyed transfer() — must update the ERC-721 view too
      await registry.connect(bob).transfer(node, alice.address);
      assert.equal(await registry["ownerOf(uint256)"](tokenId), alice.address);
      assert.equal(await registry.balanceOf(alice.address), 1n);
      assert.equal(await registry.balanceOf(bob.address), 0n);
    });

    it("setApprovalForAll lets an operator transferFrom, and respects lock()", async () => {
      await commitAndRegister(alice, "opname", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "opname"));
      const node = nh("opname.addr");
      const tokenId = BigInt(node);
      await expectRevert(registry.connect(carol).transferFrom(alice.address, carol.address, tokenId), "");
      await registry.connect(alice).setApprovalForAll(carol.address, true);
      await registry.connect(alice).lock(node, (await ethers.provider.getBlock("latest")).timestamp + DAY);
      await expectRevert(registry.connect(carol).transferFrom(alice.address, carol.address, tokenId), "NameLockedError");
    });

    it("safeTransferFrom checks onERC721Received on the recipient", async () => {
      await commitAndRegister(alice, "safeone", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "safeone"));
      const tokenId = BigInt(nh("safeone.addr"));
      const accepting = await (await ethers.getContractFactory("MockERC721Receiver")).deploy(true);
      const rejecting = await (await ethers.getContractFactory("MockERC721Receiver")).deploy(false);
      await registry.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, await accepting.getAddress(), tokenId);
      assert.equal(await registry["ownerOf(uint256)"](tokenId), await accepting.getAddress());
      await commitAndRegister(bob, "safetwo", bob.address, 1, ethers.ZeroAddress, await voucherFor(bob.address, "safetwo"));
      const tokenId2 = BigInt(nh("safetwo.addr"));
      await expectRevert(
        registry.connect(bob)["safeTransferFrom(address,address,uint256)"](bob.address, await rejecting.getAddress(), tokenId2),
        "",
      );
    });

    it("re-registering an expired name re-mints correctly: old owner's balance drops, new owner's rises", async () => {
      await commitAndRegister(alice, "willexpire", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "willexpire"));
      assert.equal(await registry.balanceOf(alice.address), 1n);
      await increase(YEAR + 31 * DAY); // past grace period
      await commitAndRegister(bob, "willexpire", bob.address, 1, ethers.ZeroAddress, await voucherFor(bob.address, "willexpire"));
      assert.equal(await registry.balanceOf(alice.address), 0n);
      assert.equal(await registry.balanceOf(bob.address), 1n);
      assert.equal(await registry["ownerOf(uint256)"](BigInt(nh("willexpire.addr"))), bob.address);
    });

    it("subnames are tokens too: createSubname mints, removeSubname burns", async () => {
      await commitAndRegister(alice, "parentname", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "parentname"));
      const parent = nh("parentname.addr");
      await registry.connect(alice).createSubname(parent, "sub", bob.address, ethers.ZeroAddress, []);
      const subNode = nh("sub.parentname.addr");
      const subId = BigInt(subNode);
      assert.equal(await registry["ownerOf(uint256)"](subId), bob.address);
      assert.equal(await registry.balanceOf(bob.address), 1n);
      await registry.connect(bob).removeSubname(subNode);
      await expectRevert(registry["ownerOf(uint256)"](subId), "");
      assert.equal(await registry.balanceOf(bob.address), 0n);
    });

    it("tokenURI reflects baseTokenURI, settable by the owner", async () => {
      await commitAndRegister(alice, "metaname", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "metaname"));
      const tokenId = BigInt(nh("metaname.addr"));
      await registry.connect(admin).setBaseTokenURI("https://addr.krl.kr/v1/nft/");
      assert.equal(await registry.tokenURI(tokenId), `https://addr.krl.kr/v1/nft/${tokenId}`);
      await expectRevert(registry.connect(alice).setBaseTokenURI("https://evil.example/"), "OwnableUnauthorizedAccount");
    });
  });

  describe("gasless relay (EIP-712 signed actions — address changes & contract actions with no gas from the owner)", () => {
    async function signSetAddr(signer, node, coinType, value, nonce, deadline) {
      const net = await ethers.provider.getNetwork();
      const domain = { name: "AddrResolver", version: "1", chainId: net.chainId, verifyingContract: await resolver.getAddress() };
      const types = { SetAddr: [{ name: "node", type: "bytes32" }, { name: "coinType", type: "uint256" }, { name: "value", type: "bytes" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
      return signer.signTypedData(domain, types, { node, coinType, value, nonce, deadline });
    }
    async function signSetPrimaryName(signer, node, name, nonce, deadline) {
      const net = await ethers.provider.getNetwork();
      const domain = { name: "AddrResolver", version: "1", chainId: net.chainId, verifyingContract: await resolver.getAddress() };
      const types = { SetPrimaryName: [{ name: "node", type: "bytes32" }, { name: "name", type: "string" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
      return signer.signTypedData(domain, types, { node, name, nonce, deadline });
    }
    async function signTransfer(signer, node, to, nonce, deadline) {
      const net = await ethers.provider.getNetwork();
      const domain = { name: "AddrRegistry", version: "1", chainId: net.chainId, verifyingContract: await registry.getAddress() };
      const types = { Transfer: [{ name: "node", type: "bytes32" }, { name: "to", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
      return signer.signTypedData(domain, types, { node, to, nonce, deadline });
    }
    const future = async (secs = 3600) => (await ethers.provider.getBlock("latest")).timestamp + secs;

    it("setAddrSigned: a relayer (not the owner) submits, pays gas, and the record is set as if the owner called directly", async () => {
      await commitAndRegister(alice, "gasless1", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "gasless1"));
      const node = nh("gasless1.addr");
      const value = ethers.hexlify(bob.address);
      const deadline = await future();
      const signature = await signSetAddr(alice, node, 60n, value, 0n, deadline);
      // op (not alice) submits and pays gas; alice never sends a transaction
      await (await resolver.connect(op).setAddrSigned(node, 60n, value, 0n, deadline, signature)).wait();
      assert.equal((await resolver["addr(bytes32,uint256)"](node, 60n)).toLowerCase(), value.toLowerCase());
      assert.equal(await resolver.nonces(alice.address), 1n);
    });

    it("setAddrSigned rejects: wrong signer (not authorised for the name), reused nonce, and expired deadline", async () => {
      await commitAndRegister(alice, "gasless2", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "gasless2"));
      const node = nh("gasless2.addr");
      const value = ethers.hexlify(bob.address);
      const deadline = await future();
      // bob signs for a name he doesn't own
      const badSig = await signSetAddr(bob, node, 60n, value, 0n, deadline);
      await expectRevert(resolver.connect(op).setAddrSigned(node, 60n, value, 0n, deadline, badSig), "NotAuthorised");
      // alice's real signature works once...
      const goodSig = await signSetAddr(alice, node, 60n, value, 0n, deadline);
      await (await resolver.connect(op).setAddrSigned(node, 60n, value, 0n, deadline, goodSig)).wait();
      // ...and the exact same signature cannot be replayed
      await expectRevert(resolver.connect(op).setAddrSigned(node, 60n, value, 0n, deadline, goodSig), "BadSignature");
      // an expired deadline is rejected even with a fresh nonce
      const expired = (await ethers.provider.getBlock("latest")).timestamp - 1;
      const expiredSig = await signSetAddr(alice, node, 60n, value, 1n, expired);
      await expectRevert(resolver.connect(op).setAddrSigned(node, 60n, value, 1n, expired, expiredSig), "Expired");
    });

    it("setPrimaryNameSigned sets the reverse record gaslessly", async () => {
      await commitAndRegister(alice, "gasless3", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "gasless3"));
      const node = nh("gasless3.addr");
      const deadline = await future();
      const signature = await signSetPrimaryName(alice, node, "gasless3.addr", 0n, deadline);
      await (await resolver.connect(op).setPrimaryNameSigned("gasless3.addr", 0n, deadline, signature)).wait();
      const [name] = await resolver.reverse(alice.address);
      assert.equal(name, "gasless3.addr");
    });

    it("transferSigned moves ownership with the relayer paying gas, respects locks, and cannot be replayed", async () => {
      await commitAndRegister(alice, "gasless4", alice.address, 1, ethers.ZeroAddress, await voucherFor(alice.address, "gasless4"));
      const node = nh("gasless4.addr");
      const deadline = await future();
      const signature = await signTransfer(alice, node, bob.address, 0n, deadline);
      await (await registry.connect(op).transferSigned(node, bob.address, 0n, deadline, signature)).wait();
      assert.equal(await registry["ownerOf(bytes32)"](node), bob.address);
      await expectRevert(registry.connect(op).transferSigned(node, bob.address, 0n, deadline, signature), "BadSignature");
      // locked names cannot be transferred, signed or not
      await commitAndRegister(carol, "gasless5", carol.address, 1, ethers.ZeroAddress, await voucherFor(carol.address, "gasless5"));
      const node2 = nh("gasless5.addr");
      await registry.connect(carol).lock(node2, await future(2 * DAY));
      const sig2 = await signTransfer(carol, node2, alice.address, 0n, await future());
      await expectRevert(registry.connect(op).transferSigned(node2, alice.address, 0n, await future(), sig2), "NameLockedError");
    });

    it("paid registration can be relayed in a token the owner pre-approved, without the owner sending any transaction", async () => {
      // "paid" (non-free) label; alice pre-approves the registrar once (this one approval is the
      // only on-chain action she needs — commit+register are both submitted by op).
      await usdc.mint(alice.address, 100_000_000n);
      await usdc.connect(alice).approve(await registrar.getAddress(), 100_000_000n);
      const label = "rlyd"; // under 5 chars: not free-tier eligible, forces the paid path
      const secret = ethers.hexlify(ethers.randomBytes(32));
      const commitment = await registrar.makeCommitment(label, alice.address, secret);
      await (await registrar.connect(op).commit(commitment)).wait();
      await increase(61);
      const before = await usdc.balanceOf(treasury.address);
      await (await registrar.connect(op).register(
        { label, owner: alice.address, years_: 1, token: await usdc.getAddress(), secret, deadline: 0, voucher: "0x" },
      )).wait();
      assert.ok((await usdc.balanceOf(treasury.address)) > before, "treasury received alice's token payment, not op's");
      assert.equal(await usdc.balanceOf(op.address), 0n, "op never paid the price, only gas");
      assert.equal(await registry["ownerOf(bytes32)"](nh(`${label}.addr`)), alice.address);
    });
  });

  describe("two-step admin and treasury", () => {
    it("ownership handoff needs acceptance", async () => {
      await registrar.transferOwnership(alice.address);
      assert.equal(await registrar.owner(), admin.address);
      await registrar.connect(alice).acceptOwnership();
      assert.equal(await registrar.owner(), alice.address);
      await expectRevert(registrar.connect(admin).setTreasury(admin.address), "OwnableUnauthorizedAccount");
    });
  });
});
