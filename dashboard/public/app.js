// dropcatch dashboard client. Vanilla ES module, no build step, no third-party code.
// All rendering goes through h() with text nodes, so API data can never inject HTML.

const $app = document.getElementById("app");
const $toasts = document.getElementById("toasts");

const S = {
  session: null,
  meta: null,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  stream: null,
  refreshTimer: 0,
  route: "",
};

// ---------------------------------------------------------------- DOM helpers

const BOOL_PROPS = new Set(["disabled", "checked", "required", "hidden", "selected", "open", "readOnly", "multiple", "autofocus"]);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    // CSSOM, not the style attribute: the CSP forbids inline style attributes.
    else if (key === "style") el.style.cssText = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on") for (const [ev, fn] of Object.entries(value)) el.addEventListener(ev, fn);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (BOOL_PROPS.has(key)) el[key] = Boolean(value);
    else if (key === "value") el.value = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(name, label) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `/icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}

function badge(text, kind = "", extra) {
  return h("span", { class: `badge ${kind}` }, extra, text);
}

function field({ label, name, type = "text", value, help, required, placeholder, autocomplete, attrs = {}, control }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const input = control || h("input", { id, name, type, value, required, placeholder, autocomplete, spellcheck: "false", ...attrs });
  if (control) control.id = id;
  const helpId = help ? `${id}-help` : undefined;
  if (helpId) input.setAttribute("aria-describedby", helpId);
  return h("div", { class: "field", dataset: { field: name } },
    h("label", { for: id, text: label }),
    input,
    help ? h("span", { class: "help", id: helpId, text: help }) : null,
    h("span", { class: "error-text", hidden: true }));
}

function select(name, options, value) {
  return h("select", { name }, options.map(([v, label]) => h("option", { value: v, selected: v === value, text: label })));
}

function checkbox({ name, label, help, checked, value }) {
  return h("label", { class: "check" },
    h("input", { type: "checkbox", name, checked, value }),
    h("span", {}, label, help ? h("span", { class: "help", text: help }) : null));
}

function panel(title, body, { actions, flush } = {}) {
  return h("section", { class: "panel" },
    title ? h("div", { class: "panel-head" }, h("h2", { text: title }), actions ? h("div", { class: "actions" }, actions) : null) : null,
    h("div", { class: `panel-body${flush ? " flush" : ""}` }, body));
}

function empty(title, text, action) {
  return h("div", { class: "empty" }, h("h3", { text: title }), text ? h("p", { text }) : null, action);
}

function button(label, { kind = "", iconName, onClick, type = "button", title, disabled } = {}) {
  return h("button", { class: `btn ${kind}`, type, title, "aria-label": label ? undefined : title, disabled, on: onClick ? { click: onClick } : undefined },
    iconName ? icon(iconName) : null, label);
}

function linkButton(label, href, { kind = "", iconName, title } = {}) {
  const aria = label ? undefined : title || (iconName === "caret-left" ? "Previous" : iconName === "caret-right" ? "Next" : undefined);
  return h("a", { class: `btn ${kind}`, href, title, "aria-label": aria }, iconName ? icon(iconName) : null, label);
}

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data || {};
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-dropcatch": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && data?.signIn) {
      S.session = null;
      if (!location.hash.startsWith("#/login")) location.hash = "#/login";
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

// ---------------------------------------------------------------- formatting

function tzFormatter(opts) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: S.tz, ...opts });
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts);
  }
}

function fmtTime(ms, { date = false, seconds = true, zone = false } = {}) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "n/a";
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  if (seconds) opts.second = "2-digit";
  if (date) Object.assign(opts, { day: "numeric", month: "short", year: "numeric" });
  if (zone) opts.timeZoneName = "short";
  return tzFormatter(opts).format(new Date(ms));
}

const fmtIso = (iso, o) => (iso ? fmtTime(Date.parse(iso), o) : "n/a");

function fmtDuration(ms) {
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(abs)} ms`;
  if (abs < 60_000) return `${(abs / 1000).toFixed(1)} s`;
  const s = Math.floor(abs / 1000);
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${hh}h`;
  if (hh > 0) return `${hh}h ${String(mm).padStart(2, "0")}m`;
  return `${mm}m ${String(s % 60).padStart(2, "0")}s`;
}

function fmtCountdown(ms) {
  const sign = ms >= 0 ? "T-" : "T+";
  const abs = Math.abs(ms);
  if (abs >= 86_400_000) return `${sign}${fmtDuration(abs)}`;
  const s = Math.floor(abs / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function fmtRelative(ms) {
  const diff = Date.now() - ms;
  if (diff < 5_000) return "just now";
  return diff > 0 ? `${fmtDuration(diff)} ago` : `in ${fmtDuration(-diff)}`;
}

const fmtMoney = (m) => (m ? `${Number(m.amount).toFixed(2)} ${m.currency}` : "n/a");

function stateBadge(state) {
  const kinds = {
    SUCCEEDED: "success",
    AMBIGUOUS: "danger",
    REGISTERING: "danger",
    REGISTRATION_PENDING: "warning",
    FAILED: "danger",
    ABORTED: "warning",
    CHECKING: "accent",
    ARMED: "accent",
    AVAILABLE: "accent",
    VERIFYING: "accent",
  };
  return badge(state, `mono ${kinds[state] || ""}`);
}

function modeBadge(mode, dryRun) {
  if (mode === "auto-buy") return badge(dryRun ? "Auto-buy (dry run)" : "Auto-buy", dryRun ? "warning" : "danger");
  if (mode === "confirm") return badge(dryRun ? "Confirm (dry run)" : "Confirm", "warning");
  return badge("Notify only");
}

const STATUS_LABEL = {
  available: "available",
  unavailable: "taken",
  unknown: "unknown",
  error: "error",
  rate_limited: "rate limited",
  unsupported: "unsupported",
};

// ---------------------------------------------------------------- theme & toasts

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#fafafa" : "#08090a");
}

// Dark is the house style. Light is an explicit opt-in from Settings.
function initTheme() {
  applyTheme(localStorage.getItem("dropcatch-theme") === "light" ? "light" : "dark");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem("dropcatch-theme", next);
  applyTheme(next);
}

const TOAST_ICON = { success: "check-circle", danger: "x-circle", warning: "warning", info: "info", signal: "lightning" };

function toast(message, kind = "info", { title, sticky = kind === "danger" } = {}) {
  const key = `${kind}|${title || ""}|${message}`;
  if ([...$toasts.children].some((t) => t.dataset.key === key)) return;
  const el = h("div", { class: `toast ${kind}`, role: kind === "danger" ? "alert" : undefined },
    icon(TOAST_ICON[kind] || "info"),
    h("div", {}, title ? h("strong", { text: title }) : null, title ? h("br") : null, message),
    h("button", { class: "btn ghost sm", type: "button", "aria-label": "Dismiss", on: { click: () => el.remove() } }, icon("x")));
  el.dataset.key = key;
  $toasts.append(el);
  while ($toasts.children.length > 4) $toasts.firstElementChild.remove();
  if (!sticky) setTimeout(() => el.remove(), 6000);
}

// ---------------------------------------------------------------- forms

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "checkbox") {
      if (el.value && el.value !== "on") {
        out[el.name] ??= [];
        if (el.checked) out[el.name].push(el.value);
      } else out[el.name] = el.checked;
    } else if (el.type === "radio") {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

function clearErrors(form) {
  form.querySelectorAll(".error-text").forEach((e) => {
    e.hidden = true;
    e.textContent = "";
  });
  form.querySelectorAll("[aria-invalid]").forEach((e) => e.removeAttribute("aria-invalid"));
  form.querySelector(".form-issues")?.remove();
}

function showError(form, err) {
  const fieldName = err?.data?.field;
  const wrap = fieldName ? form.querySelector(`[data-field="${fieldName}"]`) : null;
  if (wrap) {
    const msg = wrap.querySelector(".error-text");
    msg.textContent = err.message;
    msg.hidden = false;
    const input = wrap.querySelector("input, select, textarea");
    input?.setAttribute("aria-invalid", "true");
    input?.focus();
    return;
  }
  const issues = err?.data?.issues || [];
  const box = h("div", { class: "banner danger form-issues", role: "alert" }, icon("warning"),
    h("div", {}, h("strong", { text: err.message || "Something went wrong" }), issues.length ? h("ul", {}, issues.map((i) => h("li", { text: i }))) : null));
  form.prepend(box);
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** Wire a form: disables the submit button while busy, shows errors inline. */
function onSubmit(form, handler, busyLabel = "Saving…") {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const label = submit?.innerHTML;
    clearErrors(form);
    if (submit) {
      submit.disabled = true;
      submit.textContent = busyLabel;
    }
    try {
      await handler(formData(form), form);
    } catch (err) {
      showError(form, err);
    } finally {
      if (submit && submit.isConnected) {
        submit.disabled = false;
        submit.innerHTML = label;
      }
    }
  });
  return form;
}

function confirmDialog({ title, body, confirmLabel = "Confirm", danger = false, typed }) {
  return new Promise((resolve) => {
    const input = typed ? h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: typed }) : null;
    const ok = button(confirmLabel, { kind: danger ? "solid-danger" : "primary", type: "submit", disabled: Boolean(typed) });
    ok.value = "ok";
    input?.addEventListener("input", () => (ok.disabled = input.value.trim() !== typed));
    const dialog = h("dialog", { "aria-labelledby": "dlg-title" },
      h("form", { method: "dialog", class: "panel-body" },
        h("h2", { id: "dlg-title", text: title }),
        typeof body === "string" ? h("p", { class: "muted", text: body }) : body,
        typed ? field({ label: `Type ${typed} to continue`, name: "typed", control: input }) : null,
        h("div", { class: "form-foot" }, button("Cancel", { onClick: () => dialog.close("cancel") }), ok)));
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    (input || ok).focus();
  });
}

// ---------------------------------------------------------------- live updates

function connectStream() {
  if (S.stream) return;
  S.stream = new EventSource("/api/stream");
  S.stream.addEventListener("event", (e) => {
    const ev = JSON.parse(e.data);
    const loud = ["availability_detected", "registration_succeeded", "registration_failed", "registration_ambiguous", "registration_pending", "purchase_blocked", "budget_exceeded", "dry_run_registration", "confirmation_requested"];
    if (loud.includes(ev.type)) toast(`${ev.domain}: ${ev.summary}`, ev.severity === "signal" ? "signal" : ev.severity, { title: ev.title });
    scheduleRefresh();
  });
  for (const type of ["watch", "config", "confirmation"]) S.stream.addEventListener(type, () => scheduleRefresh());
  S.stream.onerror = () => {
    // A 401 or a server restart can close the stream for good; reopen it while signed in.
    if (S.stream?.readyState === EventSource.CLOSED) {
      S.stream = null;
      setTimeout(() => S.session?.authenticated && connectStream(), 5000);
    }
  };
}

function scheduleRefresh() {
  if (!["overview", "target", "activity", "calendar"].includes(S.route)) return;
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(() => {
    const active = document.activeElement;
    // Never wipe what the operator is typing.
    if (active && $app.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName)) return;
    if (document.querySelector("dialog[open]")) return;
    render({ quiet: true });
  }, 500);
}

// Countdown and "now" markers tick without re-rendering.
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll("[data-countdown]").forEach((el) => (el.textContent = fmtCountdown(Number(el.dataset.countdown) - now)));
  document.querySelectorAll("[data-timeline]").forEach((el) => placeNow(el, now));
}, 250);

// ---------------------------------------------------------------- shell

const NAV = [
  ["overview", "Overview", "squares-four"],
  ["calendar", "Calendar", "calendar-blank"],
  ["check", "Check", "magnifying-glass"],
  ["activity", "Activity", "pulse"],
  ["providers", "Providers", "plugs-connected"],
  ["notifications", "Notifications", "bell-simple"],
  ["settings", "Settings", "gear-six"],
];

function shell(section, content) {
  const m = S.meta;
  const safety = m
    ? m.dryRun
      ? h("a", { class: "badge success", href: "#/settings", title: "Dry run is on: nothing can be purchased" }, icon("shield-check"), h("span", { class: "label", text: "Dry run" }))
      : h("a", { class: "badge danger", href: "#/settings", title: "Live purchasing is on" }, icon("lightning"), h("span", { class: "label", text: "Live" }))
    : null;
  const nav = h("ul", { class: "nav" }, NAV.map(([key, label, ic]) =>
    h("li", {}, h("a", { href: `#/${key}`, "aria-current": section === key ? "page" : undefined, title: label },
      icon(ic), h("span", { text: label }),
      key === "overview" && m?.watching ? h("span", { class: "count badge accent", text: String(m.watching) }) : null))));
  return h("div", { class: "shell" },
    h("aside", { class: "sidebar" },
      h("a", { class: "brand", href: "#/overview" }, h("img", { src: "/favicon.svg", alt: "", width: 22, height: 22 }), h("span", { text: "dropcatch" })),
      h("nav", { "aria-label": "Main" }, nav),
      h("div", { class: "sidebar-foot" },
        safety,
        h("div", { class: "row" },
          button("Sign out", { kind: "ghost sm", iconName: "sign-out", onClick: signOut })))),
    h("main", { class: "main", id: "main" }, content));
}

