import { ethers } from "ethers";
import { h, mount, icon, btn, field, alert, api, coin, pill, statusPill, kv, steps, skeleton, fmtDate, loadChain, sleep, toast, run, navigate, copyLine } from "./lib.js";
import { wallet, contracts, requireWallet, isConnected, explorerTx } from "./wallet.js";
import { NETWORKS } from "../../packages/core/src/index.ts";

const EXAMPLES = ["heelo", "alice", "studio", "wallet1", "satoshi"];

export async function home(root) {
  const input = h("input", { placeholder: "Search a name", autocomplete: "off", spellcheck: "false", autocapitalize: "off", "aria-label": "Name to search", maxlength: 63 });
  const results = h("div");
  const pricing = h("div");
  mount(root,
    h("section", { class: "hero" },
      h("div", { class: "eyebrow" }, icon("bolt", 15), "Open protocol for human-readable crypto addresses"),
      h("h1", null, "Your name is your ", h("span", { class: "grad" }, "address.")),
      h("p", { class: "lead" }, "One readable name for Bitcoin, Ethereum, Solana, TRON, Litecoin and USDT. Get yours free, send to names instead of 42 character strings, and let any app resolve them."),
      h("div", { class: "searchbar" }, icon("search", 22), input, h("span", { class: "suffix" }, ".addr")),
      h("div", { class: "suggest" }, h("span", { class: "faint", style: "padding:6px 0" }, "Try"), EXAMPLES.map((e) => h("button", { class: "chip", type: "button", onclick: () => { input.value = e; input.dispatchEvent(new Event("input")); } }, e))),
      results),
    h("section", { class: "stack lg" },
      h("div", { class: "page-head center", style: "margin-top:40px" }, h("h2", { style: "margin:0 0 8px;font-size:30px" }, "One name, every chain"), h("p", { style: "margin:0 auto" }, "Pick the network and asset when you send. USDT and USDC always require an explicit network so funds never go to the wrong chain.")),
      exampleBox(),
      h("div", { class: "grid four" }, NETWORKS.map((n) => h("div", { class: "card tight hover" }, h("div", { class: "net-card" }, coin(n.id, true),
        h("div", null, h("div", { style: "font-weight:650" }, n.name), h("div", { class: "muted", style: "font-size:13px" }, n.assets.map((a) => (a.standard === "native" ? a.symbol : `${a.symbol} ${a.standard}`)).join(", "))))))),
      h("h2", { class: "center", style: "margin-top:56px" }, "How it works"),
      h("div", { class: "howto" },
        h("div", { class: "card" }, h("h3", null, "Claim a name"), h("p", { class: "muted" }, "Register in one transaction. Five or more characters are free for your first name; shorter names are priced by length.")),
        h("div", { class: "card" }, h("h3", null, "Link your addresses"), h("p", { class: "muted" }, "Attach a deposit address for each network. Records are public, versioned and timestamped on-chain.")),
        h("div", { class: "card" }, h("h3", null, "Get paid by name"), h("p", { class: "muted" }, "Share name.addr or a request link. Senders see network, asset and address together and are warned about changes."))),
      h("div", { class: "grid", style: "margin-top:24px" },
        feature("shield", "You hold the name", "Ownership lives in a contract. No admin can reassign a live name, and recovery is opt-in with a delay you control."),
        feature("globe", "Built for integrations", "Free REST API, TypeScript SDK, React hook and a trustless on-chain resolver. Wallets can resolve without our servers."),
        feature("lock", "Safer sending", "Look-alike detection, network mismatch checks, change history and a 24 hour change warning before every send."),
        feature("layers", "Issue names to customers", "Platforms mint subnames like alice.wallet.addr with deposit addresses attached. Customers keep ownership.")),
      h("h2", { class: "center", style: "margin-top:56px" }, "Simple pricing"), pricing,
      h("div", { class: "card soft center", style: "margin-top:40px;padding:36px" },
        h("h2", { style: "margin:0 0 8px" }, "Build with ADDR"), h("p", { class: "muted", style: "margin:0 auto 20px;max-width:520px" }, "Sign in with your email to get API keys, usage analytics and the enterprise issuing console."),
        h("div", { class: "row", style: "justify-content:center" }, h("a", { class: "btn", href: "/dev" }, "Open developer console"), h("a", { class: "btn ghost", href: "/docs/", target: "_blank", rel: "noopener" }, "Read the specification")))));

  loadPricing(pricing);
  let timer, seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim().toLowerCase().replace(/\.addr$/, "");
    if (!q) { mount(results); return; }
    mount(results, h("div", { class: "card result-card" }, skeleton(3)));
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await api("GET", `/v1/search?q=${encodeURIComponent(q)}${wallet.address ? `&owner=${wallet.address}` : ""}`);
        if (my === seq) mount(results, renderResult(r));
      } catch (e) { if (my === seq) mount(results, h("div", { class: "result-card" }, alert("bad", e.message))); }
    }, 280);
  });
  input.focus();
}

