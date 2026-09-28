// Playwright step-driver for the kylab web UI walkthrough.
// Usage: node driver.mjs <script.json>
// Script = { "baseUrl": "...", "headless": true, "viewport": {"width":1440,"height":900},
//            "userDataDir": "...", "steps": [ ... ] }
// Step kinds: goto, shot, click, clickText, fill, type, press, wait, waitFor, eval,
//             text, html, count, hover, setInputFiles, viewport, note
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const scriptPath = process.argv[2];
if (!scriptPath) { console.error('usage: node driver.mjs <script.json>'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const baseUrl = cfg.baseUrl || 'http://localhost:5173';
const viewport = cfg.viewport || { width: 1440, height: 900 };
const headless = cfg.headless !== false;
const userDataDir = cfg.userDataDir || path.join(process.cwd(), '.pwprofile');
const shotDir = cfg.shotDir || path.join(process.cwd(), 'shots');
fs.mkdirSync(shotDir, { recursive: true });
fs.mkdirSync(path.dirname(userDataDir), { recursive: true });

const results = [];
const log = (o) => { results.push(o); };
const clip = (s, n = 4000) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n…[+${s.length - n} chars]` : s);

const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'msedge',
  headless,
  viewport,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  args: ['--disable-blink-features=AutomationControlled'],
});
if (cfg.initScript) await ctx.addInitScript(cfg.initScript);
const page = ctx.pages()[0] || await ctx.newPage();
page.setDefaultTimeout(cfg.timeout || 30000);

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(clip(m.text(), 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + clip(String(e.message), 300)));
const netFailures = [];
page.on('response', (r) => { if (r.status() >= 400) netFailures.push(`${r.status()} ${r.request().method()} ${r.url()}`); });
page.on('requestfailed', (r) => netFailures.push(`FAILED ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));

const sel = (s) => s; // selectors are plain CSS or text= / role= engine strings

