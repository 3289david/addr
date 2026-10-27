import { ethers } from "ethers";
import { h, mount, icon, btn, field, alert, api, coin, pill, statusPill, kv, steps, skeleton, fmtDate, loadChain, sleep, toast, run, navigate, copyLine } from "./lib.js";
import { wallet, contracts, requireWallet, isConnected, explorerTx } from "./wallet.js";
import { NETWORKS } from "../../packages/core/src/index.ts";

const EXAMPLES = ["heelo", "alice", "studio", "wallet1"];

export async function home(root) {
  const input = h("input", { placeholder: "Search a name", autocomplete: "off", spellcheck: "false", autocapitalize: "off", "aria-label": "Name to search", maxlength: 63 });
  const results = h("div");
  const pricing = h("div");
  const sec = (title, sub, body) => h("section", { class: "l-sec" }, h("header", null, h("h2", null, title), sub ? h("p", null, sub) : null), h("div", null, body));
  mount(root,
    h("section", { class: "l-hero" },
      h("div", null,
        h("h1", null, "Send to a name, not a 42-character address."),
        h("p", { class: "lead" }, "A .addr name points to the Bitcoin, Ethereum, Solana, TRON and Litecoin addresses its owner chose. Names with five or more characters are free, one per wallet."),
        h("div", { class: "searchbar" }, icon("search", 20), input, h("span", { class: "suffix" }, ".addr")),
        h("div", { class: "suggest" }, h("span", { class: "faint", style: "padding:6px 0" }, "Try"), EXAMPLES.map((e) => h("button", { class: "chip", type: "button", onclick: () => { input.value = e; input.dispatchEvent(new Event("input")); } }, e))),
        h("div", { class: "fine" }, "No signup needed to search or send. You only connect a wallet to register or change records.")),
      demoCard()),
    results,
    sec("How it works", null, h("div", { class: "cols3" },
      h("div", null, h("span", { class: "no" }, "01"), h("h3", null, "Register"), h("p", null, "One transaction from your wallet. You own the name from the first block; ADDR cannot reassign it.")),
      h("div", null, h("span", { class: "no" }, "02"), h("h3", null, "Add addresses"), h("p", null, "Set a receiving address per network. Each change is public, timestamped and numbered.")),
      h("div", null, h("span", { class: "no" }, "03"), h("h3", null, "Get paid by name"), h("p", null, "People type heelo.addr, pick the network and see the address before they confirm in their own wallet.")))),
    sec("Networks", "USDT and USDC are never resolved without a network.", networkTable()),
    sec("Checks before you send", null, h("ul", { class: "plain-list" },
      h("li", null, h("b", null, "Look-alike names. "), "Search shows names that are visually close (paypa1 and paypal) next to the one you typed."),
      h("li", null, h("b", null, "Recent changes. "), "If the address changed in the last 24 hours, or differs from the one you used before, you must tick a box to continue."),
      h("li", null, h("b", null, "Network and token. "), "USDT on TRON is not USDT on Ethereum. The standard (TRC20, ERC20, SPL) is shown on every confirmation."),
      h("li", null, h("b", null, "Expired names. "), "Expired names stop resolving, so money cannot be sent to an address nobody maintains."),
      h("li", null, h("b", null, "What \"verified\" means. "), "The address is well-formed and read from the chain for an active name. It does not prove who the recipient is."))),
    sec("For developers", "Free API. Wallets can also read the chain directly.", h("div", { class: "cols2" },
      h("div", null, h("h3", null, "REST, SDK, CLI"), h("p", null, "Sign in with your email to get API keys and usage numbers. The TypeScript SDK also resolves straight from the contracts, with no ADDR server in the path."),
        h("div", { class: "row", style: "margin-top:16px" }, h("a", { class: "btn", href: "/dev" }, "Developer console"), h("a", { class: "btn ghost", href: "/docs/", target: "_blank", rel: "noopener" }, "Specification"))),
      h("pre", null, "GET /v1/names/heelo.addr/resolve\n      ?network=tron&asset=USDT&standard=TRC20\n\n{\n  \"address\": \"TR7NHqje...\",\n  \"tokenContract\": \"TR7NHqje...\",\n  \"verified\": true,\n  \"recentlyChanged\": false,\n  \"version\": 3\n}"))),
    sec("Prices", "Read from the registrar contract.", pricing),
    sec("Questions", null, h("div", null,
      faq("Is it really free?", "Your first name of five or more characters costs nothing and renews for free. Shorter names, and extra names, are priced by length. You pay network fees for the transactions."),
      faq("Who owns the name?", "The address that registered it, recorded in the registry contract. We cannot take or edit a live name. Prices and reserved words change only through a public timelock."),
      faq("What if I lose my key?", "There is no automatic recovery. You can pre-set a guardian who can start a recovery that completes after a delay you choose, and that you can cancel while you still have your key."),
      faq("Which wallets understand .addr?", "Not many yet. Resolution is open (API, SDK, contracts), but each wallet has to add it. Until then use the Send page or copy the resolved address."),
      faq("Is my email public?", "No. Email is only used to sign in to the developer console. Names and address records are public on-chain, and registering needs no personal data."),
      faq("Can I pay in Bitcoin or Solana?", "Registration is paid on the registry chain with ETH or stablecoins, or with BTC, LTC, SOL, TRX and others through an invoice, if the operator enabled that network."))));

  loadPricing(pricing);
  let timer, seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim().toLowerCase().replace(/\.addr$/, "");
    if (!q) { mount(results); return; }
    mount(results, h("div", { class: "card", style: "margin-bottom:24px" }, skeleton(3)));
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await api("GET", `/v1/search?q=${encodeURIComponent(q)}${wallet.address ? `&owner=${wallet.address}` : ""}`);
        if (my === seq) mount(results, renderResult(r));
      } catch (e) { if (my === seq) mount(results, alert("bad", e.message)); }
    }, 280);
  });
  input.focus();
}