function pageHead(title, sub, actions) {
  return h("header", { class: "page-head" },
    h("div", {}, h("h1", { text: title, tabindex: "-1" }), sub ? h("p", { class: "sub", text: sub }) : null),
    actions ? h("div", { class: "actions" }, actions) : null);
}

async function signOut() {
  await api("POST", "/api/logout").catch(() => {});
  S.session = { ...S.session, authenticated: false };
  S.stream?.close();
  S.stream = null;
  location.hash = "#/login";
}

async function loadMeta() {
  const o = await api("GET", "/api/overview");
  S.meta = { ...o.app, watching: o.targets.filter((t) => t.watching).length };
  S.tz = o.app.timezone || S.tz;
  return o;
}

// ---------------------------------------------------------------- timeline

function timelineFor(t) {
  const d = t.drop;
  if (!d) {
    return h("div", { class: "timeline" },
      h("div", { class: "muted", text: `No drop time set. Polling every ${fmtDuration(t.schedule.fixedIntervalMs)}.` }));
  }
  const T = d.expectedAt;
  const warmStart = T - d.preWindowMs;
  const hotStart = T - Math.min(d.hotWindowMs, d.preWindowMs);
  const hotEnd = T + Math.min(d.hotWindowMs, d.postWindowMs);
  const postEnd = T + d.postWindowMs;
  const span = Math.max(1, postEnd - warmStart);
  const start = warmStart - span * 0.12;
  const end = postEnd + span * 0.12;
  const pct = (x) => `${(((x - start) / (end - start)) * 100).toFixed(3)}%`;
  const seg = (cls, a, b) => h("span", { class: `seg ${cls}`, style: `left:${pct(a)};width:calc(${pct(b)} - ${pct(a)})` });
  const bar = h("div", { class: "bar" }, seg("warm", warmStart, hotStart), seg("hot", hotStart, hotEnd), seg("post", hotEnd, postEnd));
  const wrap = h("div", { class: "timeline", dataset: { timeline: "1", start: String(start), end: String(end), drop: String(T), open: String(warmStart) } },
    h("div", { class: "track" }, bar,
      h("span", { class: "mark drop", style: `left:${pct(T)}`, title: "Expected drop" }),
      h("span", { class: "mark now", title: "Now" })),
    h("div", { class: "legend" },
      h("span", { text: `opens ${fmtTime(warmStart, { seconds: false })}` }),
      h("span", { class: "num", text: `drop ${fmtTime(T)}` }),
      h("span", { text: `closes ${fmtTime(postEnd, { seconds: false })}` })));
  placeNow(wrap, Date.now());
  return wrap;
}

function placeNow(el, now) {
  const start = Number(el.dataset.start);
  const end = Number(el.dataset.end);
  const mark = el.querySelector(".mark.now");
  if (!mark) return;
  const p = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  mark.style.left = `calc(${p}% - 1px)`;
  mark.style.opacity = now < start || now > end ? "0.35" : "1";
}

// ---------------------------------------------------------------- auth pages

function authLayout(content, wide = false) {
  return h("main", { class: "auth" },
    h("div", { class: `auth-card${wide ? " wide" : ""}` },
      h("div", { class: "brand" }, h("img", { src: "/favicon.svg", alt: "", width: 22, height: 22 }), h("span", { text: "dropcatch" })),
      content));
}

function pageSetup(_p, query) {
  const form = h("form", { class: "stack-sm", novalidate: true },
    field({ label: "Setup token", name: "token", value: query.get("token") || "", autocomplete: "off", required: true, help: "Printed in the terminal that started the dashboard.", attrs: { class: "mono" } }),
    field({ label: "Admin password", name: "password", type: "password", autocomplete: "new-password", required: true, help: "At least 10 characters. You will need it every time you sign in." }),
    field({ label: "Repeat password", name: "repeat", type: "password", autocomplete: "new-password", required: true }),
    button("Create password", { kind: "primary block", type: "submit" }));
  onSubmit(form, async (data) => {
    if (data.password !== data.repeat) throw new ApiError(400, { error: "The passwords do not match.", field: "repeat" });
    const res = await api("POST", "/api/setup", { token: data.token.trim(), password: data.password });
    S.session = { ...S.session, setupRequired: false, authenticated: true };
    history.replaceState(null, "", location.pathname);
    location.hash = res.configExists ? "#/overview" : "#/welcome";
  }, "Creating…");
  return {
    title: "Set up",
    node: authLayout(h("div", { class: "stack" },
      h("div", { class: "steps" }, h("span", { "aria-current": "step", text: "1. Secure the dashboard" }), h("span", { text: "2. First domain" })),
      h("div", { class: "stack-sm" },
        h("h1", { text: "Create the admin password" }),
        h("p", { class: "muted", text: "This dashboard can change settings that spend money, so it is locked behind one password." })),
      panel(null, form))),
  };
}

function pageLogin() {
  const form = h("form", { class: "stack-sm", novalidate: true },
    field({ label: "Password", name: "password", type: "password", autocomplete: "current-password", required: true, attrs: { autofocus: true } }),
    button("Sign in", { kind: "primary block", type: "submit" }));
  onSubmit(form, async (data) => {
    await api("POST", "/api/login", { password: data.password });
    S.session = { ...S.session, authenticated: true };
    location.hash = "#/overview";
  }, "Signing in…");
  return {
    title: "Sign in",
    node: authLayout(h("div", { class: "stack" }, h("h1", { text: "Sign in" }), panel(null, form))),
  };
}

function registrarChecks(selected = []) {
  const names = [["ovh", "OVHcloud", "Sells .pl and .com.pl (prices in PLN, without VAT)"], ["porkbun", "Porkbun", "Real-time check, exact-price guard, server-side dry run. No .pl"], ["namecheap", "Namecheap", "Needs a whitelisted IP"], ["cloudflare", "Cloudflare", "API beta, subset of TLDs"]];
  return h("div", { class: "stack-sm" }, names.map(([v, label, help]) => checkbox({ name: "registrars", value: v, label, help, checked: selected.includes(v) })));
}

function modeChoices(name, value) {
  const modes = [
    ["notify-only", "Notify only", "Tell me when it frees up. Never buys."],
    ["confirm", "Confirm", "Ask me to type the domain before buying."],
    ["auto-buy", "Auto-buy", "Buy within budget with no human step."],
  ];
  return h("div", { class: "choice-grid", role: "radiogroup" }, modes.map(([v, label, help]) =>
    h("label", { class: "choice" }, h("input", { type: "radio", name, value: v, checked: v === value }), h("strong", { text: label }), h("span", { class: "help", text: help }))));
}

function timezoneInput(name, value) {
  const listId = `tz-${Math.random().toString(36).slice(2, 7)}`;
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const wrap = h("div", {}, h("input", { type: "text", name, value, list: listId, autocomplete: "off", spellcheck: "false", "aria-label": "Timezone" }),
    h("datalist", { id: listId }, zones.map((z) => h("option", { value: z }))));
  return wrap;
}

function pageWelcome() {
  const budget = h("div", { class: "form-grid" },
    field({ label: "Maximum price", name: "maxPrice", type: "number", value: "20", attrs: { min: "0.01", step: "0.01", inputmode: "decimal" } }),
    field({ label: "Currency", name: "currency", value: "USD", attrs: { maxlength: "3" }, help: "OVHcloud Poland prices in PLN." }),
    field({ label: "OVH owner contact id", name: "ovhOwnerContact", placeholder: "12345", help: "Only for buying with OVHcloud: OVH manager > contacts.", autocomplete: "off" }));
  const form = h("form", { class: "stack", novalidate: true },
    field({ label: "Domain to watch", name: "domain", placeholder: "example.pl", required: true, autocomplete: "off" }),
    h("div", { class: "form-grid" },
      field({ label: "Expected release (optional)", name: "expectedAt", type: "datetime-local", help: "Leave empty to poll continuously." }),
      h("div", { class: "field", dataset: { field: "timezone" } }, h("span", { class: "label-text", text: "Timezone" }), timezoneInput("timezone", S.tz), h("span", { class: "error-text", hidden: true }))),
    h("fieldset", { dataset: { field: "registrars" } }, h("legend", { text: "Registrars with an API account" }), registrarChecks([]), h("span", { class: "error-text", hidden: true })),
    h("fieldset", {}, h("legend", { text: "When it frees up" }), modeChoices("mode", "notify-only")),
    budget,
    checkbox({ name: "discord", label: "Send Discord notifications", help: "You will add the webhook URL on the next screen.", checked: true }),
    h("div", { class: "form-foot" }, h("a", { class: "btn ghost", href: "#/overview", text: "Skip, I will write config.yaml" }), button("Create config", { kind: "primary", type: "submit" })));
  const syncBudget = () => (budget.hidden = formData(form).mode === "notify-only");
  form.addEventListener("change", syncBudget);
  syncBudget();
  onSubmit(form, async (d) => {
    await api("POST", "/api/config/quickstart", {
      domain: d.domain, expectedAt: d.expectedAt, timezone: d.timezone, registrars: d.registrars || [],
      mode: d.mode, maxPrice: d.maxPrice, currency: d.currency, ovhOwnerContact: d.ovhOwnerContact, discord: d.discord,
    });
    toast("Config created in dry-run mode. Add your API keys next.", "success");
    location.hash = "#/providers";
  }, "Creating…");
  return {
    title: "First domain",
    node: authLayout(h("div", { class: "stack" },
      h("div", { class: "steps" }, h("span", { text: "1. Secure the dashboard" }), h("span", { "aria-current": "step", text: "2. First domain" })),
      h("div", { class: "stack-sm" }, h("h1", { text: "Add your first domain" }), h("p", { class: "muted", text: "This writes config.yaml in dry-run mode. Nothing can be bought until you switch dry run off in Settings." })),
      panel(null, form)), true),
  };
}

// ---------------------------------------------------------------- overview

function confirmationCards(list) {
  return list.map((c) => {
    const form = h("form", { class: "row" },
      h("input", { type: "text", name: "domain", placeholder: c.domain, autocomplete: "off", spellcheck: "false", "aria-label": `Type ${c.domain} to confirm`, style: "max-width:320px" }),
      button("Register now", { kind: "solid-danger", type: "submit" }),
      button("Decline", { onClick: async () => { await api("POST", `/api/confirmations/${c.id}`, { decline: true }); scheduleRefresh(); } }));
    onSubmit(form, async (d) => {
      await api("POST", `/api/confirmations/${c.id}`, { domain: d.domain });
      toast("Confirmation sent.", "info");
    }, "Sending…");
    return h("div", { class: "confirm-card", role: "alert" },
      h("div", { class: "row" }, icon("warning"), h("strong", { text: `Confirm purchase of ${c.domain}` }), badge(fmtMoney(c.price), "danger"), badge(c.provider)),
      h("p", { class: "muted" }, "Type the domain name to register it. Expires ", h("span", { class: "num", dataset: { countdown: String(c.expiresAt) } }), "."),
      form);
  });
}

