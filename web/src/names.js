import { ethers } from "ethers";
import { h, mount, icon, btn, field, alert, api, coin, pill, statusPill, kv, tabs, skeleton, empty, fmtDate, daysLeft, toast, confirmDialog, copyLine, link } from "./lib.js";
import { wallet, contracts, requireWallet, isConnected, openConnect } from "./wallet.js";
import { NETWORKS, validateAddress, encodeAddress, bytesToHex, namehash } from "../../packages/core/src/index.ts";

const TEXT_KEYS = [["display", "Display name"], ["description", "Description"], ["url", "Website"], ["avatar", "Avatar URL"], ["email", "Public email"], ["twitter", "X / Twitter"], ["github", "GitHub"]];

export async function names(root) {
  if (!isConnected()) {
    return mount(root, h("div", { class: "page-head" }, h("h1", null, "My names"), h("p", null, "Connect a wallet or enter your address to manage the names it owns.")),
      empty("wallet", "No wallet connected", "Connect a browser wallet, or enter your address manually and approve each change from any wallet.", btn("Connect wallet", async () => { if (await openConnect()) names(root); })));
  }
  mount(root, h("div", { class: "page-head" }, h("h1", null, "My names"), h("p", { class: "mono", style: "font-size:13px" }, wallet.address)), skeleton(4));
  const list = await api("GET", `/v1/accounts/${wallet.address}/names`);
  const head = h("div", { class: "page-head" }, h("div", { class: "row between" }, h("div", null, h("h1", null, "My names"), h("p", null, `${list.names.length} name${list.names.length === 1 ? "" : "s"} owned by this address`)),
    h("a", { class: "btn", href: "/" }, icon("plus", 16), "Register a name")),
    wallet.mode === "manual" ? alert("info", h("b", null, "Manual mode. "), "Changes open a dialog with the transaction fields. Send it from your wallet, then paste the hash.") : null);
  mount(root, head, list.names.length ? h("div", { class: "stack" }, list.names.map(nameCard))
    : empty("inbox", "No names yet", "Names you register or receive will show up here.", h("a", { class: "btn", href: "/" }, "Find a name")));
}

function nameCard(n) {
  const body = h("div", { class: "hide", style: "margin-top:18px" });
  const toggle = btn("Manage", async () => {
    if (!body.classList.contains("hide")) { body.classList.add("hide"); return; }
    body.classList.remove("hide"); mount(body, skeleton(4));
    const rec = await api("GET", `/v1/names/${n.name}/records`);
    drawPanel(body, n, rec);
  }, "secondary small");
  return h("div", { class: "card" },
    h("div", { class: "row between" },
      h("div", null, h("div", { class: "row tight" }, h("a", { href: `/name/${n.name}`, style: "font-size:20px;font-weight:700;color:var(--text)" }, n.name), n.level === "sub" ? pill("subname", "info") : null, n.free ? pill("free tier", "ok") : null, n.lockedUntil ? pill("locked", "warn") : null),
        h("div", { class: "muted", style: "font-size:13.5px;margin-top:4px" }, n.expiresAt ? `Expires ${fmtDate(n.expiresAt)} (${daysLeft(n.expiresAt)})` : "Lives with its parent name")),
      toggle), body);
}

function drawPanel(body, n, rec) {
  const sections = {
    records: ["Addresses", () => recordsPanel(n, rec)],
    profile: ["Profile", () => profilePanel(n, rec)],
    ...(n.level === "second" ? { renew: ["Renew", () => renewPanel(n)] } : {}),
    transfer: ["Transfer", () => transferPanel(n)],
    security: ["Security", () => securityPanel(n)],
    subnames: ["Subnames", () => subnamePanel(n)],
  };
  const panel = h("div", { style: "margin-top:18px" });
  const tabBox = h("div");
  const show = (k) => { mount(tabBox, tabs(Object.entries(sections).map(([key, [label]]) => [key, label]), k, show)); mount(panel, sections[k][1]()); };
  mount(body, tabBox, panel);
  show("records");
}

