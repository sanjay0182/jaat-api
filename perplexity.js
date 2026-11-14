// perplexity.js - perplexity.ai provider (real Chrome, bina login). Sirf BASIC chat.
// Koi tools / streaming / session-reuse / image nahi. duck.js jaisa pattern:
// chrome kholo -> prompt textbox me daalo -> Enter -> jawab padho.
//
// Jawab 2 tareeke se pakadta hai:
//   1) network: /rest/sse/perplexity_ask ka SSE response (agar page ne wahi use kiya)
//   2) DOM: jawab wale markdown block ka text (fallback)
//
// NOTE: ye live test nahi hua. Perplexity ka page badalta rehta hai, isliye selectors
// ek jagah (SEL) rakhe hain. Fail hone par debug/ folder me screenshot + text milta hai.
//
// Sirf runner.js import karta hai. Akele test ke liye:
//   node perplexity.js "hello"        (DUCK_HEADED=1 ho to xvfb-run ke saath)

import { loadChromium } from "./pw.js";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { WarmPool } from "./warmpool.js";

const BASE = process.env.PPLX_BASE || "https://www.perplexity.ai";
export const DEFAULT_MODEL = "pplx-auto";
const MAX_PAGES = Number(process.env.PPLX_MAX_PAGES || 2); // ek saath kitne chat
const MAX_PROMPT = Number(process.env.PPLX_MAX_PROMPT || 12000);
const WARM_MAX_MS = Number(process.env.PPLX_WARM_MAX_MS || 120000); // garam page ki umar
const WARM_POOL = Number(process.env.PPLX_WARM_POOL || 3);          // kitne page pehle se khule rakhne hain
const WARM_ON = process.env.PPLX_WARM !== "0" && WARM_POOL > 0;     // PPLX_WARM=0 => band
const DEBUG_DIR = process.env.DUCK_DEBUG_DIR || "debug";

// page ke selectors - perplexity badle to sirf yahan theek karo
const SEL = {
  input: '#ask-input, [data-lexical-editor="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"], textarea',
  answer: '[id^="markdown-content-"], div.prose',
  stop: 'button[aria-label*="Stop" i]',
};

// =====================================================================================
// AUTOPILOT - page ko insaan ki tarah chalao: dekho (snapshot) -> socho -> asli tap -> check karo.
// Koi popup ka naam/selector pehle se pata hona zaroori nahi:
//   * "composer (input box) ke beech me elementFromPoint kya hai?" - agar input khud nahi, to jo upar baitha hai wahi overlay hai.
//   * us overlay ke buttons me se: pehle Got it/Accept, phir Decline/OK, phir Close/Skip, phir bina-text wala X (upar-daayen).
//     (sign up / log in / continue with... wale buttons kabhi nahi dabte)
//   * har button ek hi baar dabta hai; kuch na bache to Escape, phir CSS se chhupana (DOM se remove() kabhi nahi - React crash hota hai).
//   * Cloudflare challenge / "Internal Error" page ho to khud sambhalta hai.
// Har step log me aata hai ("pplx auto: ...") taaki dikhe bot ne kya socha aur kya dabaya.
// =====================================================================================
const POS_RANK = [
  /^(got it|accept( all)?( cookies)?|i agree|agree|allow all)$/i,
  /^(ok|okay|decline( optional)?|reject( all)?( optional)?|necessary only)$/i,
  /^(close|dismiss|skip|not now|maybe later|no,? thanks|later|continue as guest|stay logged out|cancel|x|\u00d7|\u2715)$/i,
];
const NEG_BTN = /sign ?up|sign ?in|log ?in|continue with|google|apple|e-?mail|download|install|open in app|get the app|upgrade|subscribe|share|buy/i;
const BLOCK_TXT = /better in the app|search like never before|cookie|pixels|sign in to continue|sign up|log ?in\b|create (an )?account|continue with (google|apple|email)|this session is private|single sign-on|sign in if you are/i;