function targetRow(t) {
  const watching = t.watching;
  const actions = h("div", { class: "row" },
    watching
      ? button("Stop", { kind: "sm", iconName: "stop", onClick: () => targetAction(t.id, "stop") })
      : button("Watch", { kind: "primary sm", iconName: "play", onClick: () => targetAction(t.id, "start"), disabled: !t.enabled }),
    linkButton("Details", `#/targets/${encodeURIComponent(t.id)}`, { kind: "sm" }));
  const checks = t.checks.length
    ? h("div", { class: "checks" }, t.checks.slice(0, 4).map((c) =>
      h("div", { class: "item" },
        h("span", { class: "provider", text: c.provider }),
        h("span", { class: `status-${c.status}`, text: STATUS_LABEL[c.status] || c.status }),
        h("span", { class: "dim num", text: `${c.latencyMs} ms` }))))
    : h("p", { class: "dim", text: "No checks yet." });
  const phaseText = t.drop
    ? h("div", { class: "row" }, h("span", { class: "countdown", dataset: { countdown: String(t.drop.expectedAt) } }),
      h("span", { class: "muted", text: `${t.phase} phase, every ${fmtDuration(t.intervalMs)}` }))
    : null;
  return h("article", { class: "target" },
    h("div", {},
      h("a", { class: "domain", href: `#/targets/${encodeURIComponent(t.id)}`, text: t.unicode }),
      h("div", { class: "row meta" },
        watching ? badge("Watching", "accent", h("span", { class: "live", "aria-hidden": "true" })) : null,
        stateBadge(t.state),
        modeBadge(t.mode, S.meta?.dryRun),
        t.enabled ? null : badge("Disabled"))),
    h("div", { class: "stack-sm" }, phaseText, timelineFor(t)),
    h("div", { class: "stack-sm" }, checks, actions));
}

async function targetAction(id, action) {
  try {
    await api("POST", `/api/targets/${encodeURIComponent(id)}/${action}`);
    toast(action === "start" ? `Watching ${id}.` : `Stopping ${id}.`, "info");
    render({ quiet: true });
  } catch (err) {
    toast(err.message, "danger", { title: action === "start" ? "Could not start the watch" : "Could not stop" });
  }
}

function feed(events, { withTarget = true } = {}) {
  if (!events.length) return empty("No activity yet", "Events appear here as soon as a watch starts.");
  return h("ol", { class: "feed" }, [...events].reverse().map((e) => {
    const p = e.payload || {};
    const sev = /succeeded|recovered/.test(e.type) ? "success" : /failed|ambiguous|blocked|budget/.test(e.type) ? "danger" : /detected|dry_run/.test(e.type) ? "signal" : /error|rate|pending|declined|false_positive|clock/.test(e.type) ? "warning" : "";
    const detail = [p.provider, p.outcome, p.errorCode, p.reason].filter(Boolean).join(", ");
    return h("li", { class: `sev-${sev}` },
      h("time", { datetime: e.timestamp, title: fmtIso(e.timestamp, { date: true, zone: true }), text: fmtIso(e.timestamp) }),
      h("div", { class: "what" },
        h("strong", { text: e.type.replaceAll("_", " ") }),
        withTarget && e.targetId ? h("span", { class: "muted", text: ` ${e.targetId}` }) : null,
        detail ? h("div", { class: "muted", text: detail }) : null));
  }));
}

async function pageOverview() {
  const o = await loadMeta();
  const nextDrop = o.targets.filter((t) => t.drop).sort((a, b) => a.drop.expectedAt - b.drop.expectedAt).find((t) => t.drop.expectedAt + t.drop.postWindowMs > o.now);
  const registering = o.targets.some((t) => t.registrationActive);
  const banners = [];
  if (o.app.configError) {
    banners.push(h("div", { class: "banner danger", role: "alert" }, icon("warning"), h("div", {},
      h("strong", { text: "The config file has errors, so defaults are in use. " }), h("a", { href: "#/config", text: "Open the raw config" }),
      h("ul", {}, o.app.configError.slice(0, 6).map((i) => h("li", { text: i }))))));
  } else if (!o.app.configExists) {
    banners.push(h("div", { class: "banner info" }, icon("info"), h("div", {}, "No config file yet. ", h("a", { href: "#/welcome", text: "Add your first domain" }), " to create one.")));
  }
  if (!o.app.dryRun && registering) {
    banners.push(h("div", { class: "banner danger" }, icon("lightning"), h("div", {}, h("strong", { text: "Live purchasing is on. " }), "A successful registration charges your registrar account and cannot be refunded.")));
  }
  const ck = o.clock;
  if (ck.offsetMs !== undefined && Math.abs(ck.offsetMs) > ck.warnMs && !ck.applied) {
    banners.push(h("div", { class: "banner warning" }, icon("timer"), h("div", {},
      h("strong", { text: `This machine's clock is ${(Math.abs(ck.offsetMs) / 1000).toFixed(2)} s ${ck.offsetMs > 0 ? "slow" : "fast"} and is not being corrected. ` }),
      "Drops would be polled at the wrong moment. Enable NTP on the system, or set app.clock.correct: true.")));
  }
  if (o.app.warnings.length) {
    banners.push(h("details", { class: "banner warning" }, h("summary", { class: "row" }, icon("warning"), `${o.app.warnings.length} configuration warning${o.app.warnings.length > 1 ? "s" : ""}`),
      h("ul", {}, o.app.warnings.map((w) => h("li", { text: w })))));
  }

  const instruments = h("section", { class: "panel instruments", "aria-label": "Status" },
    h("div", { class: "instrument" }, h("span", { class: "label", text: "Next drop" }),
      nextDrop ? h("span", { class: "value", dataset: { countdown: String(nextDrop.drop.expectedAt) } }) : h("span", { class: "value dim", text: "none" }),
      h("span", { class: "hint", text: nextDrop ? `${nextDrop.domain}, ${fmtTime(nextDrop.drop.expectedAt, { date: true, zone: true })}` : "No scheduled drops" })),
    h("div", { class: "instrument" }, h("span", { class: "label", text: "Watching" }),
      h("span", { class: "value", text: `${o.targets.filter((t) => t.watching).length}/${o.targets.length}` }),
      h("span", { class: "hint", text: "targets running in this process" })),
    h("div", { class: "instrument" }, h("span", { class: "label", text: "Checks, 24 h" }),
      h("span", { class: "value", text: o.checks24h.toLocaleString("en-US") }),
      h("span", { class: "hint", text: o.latency.length ? `${o.latency.length} source${o.latency.length > 1 ? "s" : ""} with history` : "no history yet" })),
    clockInstrument(o.clock));

  const targets = o.targets.length
    ? h("div", {}, o.targets.map(targetRow))
    : empty(o.app.configExists ? "No targets yet" : "Nothing to watch yet", "Add the domain you want to catch and when it is expected to free up.",
      linkButton(o.app.configExists ? "Add target" : "Run quick setup", o.app.configExists ? "#/targets/new" : "#/welcome", { kind: "primary", iconName: "plus" }));

  const latency = o.latency.length
    ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Source", "Checks", "p50 / p95", "Errors"].map((x) => h("th", { text: x })))),
      h("tbody", {}, o.latency.map((l) => h("tr", {},
        h("td", { text: l.provider }), h("td", { text: String(l.checks) }), h("td", { text: `${l.p50Ms} / ${l.p95Ms} ms` }),
        h("td", { class: l.errors ? "status-error" : "dim", text: String(l.errors) }))))))
    : empty("No latency data", "Run a check or a watch to measure each source.");

  return {
    title: "Overview",
    section: "overview",
    node: h("div", { class: "stack" },
      pageHead("Overview", `${o.targets.length} target${o.targets.length === 1 ? "" : "s"}, profile ${o.app.profile}`,
        [
          linkButton("Check a domain", "#/check", { iconName: "magnifying-glass" }),
          o.app.configExists ? button("Import", { iconName: "upload-simple", onClick: () => importDialog() }) : null,
          o.app.configExists ? linkButton("Add target", "#/targets/new", { kind: "primary", iconName: "plus" }) : null,
        ]),
      banners,
      confirmationCards(o.confirmations),
      instruments,
      h("div", { class: "split" },
        panel("Targets", targets, { flush: true }),
        h("div", { class: "stack" },
          panel("Live activity", feed(o.events.slice(-15)), { flush: true, actions: linkButton("All", "#/activity", { kind: "ghost sm" }) }),
          panel("Source latency", latency, { flush: true })))),
  };
}

// ---------------------------------------------------------------- target detail

function kvList(pairs) {
  return h("dl", { class: "kv" }, pairs.filter(Boolean).map(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)]));
}

async function pageTarget(params) {
  const id = decodeURIComponent(params[0]);
  if (!S.meta) await loadMeta();
  const [d, latency] = await Promise.all([
    api("GET", `/api/targets/${encodeURIComponent(id)}`),
    api("GET", `/api/targets/${encodeURIComponent(id)}/latency`).catch(() => ({ series: [] })),
  ]);
  const t = d.target;
  if (!t) {
    return { title: id, section: "overview", node: h("div", { class: "stack" }, pageHead(id, "Not in the current config"), panel(null, empty("This target is only in history", "It was removed from the config. Its audit trail is kept below.")), panel("Timeline", feed(d.events, { withTarget: false }), { flush: true })) };
  }
  const blocking = ["AMBIGUOUS", "REGISTRATION_PENDING", "REGISTERING", "SUCCEEDED", "FAILED", "ABORTED"].includes(t.state);
  const resolveBox = blocking
    ? h("div", { class: `banner ${t.state === "SUCCEEDED" ? "info" : "warning"}` }, icon(t.state === "SUCCEEDED" ? "check-circle" : "warning"),
      h("div", { class: "stack-sm" },
        h("div", {}, h("strong", { text: `State ${t.state}. ` }), t.stateDetail || ""),
        h("div", { class: "row" },
          ["AMBIGUOUS", "REGISTRATION_PENDING", "REGISTERING"].includes(t.state) ? button("Ask the registrar", { kind: "sm", onClick: () => resolve(t.id, "auto") }) : null,
          t.state !== "SUCCEEDED" ? button("Mark as registered", { kind: "sm", onClick: () => resolve(t.id, "succeeded") }) : null,
          button("Reset and re-arm", { kind: "sm danger", onClick: () => resolve(t.id, "reset") }))))
    : null;

  const sources = t.checks.length
    ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Source", "Status", "Price", "Latency", "Checked", "Detail"].map((x) => h("th", { text: x })))),
      h("tbody", {}, t.checks.map((c) => h("tr", {},
        h("td", { text: c.provider }), h("td", { class: `status-${c.status}`, text: STATUS_LABEL[c.status] || c.status }),
        h("td", { text: c.price ? fmtMoney(c.price) : "n/a" }), h("td", { text: `${c.latencyMs} ms` }),
        h("td", { title: fmtIso(c.checkedAt, { date: true, zone: true }), text: fmtRelative(Date.parse(c.checkedAt)) }),
        h("td", { class: "truncate", title: c.reason || c.errorCode || "", text: c.reason || c.errorCode || "" }))))))
    : empty("No checks yet", "Start the watch or run a check.");

  const attempts = d.attempts.length
    ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Started", "Provider", "Status", "Price", "Reference or error"].map((x) => h("th", { text: x })))),
      h("tbody", {}, d.attempts.map((a) => h("tr", {},
        h("td", { text: fmtIso(a.startedAt, { date: true }) }), h("td", { text: a.provider }),
        h("td", {}, a.dryRun ? badge("dry run") : stateBadge(a.status.toUpperCase())),
        h("td", { text: a.priceAmount !== null ? fmtMoney({ amount: a.priceAmount, currency: a.priceCurrency }) : "n/a" }),
        h("td", { class: "truncate", title: a.reason || "", text: a.providerReference || a.errorCode || a.reason || "" }))))))
    : empty("No purchase attempts", "Attempts, including dry runs, are recorded here with the gate decision.");

  const runs = d.runs.length
    ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Started", "Ended", "Mode", "Outcome", "First detection"].map((x) => h("th", { text: x })))),
      h("tbody", {}, d.runs.map((r) => h("tr", {},
        h("td", { text: fmtIso(r.startedAt, { date: true }) }), h("td", { text: r.endedAt ? fmtIso(r.endedAt) : "running" }),
        h("td", { text: `${r.mode}${r.dryRun ? ", dry run" : ""}` }), h("td", { text: r.status }),
        h("td", { text: r.detectedAt ? fmtIso(r.detectedAt) : "n/a" }))))))
    : empty("No runs yet", null);

  const b = t.budget || {};
  return {
    title: t.domain,
    section: "overview",
    node: h("div", { class: "stack" },
      pageHead(t.unicode, `${t.id}, ${t.tld === "generic" ? "generic TLD rules" : `.${t.tld} rules`}`, [
        t.watching ? button("Stop watch", { iconName: "stop", onClick: () => targetAction(t.id, "stop") }) : button("Watch", { kind: "primary", iconName: "play", disabled: !t.enabled, onClick: () => targetAction(t.id, "start") }),
        linkButton("Edit", `#/targets/${encodeURIComponent(t.id)}/edit`, { iconName: "pencil-simple" }),
      ]),
      resolveBox,
      h("div", { class: "grid-2" },
        panel("Schedule", h("div", { class: "stack" },
          t.drop ? h("div", { class: "row" }, h("span", { class: "countdown", dataset: { countdown: String(t.drop.expectedAt) } }), badge(`${t.phase} phase`, "mono")) : null,
          timelineFor(t),
          kvList([
            ["Expected drop", t.drop ? `${fmtTime(t.drop.expectedAt, { date: true, zone: true })}` : "not set"],
            t.drop ? ["UTC", new Date(t.drop.expectedAt).toISOString()] : null,
            ["Current interval", fmtDuration(t.intervalMs)],
            ["Intervals", `idle ${fmtDuration(t.schedule.initialIntervalMs)}, warm ${fmtDuration(t.schedule.warmupIntervalMs)}, hot ${fmtDuration(t.schedule.hotIntervalMs)}`],
            ["Strategy", `${t.schedule.strategy}${t.schedule.stopAfterWindow ? ", stops after window" : ""}`],
          ]),
          t.tldNotes.length ? h("div", { class: "help" }, t.tldNotes.map((n) => h("p", { text: n }))) : null)),
        panel("Registration", kvList([
          ["Mode", modeBadge(t.mode, S.meta?.dryRun)],
          ["State", stateBadge(t.state)],
          ["Sources", `${t.sources.join(", ")} (${t.quorum})`],
          ["Registrars", t.registrars.length ? t.registrars.join(" then ") : "none"],
          ["Budget", b.maxRegistrationPrice ? `${Number(b.maxRegistrationPrice).toFixed(2)} ${b.currency}` : "not set"],
          ["Premium names", b.allowPremium ? "allowed" : "blocked"],
          ["Attempts used", `${t.attempts} of ${t.maxTotalAttempts}`],
          ["Discord", t.discord ? "on" : "off or webhook missing"],
          ["Last outcome", t.lastOutcome ? `${t.lastOutcome.outcome}, ${fmtRelative(t.lastOutcome.at)}` : "n/a"],
        ]))),
      panel("Sources, latest answer", sources, { flush: true }),
      panel("Response time", latencyPanel(latency.series), { flush: true }),
      panel("Purchase attempts", attempts, { flush: true }),
      panel("Runs", runs, { flush: true }),
      panel("Timeline", feed(d.events, { withTarget: false }), { flush: true })),
  };
}

