import { h, mount, icon, btn, field, alert, kv, pill, steps, toast, fmtDate, short } from "../../web/src/lib.js";
import { getNetwork, encodeAddress, normalizeLabel } from "../../packages/core/src/index.ts";
import { ethers } from "ethers";
import { wallet, isConnected, registryContracts, requireWallet, ensureChain } from "./connect.js";
import { openConnect } from "./ui.js";

export async function names(root) {
  if (!isConnected() || wallet.mode === "manual") {
    mount(root, h("div", { class: "card stack center", style: "padding:40px 20px" }, icon("list", 40), h("h2", { style: "margin:8px 0 0" }, "Connect a wallet"),
      h("p", { class: "muted", style: "margin:0" }, "Register and manage .addr names."),
      btn("Connect wallet", async () => { if (await requireWallet(() => openConnect())) names(root); }, "large")));
    return;
  }
  const mine = h("div", { class: "stack" }, h("div", { class: "muted" }, "Looking up names you registered..."));
  mount(root, h("div", { class: "stack lg" },
    h("div", { class: "card stack" }, h("h2", { style: "margin:0" }, "Register a name"), registerForm()),
    h("div", { class: "card stack" }, h("h3", { style: "margin:0" }, "Names you registered"),
      h("p", { class: "muted", style: "margin:0;font-size:13px" }, "Only shows names this wallet originally registered (read from on-chain events) — names transferred to you from elsewhere won't appear here without an index."),
      mine)));
  try {
    const { registrar, registry, info } = await registryContracts(false);
    const filter = registrar.filters.NameRegistered(null, null, wallet.address);
    const events = await registrar.queryFilter(filter, info.startBlock ?? 0, "latest");
    const rows = [];
    for (const ev of events) {
      const node = ev.args[0];
      const label = ev.args[1];
      const owner = await registry["ownerOf(bytes32)"](node).catch(() => null);
      if (owner && owner.toLowerCase() === wallet.address.toLowerCase()) rows.push({ name: `${label}.addr`, node });
    }
    mount(mine, rows.length
      ? rows.map((r) => h("div", { class: "row between", style: "padding:6px 0" }, h("a", { href: "#", style: "font-weight:650" }, r.name), pill("active", "ok")))
      : h("div", { class: "muted" }, "None found."));
  } catch (e) {
    mount(mine, alert("bad", e.message));
  }
}

function registerForm() {
  const label = h("input", { placeholder: "yourname", spellcheck: "false", autocomplete: "off", autocapitalize: "off" });
  const years = h("select", { "aria-label": "Years" }, [1, 2, 3, 4, 5].map((y) => h("option", { value: y }, `${y} year${y > 1 ? "s" : ""}`)));
  const out = h("div");
  const check = btn("Check availability & price", async () => {
    mount(out);
    let l;
    try { l = normalizeLabel(label.value); } catch (e) { mount(out, alert("bad", e.message)); return; }
    const { registrar } = await registryContracts(false);
    const avail = await registrar.available(l);
    if (!avail) { mount(out, alert("bad", `${l}.addr is not available.`)); return; }
    const [usdPerYear] = await registrar.priceFor(l, wallet.address);
    const yrs = Number(years.value);
    const usd = (usdPerYear * BigInt(yrs)) / 1_000_000n;
    mount(out, h("div", { class: "card soft tight stack" },
      kv([["Name", `${l}.addr`], ["Price", `$${usd.toString()} for ${yrs} year${yrs > 1 ? "s" : ""}, paid in ETH`]]),
      btn(`Register ${l}.addr`, () => doRegister(l, yrs, out), "large")));
  }, "large");
  label.addEventListener("keydown", (e) => { if (e.key === "Enter") check.click(); });
  return h("div", { class: "stack" }, h("div", { class: "grid" }, field("Name", h("div", { class: "row tight" }, label, h("span", { class: "muted" }, ".addr"))), field("Duration", years)), check, out);
}

async function doRegister(label, yrs, out) {
  const { registrar, resolver, info } = await registryContracts(true);
  await ensureChain(info.chain.id);
  const owner = wallet.address;
  const stepNames = ["Price", "Commit", "Wait", "Register", "Set address"];
  const box = h("div");
  mount(out, box);
  mount(box, steps(stepNames, 0));
  const [perYear] = await registrar.priceFor(label, owner);
  const usd = perYear * BigInt(yrs);
  const value = ((await registrar.ethForUsd(usd)) * 1005n) / 1000n; // 0.5% buffer, excess refunded by the contract
  const secret = ethers.hexlify(ethers.randomBytes(32));
  mount(box, steps(stepNames, 1));
  await (await registrar.commit(await registrar.makeCommitment(label, owner, secret))).wait();
  mount(box, steps(stepNames, 2));
  const wait = Number(await registrar.minCommitmentAge()) + 2;
  for (let s = wait; s > 0; s--) { mount(out, box, h("div", { class: "muted" }, `Waiting ${s}s to prevent front-running...`)); await new Promise((r) => setTimeout(r, 1000)); }
  mount(out, box);
  mount(box, steps(stepNames, 3));
  const rc = await (await registrar.register({ label, owner, years_: yrs, token: ethers.ZeroAddress, secret, deadline: 0, voucher: "0x" }, { value })).wait();
  mount(box, steps(stepNames, 4));
  const node = rc.logs.map((l) => { try { return registrar.interface.parseLog(l); } catch { return null; } }).find((l) => l?.name === "NameRegistered")?.args[0];
  if (node) await (await resolver.setAddr(node, 60, encodeAddress(getNetwork("ethereum"), owner))).wait();
  mount(out, alert("ok", h("b", null, `${label}.addr is yours.`), " Your Ethereum/EVM address record is already set to your wallet."));
  toast(`${label}.addr registered`);
}