// page ke andar chalta hai (page.evaluate) - sirf padhta hai, kuch badalta nahi
function SNAP(blockSrc) {
  const BLOCK = new RegExp(blockSrc, "i");
  const inputSel = '#ask-input, [data-lexical-editor="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"], [role="textbox"], textarea';
  const vw = innerWidth, vh = innerHeight;
  const cs = (e) => getComputedStyle(e);
  const vis = (e) => { const r = e.getBoundingClientRect(), c = cs(e); return r.width > 2 && r.height > 2 && c.visibility !== "hidden" && c.display !== "none" && c.opacity !== "0" && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
  const lab = (e) => ((e.getAttribute("aria-label") || "") + " " + (e.innerText || "") + " " + (e.getAttribute("title") || "")).replace(/\s+/g, " ").trim();
  const body = (document.body && document.body.innerText) || "";
  const ed = Array.from(document.querySelectorAll(inputSel)).filter(vis)[0] || null;
  const binfo = (b) => { const r = b.getBoundingClientRect(); const t = (b.innerText || "").replace(/\s+/g, " ").trim(); return { label: t || (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim(), icon: !t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), top: Math.round(r.top), dis: !!b.disabled || b.getAttribute("aria-disabled") === "true" }; };
  const btnsIn = (el) => Array.from(el.querySelectorAll('button, [role="button"]')).filter(vis).map(binfo);
  const out = { url: location.href, title: document.title, body: body.replace(/\s+/g, " ").slice(0, 140), err: !ed && /internal error|something went wrong/i.test(body.slice(0, 300)), composer: null, overlays: [], cbtns: [],
    txt: body.replace(/\s+/g, " ").trim().slice(0, 700).toLowerCase(), len: body.trim().length,
    cfFrame: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'), onetap: !!document.querySelector('iframe[src*="accounts.google.com"], #credential_picker_container') };
  let culprit = null;
  if (ed) {
    const r = ed.getBoundingClientRect();
    const cx = Math.round(Math.min(vw - 3, Math.max(3, r.left + r.width / 2)));
    const cy = Math.round(Math.min(vh - 3, Math.max(3, r.top + Math.min(r.height / 2, 30))));
    const hit = document.elementFromPoint(cx, cy);
    const covered = !!hit && !(hit === ed || ed.contains(hit) || hit.contains(ed));
    out.composer = { x: cx, y: cy, covered, by: covered ? hit.tagName.toLowerCase() + ":" + lab(hit).slice(0, 40) : "", text: (((ed.innerText || ed.value || "") + "")).trim().length };
    if (covered) {
      for (let n = hit; n && n !== document.body && n !== document.documentElement; n = n.parentElement) { const p = cs(n).position; if ((p === "fixed" || p === "absolute") && !n.contains(ed)) culprit = n; }
      if (!culprit) culprit = hit;
    }
    let el = ed, list = [];
    for (let i = 0; i < 7 && el; i++, el = el.parentElement) { list = Array.from(el.querySelectorAll('button, [role="button"]')).filter(vis); if (list.length >= 2) break; }
    out.cbtns = list.map(binfo);
  }
  const seen = new Set();
  const consider = (el) => {
    if (seen.has(el) || !vis(el) || (ed && el.contains(ed))) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.4 || r.height < 24) return;
    const t = lab(el);
    const full = r.width >= vw * 0.9 && r.height >= vh * 0.9;
    const mine = el === culprit || (culprit && (culprit.contains(el) || el.contains(culprit)));
    const blocking = !!mine || (BLOCK.test(t) && r.height >= 120) || (full && cs(el).zIndex !== "auto");
    out.overlays.push({ text: t.slice(0, 90), blocking, buttons: btnsIn(el).slice(0, 14), w: Math.round(r.width), h: Math.round(r.height) });
  };
  if (culprit) consider(culprit);
  document.querySelectorAll('[role="dialog"], [aria-modal="true"]').forEach(consider);
  document.querySelectorAll("body *").forEach((el) => { if (cs(el).position === "fixed") consider(el); });
  return out;
}

const alog = (...a) => console.log("pplx auto:", ...a);

// screenshot (debug/ folder -> GitHub run ke "debug" artifact me). Sirf pehle PPLX_SHOTS (default 12) - disk/time na bhare.
let shotsTaken = 0;
async function shot(page, tag) {
  if (shotsTaken >= Number(process.env.PPLX_SHOTS ?? 12)) return;
  shotsTaken++;
  try { fs.mkdirSync(DEBUG_DIR, { recursive: true }); await page.screenshot({ path: `${DEBUG_DIR}/${Date.now()}-pplx-${tag}.png` }); } catch {}
}
// ---- page ko pehchano: ye kaun si haalat hai? (har haalat ka apna ilaaj autoStep me) ----------------------------
const RX = {
  block: /sorry, you have been blocked|access denied|error 1020|error 1015|error 1010|error 1006|error 1007|error 1008|you are being rate limited|has banned your|banned your access|attention required! \| cloudflare/,
  cf: /performing security verification|verify you are human|checking your browser|just a moment|needs to review the security of your connection|enable javascript and cookies to continue/,
  http: /\b(429 too many requests|403 forbidden|502 bad gateway|503 service (temporarily )?unavailable|504 gateway time-?out|500 internal server error|bad gateway|service unavailable|too many requests)\b|this site can.t be reached|\berr_[a-z_]+|dns_probe|no internet/,
  down: /(perplexity|we) (is|are)( currently)? (down|unavailable|undergoing)|scheduled maintenance|we.ll be back|temporarily unavailable/,
  region: /not available in your (country|region)|unsupported (country|region)|isn.t available in your/,
  intErr: /internal error|something went wrong|return home|unexpected error|an error occurred/,
};
// jawab ke intezaar me body me ye aaye (aur jawab abhi na ho) to guest limit maano
const RX_LIMIT = /you.?ve (reached|hit) (your|the)|daily limit|free (queries|searches|limit)|too many requests|unusual activity|rate limit exceeded/;
function classify(s) {
  const t = ((s.title || "") + " " + (s.txt || "")).toLowerCase();
  if (RX.block.test(t)) return "block";
  if (s.cfFrame || RX.cf.test(t)) return "cf";
  if (!s.composer && RX.http.test(t)) return "http";
  if (!s.composer && RX.down.test(t)) return "down";
  if (!s.composer && RX.region.test(t)) return "region";
  if (!s.composer && RX.intErr.test((s.txt || "").slice(0, 300))) return "interr";
  if (!s.composer && s.len < 15) return "blank";
  return s.composer ? "page" : "loading";
}
// Google One Tap (accounts.google.com iframe) - uska X iframe ke andar hota hai, DOM se dabta nahi: container ko CSS se chhupao (remove nahi)
async function hideOneTap(page) {
  try { return await page.evaluate(() => { let n = 0; document.querySelectorAll('iframe[src*="accounts.google.com"], #credential_picker_container').forEach((e) => { const t = e.id === "credential_picker_container" ? e : (e.closest("#credential_picker_container") || e); if (t.style.display !== "none") { t.style.setProperty("display", "none", "important"); n++; } }); return n; }); } catch { return 0; }
}

// bot ko page me kya dikha: input kahan/dhaka hai ya saaf, kaun se overlay (* = rok raha), unke buttons kahan (x,y)
function viewStr(s) {
  const c = s.composer ? "input@" + s.composer.x + "," + s.composer.y + (s.composer.covered ? " DHAKA(" + s.composer.by + ")" : " saaf") : "input nahi dikha";
  const ov = s.overlays.map((o) => (o.blocking ? "*" : "") + '"' + o.text.slice(0, 40) + '" [' + o.buttons.slice(0, 8).map((b) => (b.label || "icon").slice(0, 18) + "@" + b.x + "," + b.y).join(", ") + "]").join(" ; ") || "koi overlay nahi";
  return "[" + classify(s) + "] " + c + " | " + ov;
}
const snap = (page) => page.evaluate(SNAP, BLOCK_TXT.source).catch(() => null);
async function tap(page, x, y) { // asli touch tap (phone jaisa); na chale to mouse click
  try { await page.touchscreen.tap(x, y); } catch { try { await page.mouse.click(x, y); } catch {} }
}
function rankBtn(b) {
  if (b.dis || b.w < 8 || b.h < 8) return null;
  if (NEG_BTN.test(b.label) && !/^(got it|accept)/i.test(b.label)) return null;
  if (!b.icon) { for (let i = 0; i < POS_RANK.length; i++) if (POS_RANK[i].test(b.label)) return i; return null; }
  if (/close|dismiss|cancel/i.test(b.label)) return 3;
  if (b.label && !/back|x\b/i.test(b.label)) return null; // naam wala icon-button jo close nahi hai (menu, mic...) mat chhuo
  return 4 + b.top / 10000 + (2000 - b.right) / 1e7; // bina naam ka icon: sabse upar-daayen = X
}
// CSS se chhupana (aakhri raasta). DOM se remove() nahi.
async function hideBlockers(page, x, y) {
  try {
    return await page.evaluate(([bs, px, py]) => {
      const BLOCK = new RegExp(bs, "i");
      const inputSel = '#ask-input, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"], textarea';
      const hide = (el) => { el.style.setProperty("display", "none", "important"); };
      let n = 0;
      const top = document.elementFromPoint(px, py);
      for (let el = top; el && el !== document.body; el = el.parentElement) {
        const p = getComputedStyle(el).position;
        if ((p === "fixed" || p === "absolute") && !el.querySelector(inputSel) && !el.matches(inputSel)) { hide(el); n++; break; }
      }
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (getComputedStyle(el).position !== "fixed" || el.querySelector(inputSel) || el.matches(inputSel)) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= innerWidth * 0.4 && r.height >= 120 && BLOCK.test(el.innerText || "")) { hide(el); n++; }
      }
      document.body.style.pointerEvents = ""; document.body.style.overflow = ""; document.documentElement.style.overflow = "";
      document.querySelectorAll("[inert]").forEach((e) => e.removeAttribute("inert"));
      return n;
    }, [BLOCK_TXT.source, x || 200, y || 400]);
  } catch { return 0; }
}