async function resolve(id, as) {
  const copy = {
    auto: ["Ask the registrar", "dropcatch asks the registrar that handled the last attempt whether the domain is now in your account. Only a confirmed yes changes the state.", "Ask"],
    succeeded: ["Mark as registered", "Use this after you checked your registrar account and the domain is there.", "Mark registered"],
    reset: ["Reset and re-arm", "Clears the lock and restarts attempt counting, so dropcatch may try to buy this domain again. History is kept.", "Reset"],
  }[as];
  if (!(await confirmDialog({ title: copy[0], body: copy[1], confirmLabel: copy[2], danger: as === "reset" }))) return;
  try {
    const r = await api("POST", `/api/targets/${encodeURIComponent(id)}/resolve`, { as });
    toast(r.note, r.after !== r.before ? "success" : "warning", { title: `${r.before} to ${r.after}` });
    render({ quiet: true });
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ---------------------------------------------------------------- target editor

function toLocalInput(iso, tz) {
  if (!iso) return "";
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) return "";
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) return iso.replace(" ", "T").slice(0, 16);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

async function pageTargetEdit(params) {
  const editing = params.length ? decodeURIComponent(params[0]) : null;
  if (!S.meta) await loadMeta();
  const cfg = await api("GET", "/api/config");
  const raw = editing ? (cfg.raw.targets || []).find((x) => x.id === editing) : null;
  if (editing && !raw) throw new ApiError(404, { error: `Target ${editing} is not in the config.` });
  const t = raw || {};
  const drop = t.drop || {};
  const mon = t.monitoring || {};
  const av = t.availability || { providers: ["rdap"] };
  const reg = t.registration || {};
  const budget = reg.budget || {};
  const tz = drop.timezone || cfg.raw.app?.timezone || S.tz;
  const availAccounts = cfg.accounts.filter((a) => a.availability);
  const regAccounts = cfg.accounts.filter((a) => a.registration);
  const regProviders = (reg.providers || []).map((p) => (typeof p === "string" ? p : p.account));

  const regSection = h("div", { class: "stack" },
    h("fieldset", {}, h("legend", { text: "When it frees up" }), modeChoices("mode", reg.enabled ? reg.mode || "notify-only" : "notify-only")),
    h("div", { class: "stack", dataset: { buying: "1" } },
      h("fieldset", {}, h("legend", { text: "Registrar accounts, tried in this order" }),
        regAccounts.length
          ? h("div", { class: "stack-sm" }, regAccounts.map((a) => checkbox({ name: "registrars", value: a.id, label: `${a.id}`, help: a.provider, checked: regProviders.includes(a.id) })))
          : h("p", { class: "muted" }, "No registrar accounts yet. ", h("a", { href: "#/providers", text: "Add one under Providers" }), ".")),
      h("div", { class: "form-grid" },
        field({ label: "Maximum price", name: "maxRegistrationPrice", type: "number", value: budget.maxRegistrationPrice ?? "", attrs: { min: "0.01", step: "0.01", inputmode: "decimal" }, help: "Required for auto-buy. Anything above is refused." }),
        field({ label: "Currency", name: "currency", value: budget.currency || "USD", attrs: { maxlength: "3" } })),
      checkbox({ name: "allowPremium", label: "Allow premium names", help: "Only if the provider supports premium purchases via API.", checked: budget.allowPremium }),
      h("details", { class: "advanced" }, h("summary", {}, icon("caret-right"), "Attempts and exact price"),
        h("div", { class: "form-grid" },
          field({ label: "Attempts per registrar", name: "maxAttemptsPerProvider", type: "number", value: reg.maxAttemptsPerProvider ?? 1, attrs: { min: "1", max: "10" } }),
          field({ label: "Attempts in total", name: "maxTotalAttempts", type: "number", value: reg.maxTotalAttempts ?? 1, attrs: { min: "1", max: "20" } }),
          field({ label: "Expected price (optional)", name: "expectedPrice", type: "number", value: budget.expectedPrice ?? "", attrs: { min: "0.01", step: "0.01" } }),
          field({ label: "After a confirmed failure", name: "onFailure", control: select("onFailure", [["resume-watch", "Keep watching"], ["stop", "Stop"]], reg.onFailure || "resume-watch") }),
          h("div", { class: "wide stack-sm" },
            checkbox({ name: "requireExactPrice", label: "Require the exact expected price", checked: budget.requireExactPrice }),
            checkbox({ name: "restrictToDropWindow", label: "Only buy inside the drop window", checked: reg.restrictToDropWindow }))))));

  const form = h("form", { class: "stack", novalidate: true },
    panel("Domain", h("div", { class: "form-grid" },
      field({ label: "Domain", name: "domain", value: t.domain || "", required: true, placeholder: "example.pl", autocomplete: "off" }),
      field({ label: "Target id", name: "id", value: t.id || "", required: true, placeholder: "example-pl", help: "Letters, digits, dot, dash, underscore.", autocomplete: "off" }),
      h("div", { class: "wide" }, checkbox({ name: "enabled", label: "Enabled", checked: t.enabled !== false })))),
    panel("Release window", h("div", { class: "form-grid" },
      field({ label: "Expected release", name: "expectedAt", type: "datetime-local", value: toLocalInput(drop.expectedAt, tz), help: "Empty means no known time: poll continuously." }),
      h("div", { class: "field", dataset: { field: "timezone" } }, h("span", { class: "label-text", text: "Timezone of that time" }), timezoneInput("timezone", tz), h("span", { class: "error-text", hidden: true })),
      field({ label: "Start early by (minutes)", name: "preMinutes", type: "number", value: Math.round((drop.preWindowSeconds ?? 600) / 60), attrs: { min: "0" } }),
      field({ label: "Keep going after (minutes)", name: "postMinutes", type: "number", value: Math.round((drop.postWindowSeconds ?? 900) / 60), attrs: { min: "0" }, help: "Registries rarely release to the second." }),
      h("details", { class: "advanced wide" }, h("summary", {}, icon("caret-right"), "Polling intervals"),
        h("div", { class: "form-grid" },
          field({ label: "Strategy", name: "strategy", control: select("strategy", [["adaptive", "Adaptive (faster near the drop)"], ["fixed", "Fixed interval"]], mon.strategy || "adaptive") }),
          field({ label: "Hot window (seconds each side of the drop)", name: "hotWindowSeconds", type: "number", value: mon.hotWindowSeconds ?? 10, attrs: { min: "0" } }),
          field({ label: "Idle interval (ms)", name: "initialIntervalMs", type: "number", value: mon.initialIntervalMs ?? 30000, attrs: { min: "250" } }),
          field({ label: "Warm interval (ms)", name: "warmupIntervalMs", type: "number", value: mon.warmupIntervalMs ?? 1000, attrs: { min: "100" } }),
          field({ label: "Hot interval (ms)", name: "hotIntervalMs", type: "number", value: mon.hotIntervalMs ?? 250, attrs: { min: "50" }, help: "Provider rate limits still apply on top." }),
          field({ label: "Fixed interval (ms)", name: "fixedIntervalMs", type: "number", value: mon.fixedIntervalMs ?? 5000, attrs: { min: "100" } }),
          field({ label: "Request timeout (ms)", name: "requestTimeoutMs", type: "number", value: mon.requestTimeoutMs ?? 2500, attrs: { min: "100" } }))))),
    panel("Availability sources", h("div", { class: "stack" },
      h("div", { class: "stack-sm" }, availAccounts.map((a) => checkbox({ name: "sources", value: a.id, label: a.id, help: a.builtin ? "Registry data (advisory)" : a.provider, checked: (av.providers || []).includes(a.id) }))),
      h("div", { class: "form-grid" },
        field({ label: "Decide available when", name: "quorum", control: select("quorum", [["any", "Any source says so (fastest)"], ["majority", "Most sources agree"], ["registry-confirmed", "Registry and a registrar agree"]], av.quorum?.mode || "any") }),
        field({ label: "Minimum confirmations", name: "minimumConfirmations", type: "number", value: av.quorum?.minimumConfirmations ?? 1, attrs: { min: "1" } })))),
    panel("Registration", regSection),
    panel("Notifications", checkbox({ name: "discord", label: "Discord notifications for this target", checked: t.notifications?.discord?.enabled !== false })),
    h("div", { class: "form-foot" },
      editing ? button("Delete target", { kind: "danger", iconName: "trash", onClick: () => deleteTarget(editing) }) : null,
      h("span", { style: "flex:1" }),
      linkButton("Cancel", editing ? `#/targets/${encodeURIComponent(editing)}` : "#/overview", { kind: "ghost" }),
      button("Save target", { kind: "primary", type: "submit", iconName: "floppy-disk" })));

  const domainInput = form.querySelector('input[name="domain"]');
  const idInput = form.querySelector('input[name="id"]');
  if (!editing) domainInput.addEventListener("input", () => (idInput.value = domainInput.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")));
  const buying = form.querySelector("[data-buying]");
  const syncMode = () => (buying.hidden = formData(form).mode === "notify-only");
  form.addEventListener("change", syncMode);
  syncMode();

  onSubmit(form, async (d) => {
    const num = (v) => (v === "" || v === undefined ? undefined : Number(v));
    const mode = d.mode || "notify-only";
    const target = {
      id: d.id.trim(),
      domain: d.domain.trim(),
      enabled: d.enabled,
      drop: d.expectedAt ? { expectedAt: `${d.expectedAt}:00`.slice(0, 19), timezone: d.timezone, preWindowSeconds: num(d.preMinutes) * 60, postWindowSeconds: num(d.postMinutes) * 60 } : undefined,
      monitoring: {
        strategy: d.strategy, initialIntervalMs: num(d.initialIntervalMs), warmupIntervalMs: num(d.warmupIntervalMs), hotIntervalMs: num(d.hotIntervalMs),
        hotWindowSeconds: num(d.hotWindowSeconds), fixedIntervalMs: num(d.fixedIntervalMs), requestTimeoutMs: num(d.requestTimeoutMs),
      },
      availability: { providers: d.sources || [], quorum: { mode: d.quorum, minimumConfirmations: num(d.minimumConfirmations) } },
      registration: {
        enabled: mode !== "notify-only",
        mode,
        providers: d.registrars || [],
        maxAttemptsPerProvider: num(d.maxAttemptsPerProvider),
        maxTotalAttempts: num(d.maxTotalAttempts),
        onFailure: d.onFailure,
        restrictToDropWindow: d.restrictToDropWindow,
        budget: {
          maxRegistrationPrice: num(d.maxRegistrationPrice),
          currency: (d.currency || "USD").toUpperCase(),
          allowPremium: d.allowPremium,
          expectedPrice: num(d.expectedPrice),
          requireExactPrice: d.requireExactPrice,
        },
      },
      notifications: { discord: { enabled: d.discord } },
    };
    const res = await api("PUT", `/api/config/targets/${encodeURIComponent(editing || target.id)}`, { target });
    toast(res.restartNeeded?.length ? "Saved. Restart running watches to apply the change." : "Target saved.", "success");
    location.hash = `#/targets/${encodeURIComponent(target.id)}`;
  });

  return {
    title: editing ? `Edit ${editing}` : "New target",
    section: "overview",
    node: h("div", { class: "stack" }, pageHead(editing ? `Edit ${editing}` : "New target", "Changes are validated and written to config.yaml. The previous version is kept as config.yaml.bak."), form),
  };
}

async function deleteTarget(id) {
  if (!(await confirmDialog({ title: `Delete ${id}?`, body: "The target is removed from config.yaml. Its history stays in the database.", confirmLabel: "Delete", danger: true }))) return;
  try {
    await api("DELETE", `/api/config/targets/${encodeURIComponent(id)}`);
    toast(`${id} deleted.`, "success");
    location.hash = "#/overview";
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ---------------------------------------------------------------- check

async function pageCheck(_p, query) {
  if (!S.meta) await loadMeta();
  const results = h("div", { class: "stack" });
  const form = h("form", { class: "row", novalidate: true },
    h("div", { style: "flex:1;min-width:240px" }, field({ label: "Domain", name: "domain", value: query.get("domain") || "", placeholder: "example.pl", required: true, autocomplete: "off" })),
    h("div", { style: "align-self:end" }, button("Check now", { kind: "primary", type: "submit", iconName: "magnifying-glass" })));
  onSubmit(form, async (d) => {
    const r = await api("POST", "/api/check", { domain: d.domain });
    results.replaceChildren(renderCheck(r));
  }, "Checking…");
  if (query.get("domain")) setTimeout(() => form.isConnected && form.requestSubmit(), 0);
  return {
    title: "Check",
    section: "check",
    node: h("div", { class: "stack" }, pageHead("Check a domain", "One request to every configured source. Nothing is bought."), panel(null, form), results),
  };
}

function renderCheck(r) {
  const decision = { positive: ["Available signal", "success"], negative: ["Taken", "danger"], inconclusive: ["Inconclusive", "warning"] }[r.decision];
  return h("div", { class: "stack" },
    h("div", { class: `banner ${decision[1] === "success" ? "info" : decision[1]}` }, icon(r.decision === "positive" ? "check-circle" : r.decision === "negative" ? "x-circle" : "question"),
      h("div", {}, h("strong", { text: `${decision[0]} ` }), `${r.unicode}, quorum ${r.quorum}: ${r.basis}`)),
    panel("Sources", r.results.length
      ? h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Source", "Status", "Price", "Premium", "Latency", "Detail"].map((x) => h("th", { text: x })))),
        h("tbody", {}, r.results.map((c) => h("tr", {},
          h("td", { text: c.provider }), h("td", { class: `status-${c.status}`, text: STATUS_LABEL[c.status] || c.status }),
          h("td", { text: c.price ? fmtMoney(c.price) : "n/a" }), h("td", { text: c.premium === undefined ? "n/a" : c.premium ? "yes" : "no" }),
          h("td", { text: `${c.latencyMs} ms` }), h("td", { class: "truncate", title: c.reason || "", text: [c.reason, c.errorCode, c.advisory ? "advisory" : ""].filter(Boolean).join(", ") }))))))
      : empty("No usable sources", null), { flush: true }),
    r.skipped.length ? panel("Skipped", h("ul", {}, r.skipped.map((s) => h("li", { text: `${s.account}: ${s.reason}` })))) : null,
    r.clockSkewMs !== undefined && Math.abs(r.clockSkewMs) > 1500
      ? h("div", { class: "banner warning" }, icon("timer"), h("div", { text: `Servers report a time about ${(r.clockSkewMs / 1000).toFixed(1)} s away from this machine. Check NTP; drop timing depends on it.` }))
      : null,
    r.tldNotes.length ? h("div", { class: "help" }, r.tldNotes.map((n) => h("p", { text: n }))) : null);
}

// ---------------------------------------------------------------- providers

async function pageProviders() {
  if (!S.meta) await loadMeta();
  const [p, secrets, cfg] = await Promise.all([api("GET", "/api/providers"), api("GET", "/api/secrets"), api("GET", "/api/config")]);
  const secretByName = Object.fromEntries(secrets.secrets.map((s) => [s.name, s]));

  const accountBlock = (a) => {
    const plugin = p.providers.find((x) => x.id === a.provider);
    const result = h("div", { class: "panel-body test-result help", "aria-live": "polite" },
      a.error && a.credentials.every((c) => c.set || !c.required) ? h("span", { class: "error-text", text: a.error }) : null);
    const rows = a.credentials.map((c) => {
      const s = secretByName[c.env];
      const valueForm = h("form", { class: "row", hidden: true },
        h("input", { type: "password", name: "value", autocomplete: "off", spellcheck: "false", "aria-label": `Value for ${c.env}`, style: "max-width:320px" }),
        button("Save", { kind: "primary sm", type: "submit" }));
      onSubmit(valueForm, async (d) => {
        await api("PUT", `/api/secrets/${encodeURIComponent(c.env)}`, { value: d.value });
        toast(`${c.env} saved to ${secrets.envPath}.`, "success");
        render({ quiet: true });
      });
      return h("tr", {},
        h("td", { text: c.field }),
        h("td", {}, h("code", { text: c.env })),
        h("td", {}, c.set ? badge("Set", "success") : c.required ? badge("Missing", "danger") : badge("Optional")),
        h("td", {}, h("div", { class: "row" },
          button(c.set ? "Replace" : "Set value", { kind: "sm", iconName: "key", onClick: () => { valueForm.hidden = !valueForm.hidden; valueForm.querySelector("input").focus(); } }),
          s?.inFile ? button("", { kind: "ghost sm", iconName: "trash", title: `Remove ${c.env} from .env`, onClick: () => removeSecret(c.env) }) : null),
          valueForm));
    });
    return h("article", { class: "panel" },
      h("div", { class: "panel-head" },
        h("div", { class: "row" }, h("h2", { text: a.id }), badge(plugin?.name || a.provider), badge(a.environment, `mono ${a.environment === "production" ? "" : "accent"}`), a.enabled ? null : badge("Disabled", "warning")),
        h("div", { class: "actions" },
          button("Test connection", { kind: "sm", iconName: "plugs-connected", onClick: async (e) => {
            e.currentTarget.disabled = true;
            result.textContent = "Testing…";
            try {
              const r = await api("POST", `/api/providers/${encodeURIComponent(a.id)}/test`);
              result.replaceChildren(r.health ? h("span", { class: r.health.ok ? "status-available" : "status-error", text: `${r.health.ok ? "Connected" : "Failed"}${r.health.latencyMs !== undefined ? ` in ${r.health.latencyMs} ms` : ""}. ${r.health.detail || ""}` }) : h("span", { class: "status-error", text: r.error || "No health check available." }));
            } catch (err) {
              result.textContent = err.message;
            } finally {
              e.currentTarget.disabled = false;
            }
          } }),
          button("Edit", { kind: "sm", iconName: "pencil-simple", onClick: () => accountDialog(p.providers, cfg.raw.accounts?.[a.id], a.id) }),
          button("", { kind: "ghost sm", iconName: "trash", title: `Remove ${a.id}`, onClick: () => removeAccount(a.id) }))),
      h("div", { class: "panel-body flush" },
        a.credentials.length
          ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ["Credential", "Environment variable", "Status", ""].map((x) => h("th", { text: x })))), h("tbody", {}, rows)))
          : h("p", { class: "panel-body muted", text: "No credentials needed." })),
      result);
  };

  const accounts = p.accounts.filter((a) => a.id !== "rdap");
  const capabilities = [["availability", "Availability check"], ["pricing", "Pricing"], ["registration", "Registration"], ["preflight", "Server-side dry run"], ["ownershipLookup", "Ownership lookup"], ["sandbox", "Sandbox"], ["premiumRegistration", "Premium via API"]];
  const plugins = p.providers.filter((x) => x.id !== "mock");
  return {
    title: "Providers",
    section: "providers",
    node: h("div", { class: "stack" },
      pageHead("Providers", `Secrets are written to ${secrets.envPath} and never shown again.`,
        button("Add account", { kind: "primary", iconName: "plus", onClick: () => accountDialog(p.providers, null, null) })),
      accounts.length ? accounts.map(accountBlock) : panel(null, empty("No registrar accounts", "RDAP works without an account. Add a registrar to get real-time checks and registration.",
        button("Add account", { kind: "primary", iconName: "plus", onClick: () => accountDialog(p.providers, null, null) }))),
      panel("Capabilities", h("div", { class: "table-wrap" }, h("table", { class: "matrix" },
        h("thead", {}, h("tr", {}, h("th", { text: "Capability" }), plugins.map((x) => h("th", { text: x.name })))),
        h("tbody", {}, capabilities.map(([key, label]) => h("tr", {}, h("td", { text: label }),
          plugins.map((x) => h("td", {}, x.capabilities[key] ? icon("check-circle", "yes") : h("span", { class: "dim", text: "no" })))))))), { flush: true }),
      panel("Other secrets", h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Variable", "Used by", "Status"].map((x) => h("th", { text: x })))),
        h("tbody", {}, secrets.secrets.filter((s) => !accounts.some((a) => a.credentials.some((c) => c.env === s.name))).map((s) => h("tr", {},
          h("td", {}, h("code", { text: s.name })), h("td", { text: s.usedBy.join(", ") }), h("td", {}, s.set ? badge("Set", "success") : badge("Missing", "warning"))))))), { flush: true })),
  };
}