function faq(q, a) { return h("details", { class: "q" }, h("summary", null, q), h("p", null, a)); }

function demoCard() {
  const rows = [["bitcoin", "Bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"], ["ethereum", "Ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7"], ["tron", "TRON", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"], ["solana", "Solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]];
  return h("div", { class: "demo", "aria-label": "Example of a resolved name" },
    h("div", { class: "demo-head" }, h("b", null, "heelo.addr"), h("span", null, "example record")),
    rows.map(([id, label, a]) => h("div", { class: "demo-row" }, coin(id), h("span", { class: "n" }, label), h("span", { class: "a" }, a))),
    h("div", { class: "demo-foot" }, "Each lookup reads these from the registry and resolver contracts."));
}

function networkTable() {
  return h("div", { class: "table-wrap" }, h("table", null, h("thead", null, h("tr", null, ["Network", "Assets", "Address format"].map((x) => h("th", null, x)))),
    h("tbody", null, NETWORKS.map((n) => h("tr", null, h("td", null, h("span", { class: "row tight" }, coin(n.id), n.name)), h("td", null, n.assets.map((a) => (a.standard === "native" ? a.symbol : `${a.symbol} ${a.standard}`)).join(", ")),
      h("td", { class: "muted" }, { btc: "Base58 / Bech32 / Taproot", ltc: "Base58 / Bech32", evm: "EIP-55 checksum", tron: "Base58Check (T...)", solana: "Base58 public key" }[n.family]))))));
}

async function loadPricing(box) {
  try {
    const p = await api("GET", "/v1/pricing");
    const fmt = (n) => (n === 0 ? "Free" : `$${n}`);
    const t = p.tiers;
    mount(box, h("div", { class: "cols2" },
      h("div", { class: "table-wrap" }, h("table", { class: "price-table" }, h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, ""), h("th", { class: "right" }, "Per year"))), h("tbody", null,
        h("tr", null, h("td", null, "5+ characters"), h("td", { class: "muted" }, "first name per wallet, renewals free"), h("td", { class: "right" }, "Free")),
        h("tr", null, h("td", null, "5+ characters"), h("td", { class: "muted" }, "additional names"), h("td", { class: "right" }, fmt(t["5+ (additional)"].usdPerYear))),
        h("tr", null, h("td", null, "4 characters"), h("td", null, ""), h("td", { class: "right" }, fmt(t["4"].usdPerYear))),
        h("tr", null, h("td", null, "3 characters"), h("td", null, ""), h("td", { class: "right" }, fmt(t["3"].usdPerYear))),
        h("tr", null, h("td", null, "2 characters"), h("td", null, ""), h("td", { class: "right" }, fmt(t["2"].usdPerYear))),
        h("tr", null, h("td", null, "1 character"), h("td", { class: "muted" }, "not open"), h("td", { class: "right" }, t["1"].enabled ? fmt(t["1"].usdPerYear) : "-"))))),
      h("div", { class: "table-wrap" }, h("table", { class: "price-table" }, h("thead", null, h("tr", null, h("th", null, "API plan"), h("th", null, "Requests"), h("th", { class: "right" }, "Per month"))), h("tbody", null,
        p.plans.map((pl) => h("tr", null, h("td", null, pl.name), h("td", { class: "muted" }, pl.dailyRequests ? `${pl.dailyRequests.toLocaleString()} / day` : "negotiated"), h("td", { class: "right" }, pl.priceUsdPerMonth ? `$${pl.priceUsdPerMonth.toLocaleString()}` : pl.id === "enterprise" ? "quote" : "Free"))))))));
  } catch { mount(box, h("p", { class: "muted" }, "Pricing is unavailable right now.")); }
}