// ek kadam: dekho, aur zaroorat ho to ek kaam karo. opts.sweep = jawab ke intezaar me: reload/challenge mat chhedo.
async function autoStep(page, st, opts = {}) {
  const s = await snap(page);
  if (!s) return { s: null };
  { const v = viewStr(s); if (st.view !== v) { st.view = v; alog("dekha:", v); } }
  if (s.onetap && (await hideOneTap(page))) alog("google one-tap popup chhupaya");
  const kind = classify(s);
  if (!opts.sweep) {
    st.n = (st.n || 0) + 1; st.log = st.log || {};
    switch (kind) {
      case "block": // IP/fingerprint block: loop karne ka fayda nahi, jaldi fail -> chat() naya session ke saath dobara koshish karega
        page.__why = "block"; return { s, fail: "cloudflare/site ne block kiya: " + s.txt.slice(0, 90) };
      case "region":
        page.__why = "block"; return { s, fail: "region unsupported: " + s.txt.slice(0, 90) };
      case "cf": // challenge: shaanti se ruko (10-50s), checkbox dikhe to click
        alog("cloudflare challenge, intezaar"); { const ok = await passChallenge(page); if (!ok) { page.__why = "cf"; return { s, fail: "cloudflare challenge paas nahi hua" }; } } return { s, acted: true };
      case "http": case "down": { // server error / site down: ruk ke reload (2s, 4s, 6s), 3 baar se zyada nahi
        st.http = (st.http || 0) + 1;
        if (st.http > 3) { page.__why = "http"; return { s, fail: kind + " page: " + s.txt.slice(0, 90) }; }
        alog(kind + " page (" + s.txt.slice(0, 50) + ") -> " + st.http * 2 + "s ruk ke reload (" + st.http + "/3)");
        await page.waitForTimeout(st.http * 2000); await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1200); return { s, acted: true };
      }
      case "interr": // React crash page
        if ((st.reloads = (st.reloads || 0) + 1) <= 2) { alog("Internal Error page -> reload (" + st.reloads + ")"); await page.waitForTimeout(1500); await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); await page.waitForTimeout(1200); return { s, acted: true }; }
        page.__why = "interr"; return { s, fail: "internal-error page" };
      case "blank": // khali page: pehle intezaar (JS load ho raha ho), 8s baad reload, 20s baad dobara, phir fail
        st.blank0 = st.blank0 || Date.now();
        { const w = Date.now() - st.blank0;
          if (w > 20000 && st.blankR === 1) { st.blankR = 2; alog("page 20s se khali -> dobara reload"); await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); return { s, acted: true }; }
          if (w > 8000 && !st.blankR) { st.blankR = 1; alog("page 8s se khali -> reload"); await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); return { s, acted: true }; }
          if (w > 32000) { page.__why = "blank"; return { s, fail: "page khali hi raha" }; } }
        return { s, acted: false };
      default: st.blank0 = 0; // "page" / "loading": aage overlay/input logic
    }
  }
  const blocking = s.overlays.filter((o) => o.blocking);
  if (s.composer && !s.composer.covered && !blocking.length) return { s, ready: true };
  if (!blocking.length) {
    if (s.composer && s.composer.covered) { // koi bada overlay nahi mila par input dhaka hai: us point ko seedha chhupao
      alog("input dhaka hai (" + s.composer.by + ") -> chhupa raha hu"); await hideBlockers(page, s.composer.x, s.composer.y); return { s, acted: true };
    }
    return { s, acted: false }; // input abhi aaya nahi (page load ho raha hai)
  }
  const ov = blocking[0];
  const cands = ov.buttons.map((b) => ({ b, r: rankBtn(b) })).filter((c) => c.r !== null).sort((a, b) => a.r - b.r);
  const key = (b) => b.label + "@" + b.x + "," + b.y;
  const next = cands.find((c) => !st.tried.has(key(c.b)));
  if (next) {
    st.tried.add(key(next.b));
    await shot(page, "overlay");
    alog('overlay "' + ov.text.slice(0, 40) + '" -> tap "' + (next.b.label || "icon X") + '" @' + next.b.x + "," + next.b.y);
    await tap(page, next.b.x, next.b.y); await page.waitForTimeout(700);
    return { s, acted: true };
  }
  if (!st.esc) { st.esc = 1; alog("koi button nahi bacha -> Escape"); await page.keyboard.press("Escape").catch(() => {}); await page.waitForTimeout(400); return { s, acted: true }; }
  if ((st.hid = (st.hid || 0) + 1) <= 4) {
    alog('overlay "' + ov.text.slice(0, 40) + '" -> CSS se chhupa raha hu');
    const n = await hideBlockers(page, s.composer ? s.composer.x : 200, s.composer ? s.composer.y : 400);
    await page.waitForTimeout(300); return { s, acted: n > 0 };
  }
  return { s, fail: "overlay hat nahi raha: " + ov.text.slice(0, 50) };
}