const OPTION_HINTS = {
  porkbun: "whoisPrivacy: true",
  ovh: "endpoint: ovh-eu\novhSubsidiary: PL\nownerContact: 12345\nautoPay: true",
  namecheap: "contact:\n  firstName: Marta\n  lastName: Kowalczyk\n  address1: ul. Prosta 12\n  city: Warszawa\n  stateProvince: Mazowieckie\n  postalCode: 00-850\n  country: PL\n  phone: +48.221234567\n  email: marta@example.pl",
  cloudflare: "privacyMode: redaction\nautoRenew: false",
  mock: "scenario: available-after-checks\navailableAfterChecks: 3\nprice: 9.99",
};

function yamlOf(obj) {
  if (!obj || typeof obj !== "object") return "";
  const lines = [];
  const walk = (o, indent) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        lines.push(`${" ".repeat(indent)}${k}:`);
        walk(v, indent + 2);
      } else lines.push(`${" ".repeat(indent)}${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`);
    }
  };
  walk(obj, 0);
  return lines.join("\n");
}

function accountDialog(plugins, raw, id) {
  const usable = plugins.filter((x) => x.id !== "rdap");
  const providerSelect = select("provider", usable.map((x) => [x.id, x.name]), raw?.provider || "porkbun");
  const creds = h("div", { class: "stack-sm" });
  const options = h("textarea", { name: "optionsYaml", rows: 5, class: "code", style: "min-height:120px", spellcheck: "false" });
  options.value = yamlOf(raw?.options);
  const idInput = h("input", { type: "text", name: "id", value: id || "", required: true, readOnly: Boolean(id), autocomplete: "off", spellcheck: "false" });
  const envSelect = select("environment", [["production", "Production"], ["sandbox", "Sandbox"], ["mock", "Mock (development only)"]], raw?.environment || "production");
  const syncCreds = () => {
    const plugin = usable.find((x) => x.id === providerSelect.value);
    creds.replaceChildren(...(plugin?.credentials || []).map((c) =>
      field({ label: `${c.description} (${c.required ? "required" : "optional"})`, name: `cred:${c.name}`, value: raw?.credentials?.[c.name] || c.defaultEnv, help: "Name of the environment variable, not the secret.", attrs: { class: "mono" } })));
    if (!plugin?.credentials.length) creds.append(h("p", { class: "muted", text: "This provider needs no credentials." }));
    options.placeholder = OPTION_HINTS[providerSelect.value] || "";
    if (!id) idInput.value = `${providerSelect.value}-main`;
    envSelect.value = providerSelect.value === "mock" ? "mock" : envSelect.value === "mock" ? "production" : envSelect.value;
  };
  providerSelect.addEventListener("change", syncCreds);
  const form = h("form", { class: "panel-body", novalidate: true },
    h("h2", { text: id ? `Edit ${id}` : "Add registrar account" }),
    h("div", { class: "form-grid" },
      field({ label: "Provider", name: "provider", control: providerSelect }),
      field({ label: "Account id", name: "id", control: idInput }),
      field({ label: "Environment", name: "environment", control: envSelect, help: "Sandbox uses test money where the provider offers it." }),
      h("div", { class: "wide" }, checkbox({ name: "enabled", label: "Enabled", checked: raw ? raw.enabled !== false : true }))),
    creds,
    field({ label: "Options (YAML, optional)", name: "optionsYaml", control: options }),
    h("div", { class: "form-foot" }, button("Cancel", { onClick: () => dialog.close() }), button("Save account", { kind: "primary", type: "submit" })));
  const dialog = h("dialog", { style: "width:min(640px, calc(100% - 32px))" }, form);
  onSubmit(form, async (d) => {
    const credentials = {};
    for (const [k, v] of Object.entries(d)) if (k.startsWith("cred:") && v.trim()) credentials[k.slice(5)] = v.trim();
    await api("PUT", `/api/config/accounts/${encodeURIComponent(d.id.trim())}`, {
      provider: d.provider, environment: d.environment, enabled: d.enabled, credentials, optionsYaml: d.optionsYaml,
    });
    dialog.close();
    toast("Account saved. Set its secrets below.", "success");
    render({ quiet: true });
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  syncCreds();
  dialog.showModal();
}

async function removeAccount(id) {
  if (!(await confirmDialog({ title: `Remove ${id}?`, body: "Targets that still use this account must be changed first, or the save is refused.", confirmLabel: "Remove", danger: true }))) return;
  try {
    await api("DELETE", `/api/config/accounts/${encodeURIComponent(id)}`);
    toast(`${id} removed.`, "success");
    render({ quiet: true });
  } catch (err) {
    toast([err.message, ...(err.data.issues || [])].join(" "), "danger");
  }
}

async function removeSecret(name) {
  if (!(await confirmDialog({ title: `Remove ${name}?`, body: "The value is deleted from the .env file.", confirmLabel: "Remove", danger: true }))) return;
  try {
    await api("DELETE", `/api/secrets/${encodeURIComponent(name)}`);
    toast(`${name} removed.`, "success");
    render({ quiet: true });
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ---------------------------------------------------------------- notifications

const EVENT_TYPES = ["watch_started", "drop_window_entered", "hot_window_entered", "availability_detected", "availability_false_positive", "purchase_blocked", "budget_exceeded", "confirmation_requested", "confirmation_declined", "registration_started", "registration_succeeded", "registration_failed", "registration_pending", "registration_ambiguous", "dry_run_registration", "provider_error", "rate_limited", "provider_recovered", "clock_jump", "watch_finished"];
const DEFAULT_EVENTS = ["watch_started", "drop_window_entered", "availability_detected", "purchase_blocked", "budget_exceeded", "confirmation_requested", "registration_started", "registration_succeeded", "registration_failed", "registration_pending", "registration_ambiguous", "dry_run_registration", "provider_error", "rate_limited", "provider_recovered", "watch_finished"];

async function pageNotifications() {
  if (!S.meta) await loadMeta();
  const [cfg, secrets] = await Promise.all([api("GET", "/api/config"), api("GET", "/api/secrets")]);
  const discord = cfg.raw.notifications?.discord || {};
  const hookEnv = discord.webhookEnv || "DISCORD_WEBHOOK_URL";
  const hook = secrets.secrets.find((s) => s.name === hookEnv);
  const selected = discord.events || DEFAULT_EVENTS;

  const hookForm = h("form", { class: "row", novalidate: true },
    h("div", { style: "flex:1;min-width:260px" }, field({ label: "Webhook URL", name: "value", type: "password", autocomplete: "off", placeholder: "https://discord.com/api/webhooks/…", help: `Stored as ${hookEnv} in ${secrets.envPath}. It is never displayed again.` })),
    h("div", { style: "align-self:center" }, button(hook?.set ? "Replace webhook" : "Save webhook", { kind: "primary", type: "submit", iconName: "key" })));
  onSubmit(hookForm, async (d) => {
    await api("PUT", `/api/secrets/${encodeURIComponent(hookEnv)}`, { value: d.value });
    toast("Webhook saved.", "success");
    render({ quiet: true });
  });

  const settings = h("form", { class: "stack", novalidate: true },
    checkbox({ name: "enabled", label: "Discord notifications on", checked: discord.enabled !== false }),
    h("div", { class: "form-grid" },
      field({ label: "Bot name", name: "username", value: discord.username || "dropcatch" }),
      field({ label: "Role to mention on purchases (optional)", name: "mentionRoleId", value: discord.mentionRoleId || "", help: "Numeric role id. Only that role is ever pinged.", attrs: { inputmode: "numeric", class: "mono" } }),
      field({ label: "Webhook variable name", name: "webhookEnv", value: hookEnv, attrs: { class: "mono" } })),
    h("fieldset", {}, h("legend", { text: "Events to send" }),
      h("div", { class: "grid-2" }, EVENT_TYPES.map((e) => checkbox({ name: "events", value: e, label: e.replaceAll("_", " "), checked: selected.includes(e) })))),
    h("div", { class: "form-foot" }, button("Save settings", { kind: "primary", type: "submit" })));
  onSubmit(settings, async (d) => {
    await api("PATCH", "/api/config/notifications", {
      discord: { enabled: d.enabled, username: d.username, mentionRoleId: d.mentionRoleId || null, webhookEnv: d.webhookEnv, events: d.events },
    });
    toast("Notification settings saved.", "success");
    render({ quiet: true });
  });

  const tg = cfg.raw.notifications?.telegram || {};
  const tokenEnv = tg.botTokenEnv || "TELEGRAM_BOT_TOKEN";
  const token = secrets.secrets.find((s) => s.name === tokenEnv);
  const tgSelected = tg.events || DEFAULT_EVENTS;
  const tokenForm = h("form", { class: "row", novalidate: true },
    h("div", { style: "flex:1;min-width:260px" }, field({ label: "Bot token", name: "value", type: "password", autocomplete: "off", placeholder: "123456789:AA…", help: `From @BotFather. Stored as ${tokenEnv}; never displayed again.` })),
    h("div", { style: "align-self:center" }, button(token?.set ? "Replace token" : "Save token", { kind: "primary", type: "submit", iconName: "key" })));
  onSubmit(tokenForm, async (d) => {
    await api("PUT", `/api/secrets/${encodeURIComponent(tokenEnv)}`, { value: d.value });
    toast("Telegram bot token saved.", "success");
    render({ quiet: true });
  });
  const chatInput = h("input", { type: "text", name: "chatId", value: tg.chatId || "", autocomplete: "off", spellcheck: "false", class: "mono", placeholder: "123456789 or -100… for groups" });
  const chatList = h("div", { class: "stack-sm", "aria-live": "polite" });
  const tgForm = h("form", { class: "stack", novalidate: true },
    checkbox({ name: "enabled", label: "Telegram notifications on", checked: tg.enabled === true }),
    h("div", { class: "form-grid" },
      field({ label: "Chat id", name: "chatId", control: chatInput, help: "Send any message to your bot, then use Find my chat." }),
      h("div", { style: "align-self:end" }, button("Find my chat", { iconName: "magnifying-glass", disabled: !token?.set, onClick: async () => {
        try {
          const r = await api("GET", "/api/telegram/chats");
          chatList.replaceChildren(...(r.chats.length
            ? r.chats.map((c) => h("div", { class: "row" }, h("code", { text: String(c.id) }), h("span", { class: "muted", text: `${c.type || ""} ${c.title || c.username || c.first_name || ""}` }),
              button("Use this chat", { kind: "sm", onClick: () => (chatInput.value = String(c.id)) })))
            : [h("p", { class: "muted", text: "No chats yet. Send a message to your bot first, then try again." })]));
        } catch (err) {
          toast(err.message, "danger");
        }
      } }))),
    chatList,
    h("fieldset", {}, h("legend", { text: "Events to send (detections and purchases ring, the rest arrive silently)" }),
      h("div", { class: "grid-2" }, EVENT_TYPES.map((e) => checkbox({ name: "events", value: e, label: e.replaceAll("_", " "), checked: tgSelected.includes(e) })))),
    h("div", { class: "form-foot" },
      button("Send test message", { iconName: "paper-plane-tilt", disabled: !token?.set || !tg.chatId, onClick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api("POST", "/api/telegram/test");
          toast("Telegram test message delivered.", "success");
        } catch (err) {
          toast(err.message, "danger");
        } finally {
          e.currentTarget.disabled = false;
        }
      } }),
      button("Save Telegram settings", { kind: "primary", type: "submit" })));
  onSubmit(tgForm, async (d) => {
    await api("PATCH", "/api/config/notifications", { telegram: { enabled: d.enabled, chatId: d.chatId.trim() || null, events: d.events } });
    toast("Telegram settings saved.", "success");
    render({ quiet: true });
  });

  return {
    title: "Notifications",
    section: "notifications",
    node: h("div", { class: "stack" },
      pageHead("Notifications", "Discord and Telegram get events in the background. A slow or failing channel never delays a purchase.",
        button("Send test message", { iconName: "paper-plane-tilt", disabled: !hook?.set, onClick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api("POST", "/api/discord/test");
            toast("Discord test message delivered.", "success");
          } catch (err) {
            toast(err.message, "danger");
          } finally {
            e.currentTarget.disabled = false;
          }
        } })),
      panel("Discord webhook", h("div", { class: "stack-sm" },
        h("div", { class: "row" }, hook?.set ? badge("Webhook set", "success") : badge("No webhook yet", "warning")),
        hookForm)),
      panel("Discord settings", settings),
      panel("Telegram", h("div", { class: "stack" },
        h("div", { class: "row" },
          token?.set ? badge("Bot token set", "success") : badge("No bot token yet", "warning"),
          tg.chatId ? badge(`Chat ${tg.chatId}`, "mono") : badge("No chat id yet", "warning"),
          tg.enabled ? badge("On", "success") : badge("Off")),
        tokenForm,
        tgForm))),
  };
}