function recordsPanel(n, rec) {
  const node = namehash(n.name);
  const current = Object.fromEntries((rec.records || []).map((r) => [r.network, r.address]));
  const inputs = {};
  const rows = NETWORKS.map((net) => {
    const inp = h("input", { value: current[net.id] || "", placeholder: `${net.name} address`, spellcheck: "false", autocomplete: "off", "aria-label": `${net.name} address` });
    const msg = h("div", { class: "help" });
    const check = () => {
      const v = inp.value.trim();
      inp.removeAttribute("aria-invalid");
      if (!v) { msg.className = "help"; msg.textContent = current[net.id] ? "Will be cleared" : "Not set"; return; }
      const c = validateAddress(net.id, v);
      msg.className = "help " + (c.valid ? "ok" : "bad");
      msg.textContent = c.valid ? `Valid ${c.format}` : c.error;
      if (!c.valid) inp.setAttribute("aria-invalid", "true");
    };
    inp.addEventListener("input", check); check();
    inputs[net.id] = { inp, net };
    const tokens = net.assets.filter((a) => a.standard !== "native").map((a) => `${a.symbol} ${a.standard}`).join(", ");
    return h("div", { class: "row", style: "align-items:flex-start;flex-wrap:nowrap" }, h("div", { style: "width:46px;padding-top:6px" }, coin(net.id, true)),
      h("div", { class: "grow" }, h("div", { style: "font-weight:650;margin-bottom:6px" }, net.name, h("span", { class: "faint", style: "font-weight:400;font-size:12.5px" }, tokens ? `  receives ${net.nativeSymbol}, ${tokens}` : `  receives ${net.nativeSymbol}`)), inp, msg));
  });
  const save = btn("Save changed addresses", async () => {
    const { resolver } = await contracts();
    const calls = [];
    for (const { inp, net } of Object.values(inputs)) {
      const v = inp.value.trim(), before = current[net.id] || "";
      if (v === before) continue;
      if (v) { const c = validateAddress(net.id, v); if (!c.valid) throw new Error(`${net.name}: ${c.error}`); }
      calls.push(resolver.interface.encodeFunctionData("setAddr(bytes32,uint256,bytes)", [node, net.coinType, v ? bytesToHex(encodeAddress(net, v)) : "0x"]));
    }
    if (!calls.length) return toast("No changes to save");
    const tx = calls.length === 1 ? await wallet.signer.sendTransaction({ to: (await contracts()).info.resolver, data: calls[0] }) : await resolver.multicall(calls);
    await tx.wait();
    Object.values(inputs).forEach(({ inp, net }) => (current[net.id] = inp.value.trim()));
    toast(`Saved ${calls.length} address${calls.length > 1 ? "es" : ""}`);
  });
  return h("div", { class: "stack lg" }, alert("info", "Address changes are public and timestamped. Senders see a warning when an address changed in the last 24 hours."), h("div", { class: "stack lg" }, rows), h("div", null, save));
}

function profilePanel(n, rec) {
  const node = namehash(n.name);
  const inputs = Object.fromEntries(TEXT_KEYS.map(([k]) => [k, h("input", { value: rec.profile?.[k] || "", maxlength: 1000 })]));
  const save = btn("Save profile", async () => {
    const { resolver } = await contracts();
    const calls = TEXT_KEYS.filter(([k]) => inputs[k].value !== (rec.profile?.[k] || "")).map(([k]) => resolver.interface.encodeFunctionData("setText", [node, k, inputs[k].value]));
    if (!calls.length) return toast("No changes to save");
    await (await resolver.multicall(calls)).wait();
    toast("Profile saved");
  });
  const primary = btn("Set as my primary name", async () => {
    const { resolver } = await contracts();
    await (await resolver.setPrimaryName(n.name)).wait();
    toast("Primary name set. Reverse lookup now shows this name.");
  }, "ghost");
  return h("div", { class: "stack lg" }, alert("warn", "Profile fields are public on-chain. Registration never needs personal data; add only what you want people to see."),
    h("div", { class: "grid two" }, TEXT_KEYS.map(([k, l]) => field(l, inputs[k]))), h("div", { class: "row" }, save, primary),
    h("div", { class: "help" }, "A primary name must be owned by you or point to your address. The chain re-checks this on every reverse lookup."));
}

function renewPanel(n) {
  const label = n.name.replace(/\.addr$/, "");
  const years = h("select", { "aria-label": "Years" }, [1, 2, 3, 4, 5].map((y) => h("option", { value: y }, `${y} year${y > 1 ? "s" : ""}`)));
  const info = h("div", { class: "muted" }, "Checking price...");
  (async () => { const { registrar } = await contracts(false); const p = await registrar.renewalPriceFor(label); info.textContent = p === 0n ? "Free-tier names renew at no cost. You pay only network gas." : `$${Number(p) / 1e6} per year. Total term can never exceed 5 years from today.`; })().catch(() => (info.textContent = ""));
  const go = btn("Renew", async () => {
    const { registrar } = await contracts();
    const p = await registrar.renewalPriceFor(label), y = Number(years.value);
    const value = p > 0n ? ((await registrar.ethForUsd(p * BigInt(y))) * 1005n) / 1000n : 0n;
    await (await registrar.renew(label, y, ethers.ZeroAddress, { value })).wait();
    toast("Renewed");
  });
  return h("div", { class: "stack" }, info, h("div", { class: "row" }, h("div", { style: "width:160px" }, years), go),
    h("div", { class: "help" }, "Paying in BTC, LTC, SOL, TRX or other stablecoins? Create a renewal invoice with kind \"renew\" through the API."));
}