function feature(ic, title, text) {
  return h("div", { class: "card feature hover" }, h("div", { class: "ico" }, icon(ic, 22)), h("h3", { style: "margin:4px 0 0" }, title), h("p", null, text));
}

function exampleBox() {
  const rows = [["bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"], ["ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7"], ["tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"], ["solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]];
  return h("div", { class: "card example-box" },
    h("div", { class: "row between", style: "margin-bottom:6px" }, h("div", { style: "font-size:22px;font-weight:750;letter-spacing:-.02em" }, "heelo.addr"), pill("example", "info")),
    rows.map(([n, a]) => h("div", { class: "example-line" }, coin(n), h("div", { style: "min-width:92px;font-weight:600;text-transform:capitalize" }, n), h("div", { class: "a" }, a))));
}

async function loadPricing(box) {
  try {
    const p = await api("GET", "/v1/pricing");
    const fmt = (n) => (n === 0 ? "Free" : `$${n}`);
    const t = p.tiers;
    mount(box, h("div", { class: "grid two" },
      h("div", { class: "card" }, h("h3", null, "Names"), h("div", { class: "table-wrap", style: "border:0" }, h("table", { class: "price-table" }, h("tbody", null,
        h("tr", null, h("td", null, "5+ characters"), h("td", null, "First name free (1 per wallet)"), h("td", { class: "right" }, "renewals free")),
        h("tr", null, h("td", null, "5+ extra names"), h("td", null, "per year"), h("td", { class: "right" }, fmt(t["5+ (additional)"].usdPerYear))),
        h("tr", null, h("td", null, "4 characters"), h("td", null, "per year"), h("td", { class: "right" }, fmt(t["4"].usdPerYear))),
        h("tr", null, h("td", null, "3 characters"), h("td", null, "per year"), h("td", { class: "right" }, fmt(t["3"].usdPerYear))),
        h("tr", null, h("td", null, "2 characters"), h("td", null, "per year"), h("td", { class: "right" }, fmt(t["2"].usdPerYear))),
        h("tr", null, h("td", null, "1 character"), h("td", null, "reserved for later"), h("td", { class: "right" }, t["1"].enabled ? fmt(t["1"].usdPerYear) : "Closed")))))),
      h("div", { class: "card" }, h("h3", null, "Developer plans"), h("div", { class: "table-wrap", style: "border:0" }, h("table", { class: "price-table" }, h("tbody", null,
        p.plans.map((pl) => h("tr", null, h("td", null, pl.name), h("td", null, pl.dailyRequests ? `${pl.dailyRequests.toLocaleString()} requests/day` : "Custom"), h("td", { class: "right" }, pl.priceKrwPerMonth ? `KRW ${pl.priceKrwPerMonth.toLocaleString()}/mo` : pl.id === "enterprise" ? "Contact" : "Free")))))))),
      h("p", { class: "muted center", style: "margin-top:14px" }, "Pay in ETH or stablecoins on the registry chain, or in BTC, LTC, SOL, TRX and more from any wallet. Prices are read from the contract."));
  } catch { mount(box, h("p", { class: "muted center" }, "Pricing unavailable.")); }
}

function renderResult(r) {
  if (!r.valid) {
    return h("div", { class: "result-card" }, alert("warn", "Names use lowercase letters a-z, digits and single hyphens (not at the ends), 1 to 63 characters. No spaces or symbols."));
  }
  const x = r.exact;
  const card = h("div", { class: "card result-card" });
  card.append(h("div", { class: "row between" },
    h("div", { style: "font-size:26px;font-weight:750;letter-spacing:-.02em;word-break:break-all" }, x.name), x.reserved ? pill("reserved", "warn", true) : statusPill(x.available ? "available" : x.status)));
  if (x.reserved) card.append(h("div", { style: "margin-top:14px" }, alert("warn", "This name is reserved by the protocol for system use.")));
  else if (!x.available) {
    card.append(h("div", { style: "margin-top:14px" }, kv([["Owner", h("span", { class: "mono" }, x.owner || "-")], ["Expires", fmtDate(x.expiresAt)], x.status === "grace" ? ["Public again", fmtDate(x.gracePeriodEndsAt)] : null])),
      h("div", { class: "row", style: "margin-top:16px" }, h("a", { class: "btn secondary", href: `/name/${x.name}` }, "View profile"), h("a", { class: "btn ghost", href: `/send?to=${x.name}` }, "Send to this name")));
  } else if (!x.price.available) {
    card.append(h("div", { style: "margin-top:14px" }, alert("bad", "Names of this length are not open for registration yet.")));
  } else {
    card.append(h("div", { style: "margin:16px 0" }, h("div", { class: "price-big" }, x.price.free ? "Free" : `$${x.price.usdPerYear}`, h("span", { class: "muted", style: "font-size:15px;font-weight:500" }, x.price.free ? " for your first 5+ character name" : " per year")),
      h("div", { class: "muted", style: "font-size:14px;margin-top:4px" }, x.premium ? "Premium name." : x.price.free ? "1 year, renewals are free. One free name per wallet." : "Renewal price equals registration price.")),
      registerPanel(x));
  }
  const wrap = h("div", { class: "stack" }, card);
  if (r.lookalikes?.length) {
    wrap.append(alert("warn", h("b", null, "Look-alike names exist: "), r.lookalikes.map((l) => h("a", { href: `/name/${l.name}`, style: "margin-right:12px" }, `${l.name} (${l.reason})`)),
      h("div", { class: "muted", style: "margin-top:4px" }, "Look-alikes are a common phishing trick. Always verify the exact spelling before sending funds.")));
  }
  if (r.matches?.length > 1 || (r.matches?.length === 1 && r.matches[0].name !== x.name)) {
    wrap.append(h("div", { class: "card tight" }, h("h3", null, "Registered names starting with this"), h("div", { class: "row tight" }, r.matches.slice(0, 12).map((m) => h("a", { class: "chip", href: `/name/${m.name}` }, m.name)))));
  }
  return h("div", { class: "result-card stack", style: "margin-top:26px" }, wrap);
}

function registerPanel(x) {
  const label = x.name.replace(/\.addr$/, "");
  const years = h("select", { "aria-label": "Duration" }, [1, 2, 3, 4, 5].map((y) => h("option", { value: y }, `${y} year${y > 1 ? "s" : ""}`)));
  const payment = h("select", { "aria-label": "Payment method" });
  const stepsBox = h("div");
  const out = h("div");
  (async () => {
    const methods = await api("GET", "/v1/payments/methods").catch(() => ({ methods: [] }));
    const c = await loadChain();
    if (x.price.free) { payment.append(h("option", { value: "free" }, "Free tier")); years.disabled = true; payment.disabled = true; }
    payment.append(h("option", { value: "eth" }, `${c.chain.currency} on ${c.chain.name} (wallet)`));
    for (const [sym, addr] of Object.entries(c.acceptedTokens || {})) if (addr) payment.append(h("option", { value: `token:${addr}` }, `${sym} on ${c.chain.name} (wallet)`));
    for (const m of methods.methods) payment.append(h("option", { value: `coin:${m.network}:${m.asset}:${m.standard}` }, `${m.asset}${m.standard !== "native" ? " " + m.standard : ""} on ${m.networkName} (pay from any wallet)`));
    if (x.price.free) payment.value = "free";
  })();

  const go = btn(x.price.free ? "Claim free name" : "Register", async () => {
    mount(out);
    if (!(await requireWallet())) return;
    const mode = payment.value, yrs = Number(years.value), owner = wallet.address;
    if (mode.startsWith("coin:")) {
      const [, network, asset, standard] = mode.split(":");
      const inv = await api("POST", "/v1/invoices", { label, owner, years: yrs, network, asset, standard });
      navigate(`/invoice/${inv.id}`);
      return;
    }
    const { registrar, info, erc20 } = await contracts();
    const free = mode === "free";
    let voucher = { deadline: 0, signature: "0x" };
    const names = free ? ["Prepare", "Commit", "Wait", "Register"] : ["Prepare", "Commit", "Wait", "Register"];
    mount(stepsBox, steps(names, 0));
    if (free) voucher = await api("POST", "/v1/free-claims", { label, owner });
    let value = 0n, token = ethers.ZeroAddress;
    if (!free) {
      const [perYear] = await registrar.priceFor(label, owner);
      const usd = perYear * BigInt(yrs);
      if (mode === "eth") value = ((await registrar.ethForUsd(usd)) * 1005n) / 1000n; // 0.5% buffer, excess refunded by the contract
      else {
        token = mode.slice(6);
        const amount = await registrar.tokenForUsd(token, usd);
        const t = erc20(token);
        if ((await t.balanceOf(owner)) < amount) throw new Error("Insufficient token balance");
        if ((await t.allowance(owner, info.registrar)) < amount) { toast("Approve the token spend first"); await (await t.approve(info.registrar, amount)).wait(); }
      }
    }
    const secret = ethers.hexlify(ethers.randomBytes(32));
    mount(stepsBox, steps(names, 1));
    await (await registrar.commit(await registrar.makeCommitment(label, owner, secret))).wait();
    mount(stepsBox, steps(names, 2));
    const wait = Number(await registrar.minCommitmentAge()) + 2;
    for (let s = wait; s > 0; s--) { mount(out, h("div", { class: "muted" }, `Waiting ${s}s. This short delay prevents others from front-running your name.`)); await sleep(1000); }
    mount(out);
    mount(stepsBox, steps(names, 3));
    const rc = await (await registrar.register({ label, owner, years_: yrs, token, secret, deadline: voucher.deadline, voucher: voucher.signature }, { value })).wait();
    mount(stepsBox, steps(names, 4));
    const l = explorerTx(info, rc.hash);
    mount(out, alert("ok", h("b", null, `${x.name} is yours.`), " ", l ? h("a", { href: l, target: "_blank", rel: "noopener" }, "View transaction") : h("span", { class: "mono" }, rc.hash),
      h("div", { style: "margin-top:8px" }, h("a", { class: "btn small", href: "/names" }, "Add your addresses"))));
    toast(`${x.name} registered`);
  }, "large");

  return h("div", { class: "stack" },
    h("div", { class: "row" }, h("div", { class: "grow" }, field("Duration", years)), h("div", { class: "grow", style: "flex:2" }, field("Payment", payment))),
    h("div", { class: "row" }, go, h("span", { class: "muted help" }, isConnected() ? `Owner: ${wallet.address}` : "You will be asked to connect a wallet. The name is owned by that address.")),
    stepsBox, out);
}
void run; void copyLine;