// ---------------------------------------------------------------- activity

async function pageActivity(_p, query) {
  const o = await loadMeta();
  const target = query.get("target") || "";
  const data = await api("GET", `/api/events?limit=300${target ? `&target=${encodeURIComponent(target)}` : ""}`);
  const filter = select("target", [["", "All targets"], ...o.targets.map((t) => [t.id, t.domain])], target);
  filter.setAttribute("aria-label", "Filter by target");
  filter.style.width = "auto";
  filter.addEventListener("change", () => (location.hash = `#/activity${filter.value ? `?target=${encodeURIComponent(filter.value)}` : ""}`));
  const attempts = data.attempts.length
    ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ["Started", "Target", "Provider", "Status", "Price", "Detail"].map((x) => h("th", { text: x })))),
      h("tbody", {}, data.attempts.map((a) => h("tr", {},
        h("td", { text: fmtIso(a.startedAt, { date: true }) }), h("td", { text: a.targetId }), h("td", { text: a.provider }),
        h("td", {}, a.dryRun ? badge("dry run") : stateBadge(a.status.toUpperCase())),
        h("td", { text: a.priceAmount !== null ? fmtMoney({ amount: a.priceAmount, currency: a.priceCurrency }) : "n/a" }),
        h("td", { class: "truncate", title: a.reason || "", text: a.providerReference || a.errorCode || a.reason || "" }))))))
    : empty("No purchase attempts", null);
  return {
    title: "Activity",
    section: "activity",
    node: h("div", { class: "stack" },
      pageHead("Activity", "Every event and purchase attempt, as stored in the audit database.", filter),
      panel("Purchase attempts", attempts, { flush: true }),
      panel("Events", feed(data.events, { withTarget: !target }), { flush: true })),
  };
}