// page ko tab tak sambhalo jab tak input box saaf-saaf (bina dhake) tap karne layak na ho
async function autoPrepare(page, maxMs = 20000) {
  const st = { tried: new Set() }, end = Date.now() + maxMs;
  let n = 0, last = null; page.__why = "";
  while (Date.now() < end) {
    const r = await autoStep(page, st); n++;
    if (r.s) last = r.s;
    if (r.ready) { if (n > 1) alog("page tayyar (" + n + " kadam)"); return true; }
    if (r.fail) { alog("fail:", r.fail); break; }
    if (!r.acted) await page.waitForTimeout(600);
  }
  if (last) alog("prepare adhura | composer=" + JSON.stringify(last.composer) + " | overlays=" + (last.overlays.map((o) => (o.blocking ? "*" : "") + o.text.slice(0, 30)).join(" | ") || "koi nahi"));
  return false;
}

// kya search/jawab shuru ho gaya (url /search|/session, SSE, stop button ya answer block)
async function startedNow(page, getSse) {
  if (getSse && getSse()) return true;
  if (/\/(search|session)\//.test(page.url())) return true;
  if (await page.locator(SEL.stop).count().catch(() => 0)) return true;
  return (await page.locator(SEL.answer).count().catch(() => 0)) > 0;
}
async function waitStarted(page, getSse, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await startedNow(page, getSse)) return true; await page.waitForTimeout(250); }
  return false;
}

// prompt daalo: tap -> focus pakka karo -> insertText -> (box khali ho to) execCommand -> (phir bhi to) keyboard.type. Kitna text gaya wo lautata hai.
async function typePrompt(page, prompt) {
  let s = await snap(page);
  if (!s || !s.composer) return 0;
  await tap(page, s.composer.x, s.composer.y); await page.waitForTimeout(300);
  const focused = () => page.evaluate(() => { const a = document.activeElement; return !!a && a !== document.body && (a.isContentEditable || /^(textarea|input)$/i.test(a.tagName) || !!a.closest('[contenteditable="true"]')); }).catch(() => false);
  if (!(await focused())) {
    try { await page.mouse.click(s.composer.x, s.composer.y); } catch {}
    await page.waitForTimeout(250);
    if (!(await focused())) await page.evaluate(() => { const e = document.querySelector('#ask-input, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"], textarea'); if (e) e.focus(); }).catch(() => {});
  }
  const want = Math.min(prompt.length, 40);
  const len = async () => { const t = await snap(page); return t && t.composer ? t.composer.text : 0; };
  await page.keyboard.insertText(prompt); await page.waitForTimeout(250);
  let n = await len(); if (n >= want) return n;
  alog("insertText se box khali (" + n + ") -> execCommand try");
  await page.evaluate((t) => { const e = document.querySelector('#ask-input, [data-lexical-editor="true"], [contenteditable="true"], [role="textbox"], textarea'); if (!e) return; e.focus(); if (e.isContentEditable) document.execCommand("insertText", false, t); else { e.value = t; e.dispatchEvent(new Event("input", { bubbles: true })); } }, prompt).catch(() => {});
  await page.waitForTimeout(250); n = await len(); if (n >= want) return n;
  alog("execCommand se bhi khali (" + n + ") -> keyboard.type");
  await page.keyboard.type(prompt.slice(0, 3000), { delay: 0 }); await page.waitForTimeout(250);
  return await len();
}

// bhejo: Enter -> (na gaya to) composer ke buttons ek-ek asli tap -> har baar check; beech me overlay aaye to hatao. Kaise gaya wo lautata hai ("" = nahi gaya).
async function sendPrompt(page, getSse) {
  await page.keyboard.press("Enter");
  if (await waitStarted(page, getSse, 1600)) return "Enter";
  const st = { tried: new Set() };
  for (let round = 0; round < 3; round++) {
    const s = await snap(page);
    if (!s) break;
    if (s.overlays.some((o) => o.blocking)) { alog("bhejte waqt overlay aaya -> hata raha hu"); await autoStep(page, st, { sweep: true }); continue; }
    if (s.composer && s.composer.text === 0) { alog("bhejne se pehle box khali ho gaya"); return ""; }
    const skip = /attach|add|upload|mic|voice|dictat|model|mode|focus|source|plus|more|menu|\+/i;
    const lab = (b) => b.label || "";
    const c = (s.cbtns || []).filter((b) => !b.dis && b.w >= 16).filter((b) => /send|submit|ask/i.test(lab(b)) || !skip.test(lab(b)));
    c.sort((a, b) => (/send|submit|ask/i.test(lab(b)) ? 1 : 0) - (/send|submit|ask/i.test(lab(a)) ? 1 : 0) || (b.right - a.right) || (b.y - a.y)); // send-label pehle, phir sabse daayen
    alog("composer buttons: " + ((s.cbtns || []).map((b) => (b.label || "icon") + (b.dis ? "(off)" : "") + "@" + b.x + "," + b.y).join(" | ") || "koi nahi"));
    for (const b of c.slice(0, 3)) {
      await tap(page, b.x, b.y);
      if (await waitStarted(page, getSse, 1800)) return "tap " + (b.label || "icon") + "@" + b.x + "," + b.y;
    }
    await page.keyboard.press("Enter").catch(() => {});
    if (await waitStarted(page, getSse, 1200)) return "Enter-dobara";
  }
  return "";
}

// Turnstile checkbox: challenge iframe ki asli jagah (boundingBox) dekh kar, bayen taraf (jahan checkbox hota hai) insaan jaisa click
async function clickTurnstile(page) {
  for (const f of page.frames()) {
    if (!/challenges\.cloudflare\.com|turnstile/.test(f.url())) continue;
    try {
      const el = await f.frameElement(); const b = await el.boundingBox();
      if (!b || b.width < 30 || b.height < 20) continue;
      const x = b.x + Math.min(32, b.width * 0.15), y = b.y + b.height / 2;
      alog("turnstile checkbox click @" + Math.round(x) + "," + Math.round(y) + " (iframe " + Math.round(b.width) + "x" + Math.round(b.height) + ")");
      await page.mouse.move(x - 40, y - 12, { steps: 6 });
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(150);
      await page.mouse.click(x, y, { delay: 90 });
      return true;
    } catch {}
  }
  return false;
}