try {
  for (let i = 0; i < cfg.steps.length; i++) {
    const st = cfg.steps[i];
    const label = `${i + 1}.${st.kind}`;
    try {
      switch (st.kind) {
        case 'note':
          log({ i: label, note: st.value }); break;
        case 'route': {
          if (st.action === 'unroute') {
            await page.unroute(st.url);
            log({ i: label, unroute: st.url }); break;
          }
          await page.route(st.url, async (route) => {
            if (st.action === 'abort') return route.abort('failed');
            if (st.action === 'timeout') return new Promise(() => {});
            if (st.action === 'fulfill500') {
              return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: st.detail || '内部错误' }) });
            }
            if (st.action === 'fulfill401') {
              return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: '会话已失效' }) });
            }
            return route.continue();
          });
          log({ i: label, route: `${st.url} -> ${st.action}` }); break;
        }
        case 'ensureLogin': {
          await page.goto(baseUrl + '/login', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(st.settle ?? 1500);
          if (page.url().includes('/login')) {
            await page.fill('#login-username', st.username);
            await page.fill('#login-password', st.password);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(2500);
          }
          log({ i: label, url: page.url() }); break;
        }
        case 'goto': {
          const url = st.url.startsWith('http') ? st.url : baseUrl + st.url;
          await page.goto(url, { waitUntil: st.waitUntil || 'domcontentloaded', timeout: st.timeout || 45000 });
          await page.waitForTimeout(st.settle ?? 1200);
          log({ i: label, url: page.url() }); break;
        }
        case 'shot': {
          const file = path.join(shotDir, st.path);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          await page.screenshot({ path: file, fullPage: !!st.fullPage });
          const size = fs.statSync(file).size;
          log({ i: label, shot: file, bytes: size }); break;
        }
        case 'click': {
          await page.locator(sel(st.selector)).first().click({ timeout: st.timeout || 15000, force: !!st.force });
          await page.waitForTimeout(st.settle ?? 400);
          log({ i: label, clicked: st.selector }); break;
        }
        case 'clickText': {
          await page.getByText(st.value, { exact: !!st.exact }).first().click({ timeout: st.timeout || 15000 });
          await page.waitForTimeout(st.settle ?? 400);
          log({ i: label, clickedText: st.value }); break;
        }
        case 'fill': {
          await page.locator(sel(st.selector)).first().fill(st.value, { timeout: st.timeout || 15000 });
          await page.waitForTimeout(st.settle ?? 200);
          log({ i: label, filled: st.selector }); break;
        }
        case 'type': {
          await page.locator(sel(st.selector)).first().pressSequentially(st.value, { delay: st.delay ?? 20 });
          await page.waitForTimeout(st.settle ?? 200);
          log({ i: label, typed: st.value.length }); break;
        }
        case 'press': {
          if (st.selector) await page.locator(sel(st.selector)).first().press(st.key, { timeout: st.timeout || 15000 });
          else await page.keyboard.press(st.key);
          await page.waitForTimeout(st.settle ?? 300);
          log({ i: label, pressed: st.key }); break;
        }
        case 'wait':
          await page.waitForTimeout(st.ms); log({ i: label, waited: st.ms }); break;
        case 'waitFor': {
          await page.locator(sel(st.selector)).first().waitFor({ state: st.state || 'visible', timeout: st.timeout || 30000 });
          log({ i: label, appeared: st.selector }); break;
        }
        case 'waitForText': {
          await page.getByText(st.value, { exact: false }).first().waitFor({ state: 'visible', timeout: st.timeout || 60000 });
          log({ i: label, appearedText: clip(st.value, 80) }); break;
        }
        case 'eval': {
          const v = await page.evaluate(st.code);
          log({ i: label, value: clip(typeof v === 'string' ? v : JSON.stringify(v)) }); break;
        }
        case 'text': {
          const v = await page.locator(sel(st.selector)).first().innerText({ timeout: st.timeout || 15000 });
          log({ i: label, text: clip(v, st.limit || 4000) }); break;
        }
        case 'html': {
          const v = await page.locator(sel(st.selector)).first().innerHTML({ timeout: st.timeout || 15000 });
          log({ i: label, html: clip(v, st.limit || 4000) }); break;
        }
        case 'count': {
          const v = await page.locator(sel(st.selector)).count();
          log({ i: label, count: v }); break;
        }
        case 'attr': {
          const v = await page.locator(sel(st.selector)).first().getAttribute(st.name);
          log({ i: label, attr: v }); break;
        }
        case 'hover': {
          await page.locator(sel(st.selector)).first().hover({ timeout: st.timeout || 15000 });
          await page.waitForTimeout(st.settle ?? 400);
          log({ i: label, hovered: st.selector }); break;
        }
        case 'setInputFiles': {
          await page.locator(sel(st.selector)).first().setInputFiles(st.files, { timeout: st.timeout || 20000 });
          await page.waitForTimeout(st.settle ?? 800);
          log({ i: label, uploaded: st.files.length }); break;
        }
        case 'viewport': {
          await page.setViewportSize({ width: st.width, height: st.height });
          await page.waitForTimeout(st.settle ?? 600);
          log({ i: label, viewport: `${st.width}x${st.height}` }); break;
        }
        case 'scroll': {
          if (st.selector) await page.locator(sel(st.selector)).first().evaluate((e, y) => e.scrollTop = y, st.y ?? 1e9);
          else await page.evaluate((y) => window.scrollTo(0, y), st.y ?? 1e9);
          await page.waitForTimeout(st.settle ?? 400);
          log({ i: label, scrolled: st.y ?? 'bottom' }); break;
        }
        default:
          log({ i: label, error: `unknown step kind ${st.kind}` });
      }
    } catch (err) {
      log({ i: label, error: String(err && err.message || err).split('\n')[0] });
      if (st.shotOnError) {
        const file = path.join(shotDir, `error-${i + 1}.png`);
        try { await page.screenshot({ path: file }); log({ i: label, shot: file }); } catch {}
      }
      if (st.fatal) throw err;
    }
  }
} finally {
  console.log(JSON.stringify({ finalUrl: page.url(), title: await page.title().catch(() => ''), consoleErrors: consoleErrors.slice(0, 25), netFailures: netFailures.slice(0, 25), steps: results }, null, 1));
  await ctx.close().catch(() => {});
}