// ---------------------------------------------------------------- settings

async function pageSettings() {
  const o = await loadMeta();
  const cfg = await api("GET", "/api/config");
  const app = cfg.raw.app || {};

  const general = h("form", { class: "stack", novalidate: true },
    h("div", { class: "form-grid" },
      h("div", { class: "field", dataset: { field: "timezone" } }, h("span", { class: "label-text", text: "Display timezone" }), timezoneInput("timezone", app.timezone || "UTC"), h("span", { class: "error-text", hidden: true })),
      field({ label: "Log level", name: "logLevel", control: select("logLevel", ["trace", "debug", "info", "warn", "error"].map((l) => [l, l]), app.logLevel || "info") }),
      field({ label: "Profile", name: "profile", control: select("profile", [["production", "Production"], ["testing", "Testing (sandbox accounts only)"], ["development", "Development (always dry run)"]], cfg.raw.profile || "production") })),
    h("div", { class: "form-foot" }, button("Save", { kind: "primary", type: "submit" })));
  onSubmit(general, async (d) => {
    await api("PATCH", "/api/config/app", { timezone: d.timezone, logLevel: d.logLevel, profile: d.profile });
    toast("Settings saved.", "success");
    render({ quiet: true });
  });

  const live = !o.app.dryRun;
  const safety = h("div", { class: "stack-sm" },
    h("div", { class: "row" }, live ? badge("Live purchasing", "danger", icon("lightning")) : badge("Dry run", "success", icon("shield-check")),
      h("span", { class: "muted", text: live ? "Registrations are real and charge your account." : "Checks, gates and previews run, but no registration request is ever sent." })),
    h("div", { class: "row" }, live
      ? button("Turn dry run back on", { onClick: async () => {
        try {
          await api("PATCH", "/api/config/app", { dryRun: true });
          toast("Dry run is on again.", "success");
          render({ quiet: true });
        } catch (err) {
          toast(err.message, "danger");
        }
      } })
      : button("Enable live purchasing", { kind: "danger", iconName: "lightning", disabled: o.app.profile === "development", title: o.app.profile === "development" ? "The development profile always runs dry" : undefined, onClick: async () => {
        const ok = await confirmDialog({
          title: "Enable live purchasing?",
          body: h("div", { class: "stack-sm" },
            h("p", { class: "muted", text: "Targets in confirm or auto-buy mode will send real, non-refundable registration requests within their budget." }),
            h("p", { class: "muted", text: "Running watches keep dry run until you restart them." })),
          confirmLabel: "Go live",
          danger: true,
          typed: "GO LIVE",
        });
        if (!ok) return;
        try {
          await api("PATCH", "/api/config/app", { dryRun: false, confirmLive: "GO LIVE" });
          toast("Live purchasing enabled.", "danger", { sticky: false });
          render({ quiet: true });
        } catch (err) {
          toast([err.message, ...(err.data.issues || [])].join(" "), "danger");
        }
      } })));

  const password = h("form", { class: "stack", novalidate: true },
    h("div", { class: "form-grid" },
      field({ label: "Current password", name: "current", type: "password", autocomplete: "current-password" }),
      field({ label: "New password", name: "next", type: "password", autocomplete: "new-password", help: "At least 10 characters." })),
    h("div", { class: "form-foot" },
      button("Sign out other sessions", { onClick: async () => {
        const r = await api("POST", "/api/sessions/revoke-others");
        toast(`${r.revoked} other session${r.revoked === 1 ? "" : "s"} signed out.`, "success");
      } }),
      button("Change password", { kind: "primary", type: "submit" })));
  onSubmit(password, async (d, form) => {
    const r = await api("POST", "/api/password", d);
    form.reset();
    toast(`Password changed. ${r.revokedSessions} other session${r.revokedSessions === 1 ? "" : "s"} signed out.`, "success");
  });

  return {
    title: "Settings",
    section: "settings",
    node: h("div", { class: "stack" },
      pageHead("Settings", cfg.path, [
        button(document.documentElement.dataset.theme === "light" ? "Dark theme" : "Light theme", { iconName: "eye", onClick: () => { toggleTheme(); render({ quiet: true }); } }),
        button("Sign out", { iconName: "sign-out", onClick: signOut }),
        linkButton("Raw config", "#/config", { iconName: "code" }),
      ]),
      panel("Safety", safety),
      panel("General", general),
      panel("Dashboard password", password),
      panel("Files", kvList([
        ["Config", h("code", { text: cfg.path })],
        ["Secrets", h("code", { text: cfg.envPath })],
        ["Database", h("code", { text: o.app.database })],
        ["Version", o.version],
      ]))),
  };
}

async function pageRawConfig() {
  if (!S.meta) await loadMeta();
  const cfg = await api("GET", "/api/config");
  const editor = h("textarea", { name: "yaml", class: "code", spellcheck: "false", "aria-label": "config.yaml" });
  editor.value = cfg.yaml || "# No config yet. Use Overview > quick setup, or paste a config here.\n";
  const report = h("div", { class: "stack-sm", "aria-live": "polite" });
  const showReport = (r) => report.replaceChildren(
    r.ok ? h("div", { class: "banner info" }, icon("check-circle"), h("div", { text: "Valid configuration." })) : null,
    r.issues?.length ? h("div", { class: "banner danger" }, icon("warning"), h("ul", {}, r.issues.map((i) => h("li", { text: i })))) : null,
    r.warnings?.length ? h("div", { class: "banner warning" }, icon("info"), h("ul", {}, r.warnings.map((i) => h("li", { text: i })))) : null);
  const form = h("form", { class: "stack", novalidate: true }, editor,
    h("div", { class: "form-foot" },
      button("Validate", { iconName: "check-circle", onClick: async () => showReport(await api("POST", "/api/config/validate", { yaml: editor.value })) }),
      button("Save config", { kind: "primary", type: "submit", iconName: "floppy-disk" })));
  onSubmit(form, async () => {
    const r = await api("PUT", "/api/config", { yaml: editor.value });
    showReport({ ok: true, warnings: r.warnings });
    toast("config.yaml saved. The previous version is config.yaml.bak.", "success");
  });
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  if (cfg.error) showReport({ ok: false, issues: cfg.error });
  return {
    title: "Raw config",
    section: "settings",
    node: h("div", { class: "stack" },
      pageHead("Raw config", `${cfg.path}. Secrets are rejected here: reference them by environment variable name.`),
      report, form),
  };
}

// ---------------------------------------------------------------- clock

function clockInstrument(c) {
  let value = "n/a";
  let hint = "measuring…";
  if (!c.enabled) {
    value = "off";
    hint = "NTP check disabled in config";
  } else if (c.error && c.offsetMs === undefined) {
    hint = "NTP unreachable, using system clock";
  } else if (c.offsetMs !== undefined) {
    const abs = Math.abs(c.offsetMs);
    value = abs < 20 ? "in sync" : `${(abs / 1000).toFixed(2)}\u00a0s ${c.offsetMs > 0 ? "slow" : "fast"}`;
    hint = `${c.server}${abs >= 20 ? (c.applied ? ", corrected" : ", not corrected") : ""}`;
  }
  return h("div", { class: "instrument" }, h("span", { class: "label", text: "Clock vs NTP" }),
    h("span", { class: "value", text: value }), h("span", { class: "hint", text: hint }));
}

// ---------------------------------------------------------------- latency chart (small multiples)

function percentile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

function latencyPanel(series) {
  const byProvider = new Map();
  for (const p of series) {
    if (!byProvider.has(p.provider)) byProvider.set(p.provider, []);
    byProvider.get(p.provider).push(p);
  }
  if (!byProvider.size) return empty("No measurements yet", "Response times appear once the target has been checked.");
  const definitive = series.filter((p) => p.status === "available" || p.status === "unavailable");
  const all = definitive.map((p) => p.ms).sort((a, b) => a - b);
  const yMax = Math.max(50, Math.ceil((percentile(all, 0.98) * 1.2) / 10) * 10);
  const tMin = Math.min(...series.map((p) => p.t));
  const tMax = Math.max(...series.map((p) => p.t), tMin + 1);
  const rows = [...byProvider.entries()].map(([provider, points]) => {
    const ok = points.filter((p) => p.status === "available" || p.status === "unavailable");
    const sorted = ok.map((p) => p.ms).sort((a, b) => a - b);
    const problems = points.length - ok.length;
    return h("div", { class: "spark-row" },
      h("div", { class: "spark-meta" },
        h("div", { class: "name", text: provider }),
        h("div", { class: "nums" },
          h("span", { text: `p50 ${percentile(sorted, 0.5)}\u00a0ms` }), " ",
          h("span", { class: "muted", text: `p95 ${percentile(sorted, 0.95)}\u00a0ms` })),
        problems ? h("div", { class: "help", text: `${problems} error${problems > 1 ? "s" : ""} or rate limits (gaps)` }) : null),
      sparkline(points, { yMax, tMin, tMax, label: provider }));
  });
  return h("div", {}, rows, h("p", { class: "help chart-note", text: `Last ${series.length} checks. Shared scale 0 to ${yMax}\u00a0ms. Hover or use the arrow keys for exact values.` }));
}