function renderResult(r) {
  if (!r.valid) {
    return h("div", { style: "margin-bottom:24px" }, alert("warn", "Names use lowercase letters a-z, digits and single hyphens (not at the ends), 1 to 63 characters. No spaces or symbols."));
  }
  const x = r.exact;
  const card = h("div", { class: "card" });
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
  return h("div", { class: "stack", style: "margin:8px 0 36px;max-width:820px" }, wrap);
}

function registerPanel(x) {
  const label = x.name.replace(/\.addr$/, "");
  const years = h("select", { "aria-label": "Duration" }, [1, 2, 3, 4, 5].map((y) => h("option", { value: y }, `${y} year${y > 1 ? "s" : ""}`)));
  const payment = h("select", { "aria-label": "Payment method" });
  const stepsBox = h("div");
  const out = h("div");
  if (x.price.free) {
    payment.append(h("option", { value: "sponsored" }, "Free — 100% gas covered by Gasless Relayer"));
    years.disabled = true;
    payment.disabled = true;
    payment.value = "sponsored";
  }
  (async () => {
    if (x.price.free) return;
    const methods = await api("GET", "/v1/payments/methods").catch(() => ({ methods: [] }));
    const c = await loadChain();
    payment.append(h("option", { value: "eth" }, `${c.chain.currency} on ${c.chain.name} (wallet)`));
    for (const [sym, addr] of Object.entries(c.acceptedTokens || {})) if (addr) payment.append(h("option", { value: `token:${addr}` }, `${sym} on ${c.chain.name} (wallet)`));
    for (const m of methods.methods) payment.append(h("option", { value: `coin:${m.network}:${m.asset}:${m.standard}` }, `${m.asset}${m.standard !== "native" ? " " + m.standard : ""} on ${m.networkName} (pay from any wallet)`));
  })();

  const go = btn(x.price.free ? "Claim free name (100% gas-free)" : "Register", async () => {
    mount(out);
    if (!(await requireWallet())) return;
    const mode = x.price.free ? "sponsored" : payment.value, yrs = Number(years.value), owner = wallet.address;
    if (mode.startsWith("coin:")) {
      const [, network, asset, standard] = mode.split(":");
      const inv = await api("POST", "/v1/invoices", { label, owner, years: yrs, network, asset, standard });
      navigate(`/invoice/${inv.id}`);
      return;
    }
    if (mode === "sponsored") {
      const names = ["Sign (free)", "Commit", "Wait", "Register"];
      mount(stepsBox, steps(names, 0));
      const { message } = await api("GET", `/v1/free-claims/sponsor-message?label=${encodeURIComponent(label)}&owner=${owner}`);
      const signature = await wallet.signer.signMessage(message);
      mount(stepsBox, steps(names, 1));
      let claim = await api("POST", "/v1/free-claims/sponsored", { label, owner, signature });
      while (claim.status !== "completed" && claim.status !== "failed") {
        if (claim.status === "committed") {
          mount(stepsBox, steps(names, 2));
          const waitLeft = Math.max(0, (claim.readyAt || 0) - Math.floor(Date.now() / 1000));
          mount(out, h("div", { class: "muted" }, waitLeft > 0 ? `Waiting ${waitLeft}s for the commit-reveal delay (prevents front-running)...` : "Finishing up..."));
        } else if (claim.status === "registering") {
          mount(stepsBox, steps(names, 3));
          mount(out, h("div", { class: "muted" }, "Registering (we're paying the gas)..."));
        }
        await sleep(2000);
        claim = await api("GET", `/v1/free-claims/sponsored/${claim.id}`);
      }
      mount(out);
      if (claim.status === "failed") { mount(out, alert("bad", claim.error || "Sponsored claim failed. Please try again.")); return; }
      mount(stepsBox, steps(names, 4));
      const { info } = await contracts(false);
      const l = explorerTx(info, claim.registerTx);
      mount(out, alert("ok", h("b", null, `${x.name} is yours.`), " You paid nothing — we covered the gas. ", l ? h("a", { href: l, target: "_blank", rel: "noopener" }, "View transaction") : h("span", { class: "mono" }, claim.registerTx),
        h("div", { style: "margin-top:8px" }, h("a", { class: "btn small", href: "/names" }, "Add your addresses"))));
      toast(`${x.name} registered — gas-free`);
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
    h("div", { class: "help" }, "By registering you accept the ", h("a", { href: "/legal/terms" }, "Terms"), " and ", h("a", { href: "/legal/refunds" }, "refund policy"), ". Registrations are recorded on a blockchain and cannot be reversed."),
    stepsBox, out);
}
void run; void copyLine;