// Cloudflare "Just a moment..." challenge. Pehle jaisa har 2.5s reload NAHI (wo chalte challenge ko dobara shuru kar deta tha):
//   1) Cloudflare ko ~10s lagte hain: 8s tak sirf dekho (challenge khud paas hota hai), phir checkbox dikhe to asli click
//   2) cf_clearance cookie aa gayi par page 10s se atka -> reload (max 2, 12s ke gap se)
//   3) cookie ke baad bhi atka -> kharab cookie hatao, ek baar naya challenge
//   4) 40s tak cookie hi nahi aayi -> ek baar naya challenge
// True = page aage badh gaya.
async function passChallenge(page, ms = 55000) {
  const isChallenge = async () => {
    const title = (await page.title().catch(() => "")).toLowerCase();
    if (/just a moment|attention required|security verification/.test(title)) return true;
    const body = (await page.innerText("body").catch(() => "")).toLowerCase();
    return /performing security verification|verify you are human|checking your browser|needs to review the security/.test(body);
  };
  if (!(await isChallenge())) return true;
  console.log("pplx: cloudflare challenge mila, intezaar...");
  const ctx = page.context(), t0 = Date.now(), end = t0 + ms;
  const hasClr = async () => { try { return (await ctx.cookies()).some((c) => c.name === "cf_clearance"); } catch { return false; } };
  const reload = async (why) => { alog("challenge reload: " + why); await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {}); lastReload = Date.now(); };
  let clicks = 0, reloads = 0, lastClick = 0, lastReload = t0, clearedSince = 0, cleaned = false;
  while (Date.now() < end) {
    await page.waitForTimeout(1500);
    if (!(await isChallenge())) { console.log("pplx: challenge paas (" + Math.round((Date.now() - t0) / 1000) + "s)"); await page.waitForTimeout(1200); return true; }
    const cleared = await hasClr();
    if (cleared && !clearedSince) clearedSince = Date.now();
    if (clicks < 4 && Date.now() - t0 > 8000 && Date.now() - lastClick > 8000) { lastClick = Date.now(); if (await clickTurnstile(page)) clicks++; }
    const sinceReload = Date.now() - lastReload;
    if (cleared && reloads < 2 && Date.now() - clearedSince > 10000 && sinceReload > 12000) { reloads++; await reload("cf_clearance mili, page atka (" + reloads + ")"); continue; }
    if (cleared && reloads >= 2 && !cleaned && sinceReload > 12000) { cleaned = true; try { await ctx.clearCookies(); } catch {} await reload("cookie ke baad bhi atka -> cookies saaf, naya challenge"); continue; }
    if (!cleared && reloads < 1 && sinceReload > 40000) { reloads++; await reload("25s tak cf_clearance nahi aayi"); continue; }
  }
  return false;
}
// citation chips (source naam, +N) ko page me hi chhupa do, taaki innerText me aayein hi nahi
async function hideChips(page) {
  try {
    await page.evaluate((sel) => {
      const clean = (e) => (e.textContent || "").replace(/[\u200b-\u200d\u00a0\ufeff]/g, " ").trim();
      for (const r of document.querySelectorAll(sel)) {
        r.querySelectorAll("a, span, div, button").forEach((e) => {
          if (e.children.length > 2) return;
          const t = clean(e);
          if (!t || t.length > 40) return;
          if (/^\+\d+$/.test(t)) { e.style.display = "none"; return; }
          const inLink = e.tagName === "A" || !!e.closest("a");
          if (inLink && /^[a-z0-9][a-z0-9.\-]*(\s*\+\d+)?$/i.test(t)) e.style.display = "none";
        });
      }
    }, SEL.answer);
  } catch {}
}
// page kya dikha raha hai - error message me jata hai (API ke 502 me bhi dikhega)
async function pageInfo(page) {
  const title = await page.title().catch(() => "");
  const body = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
  const n = await page.evaluate(() => ({ ce: document.querySelectorAll('[contenteditable]').length, ta: document.querySelectorAll('textarea').length, inp: document.querySelectorAll('input').length })).catch(() => ({}));
  return `url=${page.url()} | title=${title} | ce=${n.ce} ta=${n.ta} input=${n.inp} | body: ${body}`;
}

// page abhi kya dikha raha hai: title, sabse upar ka text, aur screen ke upar/beech/neeche (x-center) pe sabse upar kaun sa element hai + fixed overlays
async function topLog(page, tag) {
  try {
    const i = await page.evaluate(() => {
      const d = (el) => el ? el.tagName.toLowerCase() + (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label") + "]" : "") + ":" + (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50) : "-";
      const vw = innerWidth, vh = innerHeight;
      const pts = [[vw / 2, 8], [vw / 2, vh * 0.3], [vw / 2, vh * 0.6], [vw / 2, vh - 8]];
      const fixed = Array.from(document.querySelectorAll("body *")).filter((e) => getComputedStyle(e).position === "fixed" && e.getBoundingClientRect().width > vw * 0.4).slice(0, 4).map(d);
      return { top: pts.map(([x, y]) => d(document.elementFromPoint(x, y))), fixed, text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 160) };
    });
    const title = await page.title().catch(() => "");
    console.log("pplx top [" + tag + "]: title=" + title + " | text: " + i.text + " | upar/30%/60%/neeche: " + i.top.join(" || ") + " | fixed: " + (i.fixed.join(" || ") || "-"));
  } catch {}
}
class PplxError extends Error {
  constructor(msg, kind = "error") { super(msg); this.kind = kind; }
}

// ---- playwright load (lazy) ---------------------------------------------------

function chromePath() {
  for (const p of [process.env.DUCK_CHROME_PATH, "/usr/bin/google-chrome", "/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"])
    if (p && fs.existsSync(p)) return p;
  return undefined;
}