function sparkline(points, { yMax, tMin, tMax, label }) {
  const W = 600;
  const H = 56;
  const x = (t) => ((t - tMin) / (tMax - tMin)) * W;
  const y = (ms) => H - Math.min(1, ms / yMax) * (H - 4) - 2;
  const good = (p) => p.status === "available" || p.status === "unavailable";
  let line = "";
  let area = "";
  let run = [];
  const flush = () => {
    if (run.length) {
      const seg = run.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.ms).toFixed(1)}`).join("");
      line += seg;
      area += `${seg}L${x(run[run.length - 1].t).toFixed(1)},${H}L${x(run[0].t).toFixed(1)},${H}Z`;
    }
    run = [];
  };
  for (const p of points) {
    if (good(p)) run.push(p);
    else flush();
  }
  flush();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const mk = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
    return el;
  };
  mk("line", { class: "base", x1: "0", x2: String(W), y1: String(H - 0.5), y2: String(H - 0.5) });
  if (area) mk("path", { class: "area", d: area });
  if (line) mk("path", { class: "line", d: line });

  const last = [...points].reverse().find(good);
  const cross = h("span", { class: "cross", hidden: true });
  const tip = h("span", { class: "tip", role: "status", hidden: true });
  const dot = last ? h("span", { class: "dot", style: `left:${(x(last.t) / W) * 100}%;top:${(y(last.ms) / H) * 100}%` }) : null;
  const wrap = h("div", {
    class: "spark",
    tabindex: "0",
    role: "img",
    "aria-label": `${label} response time, ${points.length} checks${last ? `, latest ${last.ms} ms` : ""}`,
  }, svg, dot, cross, tip);
  let index = points.length - 1;
  const show = (i) => {
    index = Math.max(0, Math.min(points.length - 1, i));
    const p = points[index];
    const left = `${(x(p.t) / W) * 100}%`;
    cross.style.left = left;
    tip.style.left = left;
    cross.hidden = false;
    tip.hidden = false;
    tip.replaceChildren(
      h("strong", { text: good(p) ? `${p.ms}\u00a0ms` : STATUS_LABEL[p.status] || p.status }),
      h("span", { class: "muted", text: ` ${fmtTime(p.t)}${good(p) ? `, ${STATUS_LABEL[p.status]}` : ""}` }));
  };
  const hide = () => {
    cross.hidden = true;
    tip.hidden = true;
  };
  wrap.addEventListener("pointermove", (e) => {
    const r = wrap.getBoundingClientRect();
    const t = tMin + ((e.clientX - r.left) / r.width) * (tMax - tMin);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    show(best);
  });
  wrap.addEventListener("pointerleave", hide);
  wrap.addEventListener("focus", () => show(index));
  wrap.addEventListener("blur", hide);
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      show(index + (e.key === "ArrowRight" ? 1 : -1));
    }
  });
  return wrap;
}

// ---------------------------------------------------------------- import

async function importDialog() {
  const cfg = await api("GET", "/api/config");
  const regAccounts = cfg.accounts.filter((a) => a.registration && a.provider !== "mock");
  const text = h("textarea", { name: "text", class: "code", rows: 8, spellcheck: "false", style: "min-height:160px", placeholder: "sklep-kawowy.pl 2026-10-05 10:00\nexample-brand.com\n# or a CSV with a header row: domain,expectedAt,mode,maxPrice" });
  const file = h("input", { type: "file", accept: ".csv,.txt,text/csv,text/plain", "aria-label": "Load a CSV or text file" });
  file.addEventListener("change", async () => {
    if (file.files?.[0]) text.value = await file.files[0].text();
  });
  const budget = h("div", { class: "form-grid" },
    field({ label: "Maximum price", name: "maxPrice", type: "number", attrs: { min: "0.01", step: "0.01", inputmode: "decimal" } }),
    field({ label: "Currency", name: "currency", value: regAccounts.some((a) => a.provider === "ovh") ? "PLN" : "USD", attrs: { maxlength: "3" } }),
    h("fieldset", { class: "wide" }, h("legend", { text: "Registrars" }),
      regAccounts.length ? h("div", { class: "stack-sm" }, regAccounts.map((a) => checkbox({ name: "registrars", value: a.id, label: a.id, help: a.provider, checked: true }))) : h("p", { class: "muted", text: "No registrar accounts yet." })));
  const preview = h("div", { class: "stack-sm", "aria-live": "polite" });
  const importBtn = button("Import", { kind: "primary", type: "submit", disabled: true });
  const form = h("form", { class: "panel-body", novalidate: true },
    h("h2", { text: "Import targets" }),
    h("p", { class: "muted", text: "One domain per line with an optional drop time, or a CSV with a domain column. Nothing is written until you confirm." }),
    field({ label: "Domains", name: "text", control: text }),
    h("div", { class: "row" }, file),
    h("div", { class: "form-grid" },
      h("div", { class: "field", dataset: { field: "timezone" } }, h("span", { class: "label-text", text: "Timezone of drop times" }), timezoneInput("timezone", cfg.raw.app?.timezone || S.tz), h("span", { class: "error-text", hidden: true })),
      h("div", { class: "wide" }, checkbox({ name: "update", label: "Overwrite targets that already exist" }))),
    h("fieldset", {}, h("legend", { text: "Default mode" }), modeChoices("mode", "notify-only")),
    budget,
    preview,
    h("div", { class: "form-foot" },
      button("Cancel", { onClick: () => dialog.close() }),
      button("Preview", { iconName: "eye", onClick: () => run(false) }),
      importBtn));
  const dialog = h("dialog", { style: "width:min(760px, calc(100% - 32px))" }, form);
  const syncMode = () => (budget.hidden = formData(form).mode === "notify-only");
  form.addEventListener("change", syncMode);
  syncMode();
  const payload = (apply) => {
    const d = formData(form);
    return { text: d.text, update: d.update, apply, defaults: { mode: d.mode, maxPrice: d.maxPrice, currency: d.currency, registrars: d.registrars || [], timezone: d.timezone } };
  };
  async function run(apply) {
    clearErrors(form);
    try {
      const r = await api("POST", "/api/import", payload(apply));
      const c = r.counts;
      preview.replaceChildren(
        h("div", { class: "row" }, badge(`${c.create} new`, c.create ? "success" : ""), badge(`${c.update} update`, c.update ? "accent" : ""), badge(`${c.skip} skip`), badge(`${c.error} error`, c.error ? "danger" : "")),
        r.rows.length ? h("div", { class: "table-wrap preview-table" }, h("table", {},
          h("thead", {}, h("tr", {}, ["Line", "Target", "Domain", "Drop", "Result"].map((x) => h("th", { text: x })))),
          h("tbody", {}, r.rows.map((row) => h("tr", {},
            h("td", { text: String(row.line) }), h("td", { text: row.id || "" }), h("td", { text: row.domain || row.raw }),
            h("td", { text: row.expectedAt ? fmtTime(Date.parse(row.expectedAt), { date: true, seconds: false }) : "none" }),
            h("td", { class: row.action === "error" ? "status-error" : "", text: row.action === "error" || row.action === "skip" ? `${row.action}: ${row.reason}` : row.action })))))) : null);
      importBtn.disabled = Boolean(c.error) || c.create + c.update === 0;
      if (r.applied) {
        dialog.close();
        toast(`Imported ${c.create} new and ${c.update} updated target${c.create + c.update === 1 ? "" : "s"}.`, "success");
        render({ quiet: true });
      }
    } catch (err) {
      showError(form, err);
    }
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(true);
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  text.focus();
}

// ---------------------------------------------------------------- calendar

function dayKey(ms) {
  const p = Object.fromEntries(tzFormatter({ year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

async function pageCalendar(_p, query) {
  const data = await api("GET", "/api/calendar");
  if (!S.meta) await loadMeta();
  S.tz = data.timezone || S.tz;
  const [ty, tm] = dayKey(data.now).split("-").map(Number);
  const [y, m] = (query.get("m") || `${ty}-${tm}`).split("-").map(Number);
  const monthStart = Date.UTC(y, m - 1, 1);
  const lead = (new Date(monthStart).getUTCDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const byDay = new Map();
  for (const e of data.entries) {
    const k = dayKey(e.expectedAt);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const todayKey = dayKey(data.now);
  const pad = (n) => String(n).padStart(2, "0");
  const shift = (delta) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `#/calendar?m=${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
  };
  const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(monthStart));
  const grid = h("div", { class: "cal-grid", role: "grid", "aria-label": monthLabel },
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => h("div", { class: "cal-head", role: "columnheader", text: d })),
    Array.from({ length: cells }, (_, i) => {
      const date = new Date(Date.UTC(y, m - 1, 1 + i - lead));
      const key = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
      const drops = byDay.get(key) || [];
      const other = date.getUTCMonth() !== m - 1;
      return h("div", { class: `cal-day${other ? " other" : ""}${key === todayKey ? " today" : ""}`, role: "gridcell" },
        h("span", { class: "n", text: String(date.getUTCDate()) }),
        drops.map((e) => h("a", {
          class: `cal-chip${e.state === "SUCCEEDED" ? " done" : e.mode !== "notify-only" ? " buy" : ""}`,
          href: `#/targets/${encodeURIComponent(e.id)}`,
          title: `${e.unicode}, ${fmtTime(e.expectedAt, { date: true, zone: true })}, ${e.mode}`,
        }, h("time", { datetime: new Date(e.expectedAt).toISOString(), text: fmtTime(e.expectedAt, { seconds: false }) }), h("span", { text: e.unicode }))));
    }));
  const upcoming = data.entries.filter((e) => e.windowEnd >= data.now).slice(0, 12);
  const agenda = upcoming.length
    ? h("ol", { class: "feed" }, upcoming.map((e) => h("li", {},
      h("time", { datetime: new Date(e.expectedAt).toISOString(), text: fmtTime(e.expectedAt, { date: true, seconds: false }).replace(/ \d{4},?/, "") }),
      h("div", { class: "what" },
        h("a", { href: `#/targets/${encodeURIComponent(e.id)}`, text: e.unicode }),
        h("div", { class: "row" },
          h("span", { class: "num muted", dataset: { countdown: String(e.expectedAt) } }),
          e.watching ? badge("Watching", "accent", h("span", { class: "live", "aria-hidden": "true" })) : null,
          modeBadge(e.mode, S.meta?.dryRun))))))
    : empty("Nothing scheduled", "Targets with a drop time appear here.", linkButton("Add target", "#/targets/new", { kind: "primary", iconName: "plus" }));
  return {
    title: "Calendar",
    section: "calendar",
    node: h("div", { class: "stack" },
      pageHead("Calendar", `Drop times in ${S.tz}. Chips in red are set to buy.`, [
        h("a", { class: "btn", href: "/api/calendar.ics", download: "dropcatch-drops.ics" }, icon("download-simple"), "Export .ics"),
      ]),
      h("div", { class: "split" },
        h("section", { class: "panel cal-panel" },
          h("div", { class: "panel-head" },
            h("h2", { text: monthLabel }),
            h("div", { class: "actions" },
              linkButton("", shift(-1), { kind: "ghost sm", iconName: "caret-left" }),
              linkButton("Today", "#/calendar", { kind: "sm" }),
              linkButton("", shift(1), { kind: "ghost sm", iconName: "caret-right" }))),
          h("div", { class: "cal-scroll" }, grid)),
        panel("Upcoming", agenda, { flush: true }))),
  };
}

// ---------------------------------------------------------------- router

const ROUTES = [
  [/^\/setup$/, pageSetup, { public: true }],
  [/^\/login$/, pageLogin, { public: true }],
  [/^\/welcome$/, pageWelcome, { bare: true }],
  [/^\/overview$/, pageOverview, { key: "overview" }],
  [/^\/targets\/new$/, pageTargetEdit, {}],
  [/^\/targets\/([^/]+)\/edit$/, pageTargetEdit, {}],
  [/^\/targets\/([^/]+)$/, pageTarget, { key: "target" }],
  [/^\/check$/, pageCheck, {}],
  [/^\/calendar$/, pageCalendar, { key: "calendar" }],
  [/^\/providers$/, pageProviders, {}],
  [/^\/notifications$/, pageNotifications, {}],
  [/^\/activity$/, pageActivity, { key: "activity" }],
  [/^\/settings$/, pageSettings, {}],
  [/^\/config$/, pageRawConfig, {}],
];

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/overview";
  const [path, qs] = raw.split("?");
  return { path, query: new URLSearchParams(qs || "") };
}

let renderSeq = 0;

async function render({ quiet = false } = {}) {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  try {
    if (!S.session) S.session = await api("GET", "/api/session");
  } catch {
    $app.replaceChildren(authLayout(panel(null, empty("Cannot reach the dropcatch server", "Is the dashboard process still running?", button("Retry", { onClick: () => render() })))));
    return;
  }
  const s = S.session;
  if (s.setupRequired && path !== "/setup") return void (location.hash = `#/setup${query.toString() ? `?${query}` : ""}`);
  if (!s.setupRequired && !s.authenticated && path !== "/login") return void (location.hash = "#/login");
  if (s.authenticated && (path === "/login" || path === "/setup")) return void (location.hash = "#/overview");

  const match = ROUTES.map(([re, fn, opts]) => ({ m: re.exec(path), fn, opts })).find((r) => r.m) || { m: [], fn: pageOverview, opts: { key: "overview" } };
  S.route = match.opts.key || "";
  if (s.authenticated) connectStream();

  const loadingTimer = !quiet && !match.opts.public
    ? setTimeout(() => {
      const main = document.getElementById("main");
      if (main) main.setAttribute("aria-busy", "true");
    }, 150)
    : 0;
  try {
    const page = await match.fn(match.m.slice(1), query);
    if (seq !== renderSeq) return;
    document.title = `${page.title} | dropcatch`;
    const scroll = window.scrollY;
    $app.replaceChildren(match.opts.public || match.opts.bare ? page.node : shell(page.section, page.node));
    if (quiet) window.scrollTo(0, scroll);
    else document.querySelector("h1")?.focus?.();
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err.status === 401) return;
    const node = h("div", { class: "stack" }, pageHead("Something went wrong"),
      panel(null, empty(err.message, err.data?.issues?.join(" ") || null, button("Try again", { onClick: () => render() }))));
    $app.replaceChildren(match.opts.public ? authLayout(node) : shell("", node));
  } finally {
    clearTimeout(loadingTimer);
  }
}

initTheme();
window.addEventListener("hashchange", () => render());
render();