function transferPanel(n) {
  const node = namehash(n.name);
  const to = h("input", { placeholder: "0x new owner", spellcheck: "false", autocomplete: "off" });
  const go = btn("Transfer ownership", async () => {
    if (!ethers.isAddress(to.value)) throw new Error("Enter a valid EVM address");
    if (!(await confirmDialog("Transfer this name?", `${n.name} will belong to ${to.value}. They get full control and you lose it.`, "Transfer", true))) return;
    const { registry } = await contracts();
    await (await registry.transfer(node, ethers.getAddress(to.value))).wait();
    toast("Transferred");
    history.go(0);
  }, "danger");
  const op = h("input", { placeholder: "0x operator, e.g. your platform relayer", spellcheck: "false", autocomplete: "off" });
  const mk = (label, v, cls) => btn(label, async () => {
    if (!ethers.isAddress(op.value)) throw new Error("Enter a valid EVM address");
    const { registry } = await contracts();
    await (await registry.approveName(node, ethers.getAddress(op.value), v)).wait();
    toast(v ? "Operator approved" : "Operator revoked");
  }, cls);
  return h("div", { class: "stack lg" },
    h("div", { class: "stack" }, h("h3", null, "Transfer"), field("New owner", to), h("div", null, go)),
    h("div", { class: "divider", style: "margin:4px 0" }),
    h("div", { class: "stack" }, h("h3", null, "Operators"), h("p", { class: "muted", style: "margin:0" }, "An approved operator can edit addresses and create subnames for this one name. It can never transfer the name."), field("Operator address", op), h("div", { class: "row" }, mk("Approve operator", true, ""), mk("Revoke", false, "ghost"))));
}

function securityPanel(n) {
  const node = namehash(n.name);
  const days = h("input", { type: "number", min: 1, max: 1460, value: 30 });
  const lock = btn("Lock transfers", async () => {
    const { registry } = await contracts();
    await (await registry.lock(node, Math.floor(Date.now() / 1000) + Number(days.value) * 86400)).wait();
    toast("Locked. A lock can be extended but never shortened.");
  });
  const guardian = h("input", { placeholder: "0x guardian wallet or contract", spellcheck: "false" });
  const delay = h("input", { type: "number", min: 3, value: 7 });
  const set = btn("Save recovery policy", async () => {
    if (!ethers.isAddress(guardian.value)) throw new Error("Enter a valid guardian address");
    const { registry } = await contracts();
    await (await registry.setRecovery(node, ethers.getAddress(guardian.value), BigInt(Number(delay.value) * 86400))).wait();
    toast("Recovery policy saved");
  });
  const rm = btn("Remove guardian", async () => { const { registry } = await contracts(); await (await registry.setRecovery(node, ethers.ZeroAddress, 0)).wait(); toast("Guardian removed"); }, "ghost");
  const cancel = btn("Cancel pending recovery", async () => { const { registry } = await contracts(); await (await registry.cancelRecovery(node)).wait(); toast("Recovery cancelled"); }, "ghost");
  return h("div", { class: "stack lg" },
    h("div", { class: "stack" }, h("h3", null, "Transfer lock"), h("p", { class: "muted", style: "margin:0" }, "Blocks every transfer until the date. Useful against a compromised operator."), h("div", { class: "row" }, h("div", { style: "width:140px" }, field("Days", days)), h("div", { style: "align-self:flex-end" }, lock))),
    h("div", { class: "divider", style: "margin:4px 0" }),
    h("div", { class: "stack" }, h("h3", null, "Guardian recovery"), alert("info", "There is no automatic recovery. A guardian can start a recovery that completes only after your delay, and you can cancel it with your current key at any time. Minimum delay 3 days."),
      h("div", { class: "grid two" }, field("Guardian", guardian), field("Delay (days)", delay)), h("div", { class: "row" }, set, rm, cancel)));
}

function subnamePanel(n) {
  const label = h("input", { placeholder: "shop" });
  const owner = h("input", { placeholder: "0x owner (default: you)", spellcheck: "false" });
  const eth = h("input", { placeholder: "optional Ethereum address record", spellcheck: "false" });
  const go = btn("Create subname", async () => {
    const { registry, resolver, info } = await contracts();
    const ow = owner.value.trim() || wallet.address;
    if (!ethers.isAddress(ow)) throw new Error("Invalid owner address");
    const l = label.value.trim().toLowerCase();
    const node = namehash(`${l}.${n.name}`);
    const calls = [];
    if (eth.value.trim()) { if (!validateAddress("ethereum", eth.value.trim()).valid) throw new Error("Invalid Ethereum address"); calls.push(resolver.interface.encodeFunctionData("setAddr(bytes32,address)", [node, eth.value.trim()])); }
    await (await registry.createSubname(namehash(n.name), l, ethers.getAddress(ow), info.resolver, calls)).wait();
    toast(`Created ${l}.${n.name}`);
  });
  return h("div", { class: "stack" }, h("p", { class: "muted", style: "margin:0" }, "Subnames live and expire with this name. The subname owner can later make it sovereign so you cannot remove it."),
    h("div", { class: "grid" }, field("Label", label), field("Owner", owner), field("Ethereum record", eth)), h("div", null, go));
}
void statusPill; void copyLine; void link; void requireWallet;
