// pw.js - playwright-core ka EK hi loader (venice.js, duck.js, perplexity.js teeno yahi use karte hain).
//
// Pehle har provider ka apna loadPlaywright() tha. Teen dikkatein thin:
//  1) workflow ka background `npm i`, aur teeno loaders ke apne `npm i` (execFileSync) ek saath chalte the -> node_modules beech me
//     adhoora milta tha, import ho jata tha par `chromium` nahi milta tha -> "Cannot read properties of undefined (reading 'launch')".
//     ESM import ka nateeja process me cache ho jata hai, isliye wo galti poore runner ke liye atak jati thi.
//  2) execFileSync poora event loop rok deta tha (runner /next poll + /ack tak nahi bhej pata, jobs wapas queue me chali jati thin).
//  3) ek provider ki loading fail ho to baaki bhi saath girte the.
// Ab: pehle require() (CJS me `chromium` hamesha milta hai, fail hone par cache nahi hota), phir import(); sirf EK npm install,
// wo bhi async (event loop chalta rahta hai); fail hone par agli baar dobara koshish (galti cache nahi hoti).
import { createRequire } from "node:module";
import { execFile } from "node:child_process";

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPEC = process.env.PLAYWRIGHT_SPEC || "playwright-core@^1.56.0"; // package.json wala hi version, "latest" nahi

let cached = null, loading = null, installing = null;

function pick(mod) {
  for (const m of [mod, mod && mod.default, mod && mod.default && mod.default.default]) {
    const c = m && m.chromium;
    if (c && typeof c.launch === "function") return c;
  }
  return null;
}
const keysOf = (m) => { try { return Object.keys(m || {}).slice(0, 12).join(",") || "(khali)"; } catch { return "?"; } };

let lastSeen = "kuch nahi mila";
function tryRequire() {
  try { const m = require("playwright-core"); const c = pick(m); if (!c) lastSeen = "require: chromium nahi, keys=" + keysOf(m); return c; }
  catch (e) { lastSeen = "require: " + String((e && e.message) || e).split("\n")[0].slice(0, 140); return null; }
}
async function tryImport() {
  try { const m = await import("playwright-core"); const c = pick(m); if (!c) lastSeen = "import: chromium nahi, keys=" + keysOf(m); return c; }
  catch (e) { lastSeen = "import: " + String((e && e.message) || e).split("\n")[0].slice(0, 140); return null; }
}

// sirf EK npm install, async (event loop nahi rukta). Ek saath do install kabhi nahi chalte.
function npmInstallOnce() {
  if (!installing) {
    console.log("playwright-core install ho raha hai...");
    installing = new Promise((resolve) => {
      execFile("npm", ["i", "--no-audit", "--no-fund", "--no-save", SPEC], { timeout: 180000 }, (err, _out, stderr) => {
        if (err) console.log("playwright-core install fail:", String((stderr || err.message || err)).split("\n")[0].slice(0, 160));
        resolve();
      });
    }).finally(() => { installing = null; });
  }
  return installing;
}

// chromium (playwright ka BrowserType) lautata hai; na mile to saaf error (kya dikha wo bhi likha hota hai)
export function loadChromium() {
  if (cached) return Promise.resolve(cached);
  if (!loading) {
    loading = (async () => {
      for (let round = 0; round < 2; round++) {
        for (let i = 0; i < 20; i++) { // workflow ka install chal raha ho sakta hai: thoda ruk ke dekho
          const c = tryRequire() || (await tryImport());
          if (c) return c;
          await sleep(1000);
        }
        if (round === 0) await npmInstallOnce();
      }
      throw new Error("playwright-core ka chromium nahi mila (" + lastSeen + ")");
    })().then((c) => { cached = c; return c; }, (e) => { loading = null; throw e; });
  }
  return loading;
}