// ---- messages -> ek prompt string ---------------------------------------------
function textOf(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p && p.text ? p.text : "")).filter(Boolean).join("\n");
  return String(c);
}
export function flatten(messages) {
  const parts = [];
  for (const m of (messages || []).filter(Boolean)) {
    const t = textOf(m.content).trim();
    if (!t) continue;
    const role = m.role === "assistant" ? "Assistant" : m.role === "system" || m.role === "developer" ? "System" : "Human";
    parts.push({ role, t });
  }
  if (parts.length === 1 && parts[0].role === "Human") return parts[0].t;
  return (
    "Below is a conversation transcript. Reply ONLY as the Assistant to the last Human message. " +
    "Do not repeat the transcript or write role labels.\n\n" +
    parts.map((p) => `${p.role}: ${p.t}`).join("\n\n")
  );
}

// ---- SSE parse: perplexity ke events se final answer nikalo (tolerant) ---------
function answerFromEvent(o) {
  let best = "";
  const take = (s) => { if (typeof s === "string" && s.trim().length >= best.length) best = s; };
  try {
    for (const b of Array.isArray(o.blocks) ? o.blocks : []) {
      take(b?.markdown_block?.answer);
      if (Array.isArray(b?.markdown_block?.chunks)) take(b.markdown_block.chunks.join(""));
    }
    if (typeof o.answer === "string") take(o.answer);
    // purana format: text = JSON string of steps, FINAL step me answer
    if (typeof o.text === "string" && o.text.startsWith("[")) {
      const steps = JSON.parse(o.text);
      const fin = steps.find((s) => s && s.step_type === "FINAL");
      if (fin?.content?.answer) {
        const a = typeof fin.content.answer === "string" ? fin.content.answer : "";
        try { take(JSON.parse(a).answer); } catch { take(a); }
      }
    }
  } catch {}
  return best;
}
function answerFromSSE(raw) {
  let best = "";
  for (let line of String(raw || "").split(/\r?\n/)) {
    line = line.trim();
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line.startsWith("{")) continue;
    try { const a = answerFromEvent(JSON.parse(line)); if (a.length >= best.length) best = a; } catch {}
  }
  return best;
}

// DOM se text lene par citation chips (britannica, +1, worldometers...) saath aa jate hain - unhe hatao.
// Sirf akele source-jaise lines hatate hain; kuch bacha hi na to original wapas.
function cleanDom(t) {
  const lines = String(t || "").split(/\r?\n/);
  const isChip = (l) => {
    const x = l.replace(/[\u200b-\u200d\u00a0\ufeff]/g, " ").trim();
    if (/^\+\d+$/.test(x)) return true;
    const y = x.replace(/\s*\+\d+$/, ""); // "cardekho +1" ek hi line me
    return y.length > 0 && y.length <= 40 && /^[a-z0-9][a-z0-9.\-]*$/.test(y) && !/^\d+$/.test(y);
  };
  const kept = lines.filter((l) => !isChip(l));
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out && kept.length < lines.length && kept.some((l) => /\s/.test(l.trim())) ? out : String(t || "").trim();
}

// Perplexity guest limit / login wall ("Sign up and repeat your request.") jawab nahi, error hai
function isWall(t) {
  const x = String(t || "").trim();
  return x.length > 0 && x.length < 300 && /sign up|log ?in\b|create (an )?account|continue with (google|apple|email)|repeat your request|upgrade to|you.?ve (reached|hit)|daily limit|too many requests|rate limit|unusual activity/i.test(x);
}

