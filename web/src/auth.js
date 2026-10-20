// Email sign-in UI (passwordless: one-time code or confirmed link) and the login gate for protected pages.
import { h, mount, icon, btn, field, alert, api, auth, loadAuth, navigate, query, toast, sleep, run } from "./lib.js";

const safeNext = (n) => (n && /^\/[a-zA-Z0-9/_\-.]*$/.test(n) && !n.startsWith("//") ? n : "/dev");

export function loginView(next = "/dev", reason) {
  const root = h("div", { class: "auth-wrap" });
  let email = "";
  const stepEmail = () => {
    const input = h("input", { type: "email", placeholder: "you@example.com", autocomplete: "email", inputmode: "email", required: true, "aria-label": "Email address" });
    const err = h("div", { class: "bad help", role: "alert" });
    const go = btn("Email me a sign-in code", async () => {
      err.textContent = "";
      const v = input.value.trim();
      if (!v) { err.textContent = "Enter your email address."; input.focus(); return; }
      try {
        const r = await api("POST", "/v1/auth/email", { email: v, next });
        email = v.toLowerCase();
        stepCode(r);
      } catch (e) { err.textContent = e.message; }
    }, "block large");
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    mount(root, h("div", { class: "card" }, h("div", { class: "stack lg" },
      h("div", null, h("div", { class: "avatar", style: "margin-bottom:18px" }, icon("mail", 28)),
        h("h1", { style: "font-size:28px;margin:0 0 6px;letter-spacing:-.02em" }, "Sign in or create an account"),
        h("p", { class: "muted", style: "margin:0" }, reason || "Enter your email. We send a one-time code. No password, and no account yet? One is created for you.")),
      field("Email", input), err, go,
      h("div", { class: "help" }, "Open to everyone. We only use your email to sign you in."))));
    setTimeout(() => input.focus(), 50);
  };

  const stepCode = (sent) => {
    const cells = Array.from({ length: 6 }, (_, i) => h("input", { inputmode: "numeric", maxlength: "1", autocomplete: i === 0 ? "one-time-code" : "off", "aria-label": `Digit ${i + 1}` }));
    const err = h("div", { class: "bad help", role: "alert" });
    const resend = h("button", { class: "btn ghost small", type: "button" }, "Resend code");
    let submitting = false;
    const code = () => cells.map((c) => c.value).join("");
    const submit = async () => {
      if (submitting || code().length !== 6) return;
      submitting = true; err.textContent = "";
      try {
        await api("POST", "/v1/auth/verify", { email, code: code() });
        await loadAuth();
        toast(auth.user ? `Signed in as ${auth.user.email}` : "Signed in");
        navigate(safeNext(next), true);
      } catch (e) {
        err.textContent = e.message; cells.forEach((c) => (c.value = "")); cells[0].focus();
      } finally { submitting = false; }
    };
    cells.forEach((c, i) => {
      c.addEventListener("input", () => { c.value = c.value.replace(/\D/g, "").slice(-1); if (c.value && i < 5) cells[i + 1].focus(); if (code().length === 6) submit(); });
      c.addEventListener("keydown", (e) => { if (e.key === "Backspace" && !c.value && i > 0) cells[i - 1].focus(); if (e.key === "ArrowLeft" && i > 0) cells[i - 1].focus(); if (e.key === "ArrowRight" && i < 5) cells[i + 1].focus(); });
      c.addEventListener("paste", (e) => { const t = (e.clipboardData?.getData("text") || "").replace(/\D/g, "").slice(0, 6); if (!t) return; e.preventDefault(); [...t].forEach((d, k) => (cells[k].value = d)); (cells[Math.min(t.length, 5)]).focus(); if (t.length === 6) submit(); });
    });
    let left = 30;
    const tick = async () => { resend.disabled = true; for (left = 30; left > 0; left--) { resend.textContent = `Resend in ${left}s`; await sleep(1000); if (!root.isConnected) return; } resend.disabled = false; resend.textContent = "Resend code"; };
    resend.addEventListener("click", () => run(resend, async () => { await api("POST", "/v1/auth/email", { email, next }); toast("New code sent"); tick(); }));
    mount(root, h("div", { class: "card" }, h("div", { class: "stack lg" },
      h("div", null, h("div", { class: "avatar", style: "margin-bottom:18px" }, icon("shield", 28)),
        h("h1", { style: "font-size:28px;margin:0 0 6px;letter-spacing:-.02em" }, "Check your email"),
        h("p", { class: "muted", style: "margin:0" }, "We sent a 6 digit code to ", h("b", { style: "color:var(--text)" }, email), ". It expires in ", Math.round((sent.expiresInSeconds || 600) / 60), " minutes.")),
      h("div", { class: "otp" }, cells), err,
      btn("Verify and sign in", submit, "block large"),
      h("div", { class: "row between" }, h("button", { class: "btn ghost small", type: "button", onclick: stepEmail }, "Use a different email"), resend),
      sent.transport === "file" ? alert("warn", "Development mode: mail transport is set to ", h("code", { class: "inline" }, "file"), ", so the email was written to ", h("code", { class: "inline" }, "data/outbox/"), " instead of being sent.") : null,
      h("div", { class: "help" }, "You can also open the link in the email on this device and confirm. Check spam if it does not arrive within a minute."))));
    tick();
    setTimeout(() => cells[0].focus(), 50);
  };
  stepEmail();
  return root;
}

/** Page for the emailed link: requires an explicit click so mail scanners cannot consume the token. */
export function verifyLinkView() {
  const q = query();
  const root = h("div", { class: "auth-wrap" });
  const token = q.token;
  const body = !token
    ? alert("bad", "This sign-in link is incomplete. Request a new one.")
    : h("div", { class: "stack lg" },
      h("div", null, h("div", { class: "avatar", style: "margin-bottom:18px" }, icon("shield", 28)), h("h1", { style: "font-size:28px;margin:0 0 6px" }, "Confirm sign in"),
        h("p", { class: "muted", style: "margin:0" }, "Press the button to finish signing in on this device. If you did not request this, close the page.")),
      btn("Sign in", async () => {
        await api("POST", "/v1/auth/verify-token", { token });
        await loadAuth();
        toast("Signed in");
        navigate(safeNext(q.next), true);
      }, "block large"));
  mount(root, h("div", { class: "card" }, body));
  return root;
}