function completion(model, text) {
  return JSON.stringify({
    id: "chatcmpl-pplx-" + Date.now().toString(36),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

export class PplxClient {
  constructor() {
    this.browser = null; this.ctx = null; this.starting = null;
    this.active = 0; this.waiters = [];
    this.cfChain = Promise.resolve(); this.cfBadAt = 0; // Cloudflare challenge ek baar me ek hi page paar kare
    this.pool = this.makePool();
  }

  async hasClearance() { try { return !!this.ctx && (await this.ctx.cookies()).some((c) => c.name === "cf_clearance"); } catch { return false; } }

  // cf_clearance abhi nahi hai to challenge sirf EK page me chale, baaki pages uske peeche ruke.
  // Pehle teeno pages ek saath challenge karte the aur ek doosre ko bigaadte the. Clearance milte hi baaki turant paas.
  async withCf(waitMs, fn) {
    if (await this.hasClearance()) return fn();
    const prev = this.cfChain; let rel; this.cfChain = new Promise((r) => { rel = r; });
    await Promise.race([prev, new Promise((r) => setTimeout(r, waitMs))]);
    try {
      if (!(await this.hasClearance()) && Date.now() - this.cfBadAt < 40000) throw new PplxError("perplexity.ai bot check abhi pass nahi hua (pichla page fail hua), jaldi fail", "challenge");
      return await fn();
    } finally { rel(); }
  }

  // WarmPool band hone (closeAll) ke baad dobara nahi khulta, isliye session reset par naya pool banta hai
  makePool() {
    return new WarmPool({ size: WARM_POOL, ttlMs: WARM_MAX_MS, label: "pplx", open: async () => { await this.ensure(); return this.open(45000); } });
  }

  async ensure() {
    if (this.ctx) return;
    if (!this.starting) this.starting = (async () => {
      const chromium = await loadChromium();
      const headless = process.env.DUCK_HEADED !== "1";
      if (!this.browser) {
        const launch = { headless, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] };
        const exe = chromePath();
        if (exe) launch.executablePath = exe; else launch.channel = "chrome";
        this.browser = await chromium.launch(launch);
        console.log("pplx: chrome ready", this.browser.version(), headless ? "(headless)" : "(headed)");
      }
      await this.makeCtx();
    })().catch((e) => { this.starting = null; throw e; });
    await this.starting;
  }

  // naya browser context (naye cookies / naya anonymous session). Browser wahi rehta hai.
  async makeCtx() {
    const ver = this.browser.version().split(".")[0] + ".0.0.0"; // asli Android Chrome UA me version reduced (141.0.0.0) hota hai; poora 141.0.7390.x mismatch dikhta hai
    // Perplexity sirf phone (Android Chrome) jaisa chalta hai, desktop nahi.
    const mobileUA = process.env.PPLX_UA ||
      `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Mobile Safari/537.36`;
    this.ctx = await this.browser.newContext({ userAgent: mobileUA, locale: "en-US", viewport: { width: 412, height: 915 }, screen: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true });
    // "Continue with Google" jaisa koi naya window/tab khule to turant band (hum kabhi login nahi karte)
    this.ctx.on("page", (p) => { p.on("framenavigated", (f) => { if (f === p.mainFrame() && /accounts\.google\.com|appleid\.apple\.com|login\.microsoftonline\.com|accounts\.youtube/.test(f.url())) { alog("login popup window band: " + f.url().slice(0, 60)); p.close().catch(() => {}); } }); });
    await this.ctx.addInitScript(() => { try { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); } catch {} try { Object.defineProperty(navigator, "platform", { get: () => "Linux armv8l" }); } catch {} }); // UA Android hai to platform bhi Linux x86_64 na dikhe (Cloudflare mismatch pakadta hai)
  }

  // guest wall / bigde session ke baad: poora naya context, warm pool dobara
  async freshSession() {
    try { await this.pool.closeAll(); } catch {}
    this.pool = this.makePool();
    try { await this.ctx?.close(); } catch {}
    this.ctx = null; this.starting = null; this.cfBadAt = 0;
    await this.ensure();
    if (WARM_ON) this.pool.start();
  }

  async slot() { if (this.active >= MAX_PAGES) await new Promise((r) => this.waiters.push(r)); this.active++; }
  free() { this.active--; const w = this.waiters.shift(); if (w) w(); }

  async debug(page, tag) {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      const f = `${DEBUG_DIR}/${Date.now()}-pplx-${tag}`;
      await page.screenshot({ path: f + ".png" }).catch(() => {});
      const info = { url: page.url(), title: await page.title().catch(() => ""), text: (await page.innerText("body").catch(() => "")).slice(0, 1500) };
      fs.writeFileSync(f + ".json", JSON.stringify(info, null, 1));
      console.log("pplx debug:", f, info.url, info.title);
    } catch {}
  }

  // naya page kholo, challenge paar karo, autopilot se input box tak pahuncho (popup/promo/cookie khud). Fail hone par saaf error.
  async open(budgetMs = 60000) {
    const page = await this.ctx.newPage();
    page.on("dialog", (d) => { alog("js dialog (" + d.type() + ") -> band"); d.dismiss().catch(() => {}); }); // "Leave site?" jaise alert atakne na paayein
    page.on("crash", () => { page.__crashed = true; });
    try {
      const passed = await this.withCf(Math.min(45000, budgetMs), async () => {
        try { await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: Math.min(20000, budgetMs) }); }
        catch (e) { // net atka / DNS / timeout: ek baar halka dobara, phir saaf network error
          alog("page.goto fail (" + String(e.message || e).split("\n")[0].slice(0, 80) + ") -> dobara");
          await page.waitForTimeout(1500);
          try { await page.goto(BASE, { waitUntil: "commit", timeout: 20000 }); await page.waitForTimeout(2500); }
          catch (e2) { throw new PplxError("perplexity.ai page khul nahi raha: " + String(e2.message || e2).split("\n")[0].slice(0, 120), "network"); }
        }
        const ok = await passChallenge(page);
        if (!ok) this.cfBadAt = Date.now(); else this.cfBadAt = 0;
        return ok;
      });
      if (!passed) {
        const info = await pageInfo(page);
        console.log("pplx challenge fail:", info);
        await shot(page, "challenge-fail"); await this.debug(page, "challenge");
        throw new PplxError("perplexity.ai bot check (headless block?) DUCK_HEADED=1 try karo | " + info.slice(0, 380), "challenge");
      }
      if (!(await autoPrepare(page, Math.min(25000, Math.max(8000, budgetMs - 5000))))) {
        const info = await pageInfo(page);
        console.log("pplx no-input:", info);
        await this.debug(page, "no-input");
        const low = info.toLowerCase();
        if (page.__why === "block") throw new PplxError("perplexity.ai ne block kiya (IP/bot) | " + info.slice(0, 380), "blocked");
        if (page.__why === "http") throw new PplxError("perplexity.ai server error page | " + info.slice(0, 380), "network");
        if (page.__why === "cf" || /verify you are human|just a moment|captcha|security verification|checking your browser|cloudflare/.test(low))
          throw new PplxError("perplexity.ai bot check (headless block?) DUCK_HEADED=1 try karo | " + info.slice(0, 380), "challenge");
        throw new PplxError("perplexity.ai input box nahi mila | " + info.slice(0, 380), "error");
      }
      return { page, box: page.locator(SEL.input).first(), t: Date.now() };
    } catch (e) { try { await page.close(); } catch {} throw e; }
  }

  // messages (OpenAI style) -> OpenAI chat.completion JSON string.
  // Fail ho (guest wall / submit nahi hua / error page) aur time bacha ho to EK baar naye session ke saath khud dobara koshish.
  async chat(args, timeoutMs = 100000) {
    const t0 = Date.now();
    try { return await this._chat(args, timeoutMs); }
    catch (e) {
      const left = timeoutMs - (Date.now() - t0);
      if (e instanceof PplxError && e.kind !== "bad_request" && left > 35000 && process.env.PPLX_RETRY !== "0") {
        console.log("pplx: auto-retry (" + e.kind + ") naye session ke saath, " + Math.round(left / 1000) + "s bache");
        if (this.active === 0) { try { await this.freshSession(); } catch (e2) { console.log("pplx freshSession fail:", e2.message); } } // doosra chat chal raha ho to session mat todo
        return await this._chat(args, left);
      }
      throw e;
    }
  }

  async _chat({ model, messages }, timeoutMs = 100000) {
    const prompt = flatten(messages).slice(-MAX_PROMPT);
    if (!prompt.trim()) throw new PplxError("empty prompt", "bad_request");
    await this.ensure();
    await this.slot();
    const deadline = Date.now() + timeoutMs;
    let h = null;
    try {
      // pool me tayyar page ho to wahi (pool khud naya bharta hai), warna naya kholo
      if (WARM_ON) h = await this.pool.take();
      if (!h) h = await this.open(Math.min(60000, timeoutMs));
      await topLog(h.page, "page-mila"); await shot(h.page, "1-page-mila");
      // garam page purana ho sakta hai (popup wapas aaya / crash): autopilot dobara jaanch le; na bane to naya page
      if (!(await autoPrepare(h.page, 15000))) {
        console.log("pplx: warm page theek nahi hua:", (await pageInfo(h.page).catch(() => "")).slice(0, 300));
        await this.debug(h.page, "nobox");
        try { await h.page.close(); } catch {}
        h = null; h = await this.open(Math.max(20000, Math.min(60000, deadline - Date.now())));
      }
      const { page } = h;

      let sse = "";
      page.on("response", async (r) => {
        try { if (/perplexity_ask/.test(r.url()) && r.request().method() === "POST") sse = await r.text(); } catch {}
      });
      await topLog(page, "tayyar"); await shot(page, "2-tayyar");
      const typed = await typePrompt(page, prompt);
      if (!typed) { await this.debug(page, "notype"); throw new PplxError("perplexity.ai prompt box me text nahi ja raha | " + (await pageInfo(page).catch(() => "")).slice(0, 380), "error"); }
      await topLog(page, "type-ke-baad (" + typed + " akshar)"); await shot(page, "3-type-ke-baad");
      const how = await sendPrompt(page, () => sse);
      if (!how) {
        await topLog(page, "submit-nahi-hua"); await this.debug(page, "nosend");
        throw new PplxError("perplexity.ai submit nahi hua | " + (await pageInfo(page).catch(() => "")).slice(0, 380), "error");
      }
      console.log("pplx: submit hua (" + how + ")"); await shot(page, "4-submit-ke-baad");

      // jawab aane tak ruko: SSE mile ya DOM me text thehar jaye
      const sweepSt = { tried: new Set() };
      let last = "", stable = 0, started = false, tick = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(350);
        const net = answerFromSSE(sse);
        if (net && sse) { console.log("pplx: jawab SSE se (saaf)"); await this.guard(net, page); return completion(model || DEFAULT_MODEL, net.trim()); } // SSE poora aate hi turant
        if (!last && tick > 0 && tick % 15 === 0) await topLog(page, "intezaar-" + Math.round(tick * 0.35) + "s"); // ~5s me ek baar
        if (++tick % 5 === 0 && !last) await autoStep(page, sweepSt, { sweep: true }); // sign-in popup beech me aaye to autopilot hata de
        if (tick % 8 === 0 && !last) { // "Internal Error ... Return home" page: 100s ruk ke kya fayda, jaldi error do
          const bt = await page.innerText("body").catch(() => "");
          if (/internal error|something went wrong|return home/i.test(bt)) { console.log("pplx: internal error page mila, jaldi fail"); break; }
        }
        if (page.__crashed || page.isClosed()) throw new PplxError("perplexity.ai page crash / band ho gaya", "error");
        if (tick % 8 === 4 && !last) { // jawab abhi nahi aaya: limit / beech me challenge / error to nahi?
          const bt = (await page.innerText("body").catch(() => "")).toLowerCase();
          const tt = (await page.title().catch(() => "")).toLowerCase();
          if (RX_LIMIT.test(bt)) await this.guard("Sign up and repeat your request.", page); // guest limit: session reset + ratelimit error
          if (/just a moment|attention required/.test(tt) || /performing security verification|verify you are human/.test(bt.slice(0, 300))) throw new PplxError("jawab ke beech Cloudflare challenge aa gaya", "challenge");
          if (RX.block.test(tt + " " + bt.slice(0, 300))) throw new PplxError("jawab ke beech site ne block kiya", "blocked");
        }
        await hideChips(page);
        const els = page.locator(SEL.answer);
        const n = await els.count().catch(() => 0);
        const txt = n ? (await els.nth(n - 1).innerText().catch(() => "")).trim() : "";
        if (txt) started = true;
        const generating = (await page.locator(SEL.stop).count().catch(() => 0)) > 0;
        if (txt && txt === last && !generating) { if (++stable >= 4) { console.log("pplx: jawab DOM se; sse mila:", sse ? "haan, parse khali (" + sse.slice(0, 160).replace(/\s+/g, " ") + ")" : "nahi"); await this.guard(txt, page); return completion(model || DEFAULT_MODEL, cleanDom(txt)); } } // ~1.4s same text
        else stable = 0;
        last = txt;
      }
      await topLog(page, started ? "partial" : "timeout");
      await this.debug(page, started ? "partial" : "timeout");
      if (last) { await this.guard(last, page); return completion(model || DEFAULT_MODEL, cleanDom(last)); } // adhura hi sahi
      const info = await pageInfo(page).catch(() => "");
      const sseHead = sse ? " [" + sse.slice(0, 200).replace(/\s+/g, " ") + "]" : "";
      console.log("pplx timeout: sse=" + (sse ? sse.length + " bytes" : "nahi") + sseHead + " | " + info);
      throw new PplxError("perplexity.ai timeout | sse=" + (sse ? sse.length + "B" + sseHead : "nahi") + " | " + info.slice(0, 450), "timeout");
    } finally {
      try { await h?.page?.close(); } catch {}
      this.free();
    }
  }

  // login wall / guest limit mila to error do (jawab bana ke mat bhejo) aur session reset karo
  async guard(text, page) {
    if (!isWall(text)) return;
    console.log("pplx: guest limit / login wall:", String(text).trim().slice(0, 120));
    await this.debug(page, "wall");
    try { await this.ctx.clearCookies(); } catch {} // naya anonymous session agli baar
    if (WARM_ON) this.pool.flush(); // purani session wale warm pages hatao
    throw new PplxError("perplexity.ai guest limit (login/sign up maang raha hai). Thodi der baad try karo", "ratelimit");
  }

  warmReady(ms) { return WARM_ON ? this.pool.settled(ms) : Promise.resolve(); }

  async warmup() { try { await this.ensure(); if (WARM_ON) this.pool.start(); } catch (e) { console.log("pplx warmup fail:", e.message); } }

  async close() {
    try { await this.pool.closeAll(); } catch {}
    try { await this.browser?.close(); } catch {}
    this.browser = null; this.ctx = null; this.starting = null;
  }
}

// ---- akele chalao: node perplexity.js "prompt" ----------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: PONG";
  const c = new PplxClient();
  try {
    const t0 = Date.now();
    const r = JSON.parse(await c.chat({ model: "pplx-auto", messages: [{ role: "user", content: prompt }] }, 100000));
    console.log("\n=== PPLX OK in", Date.now() - t0, "ms ===\n" + r.choices[0].message.content);
    await c.close();
    process.exit(0);
  } catch (e) {
    console.log("\n=== PPLX FAIL ===", e.kind || "", e.message);
    await c.close();
    process.exit(1);
  }
}
