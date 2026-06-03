// Playwright smoke test for the swipe pad UI.
// Stubs the WebSocket so we capture sends instead of talking to the real TV.

const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();

  const consoleErrs = [];
  page.on("pageerror", (e) => consoleErrs.push("pageerror: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrs.push("console.error: " + msg.text()); });

  await page.addInitScript(() => {
    window.__sent = [];
    window.WebSocket = class FakeWS {
      constructor(url) {
        this.url = url;
        this.readyState = 1; // OPEN
        window.__lastWS = this;
        setTimeout(() => {
          this.onmessage && this.onmessage({
            data: JSON.stringify({ event: "ms.channel.connect", data: { token: "test" } })
          });
        }, 50);
      }
      send(d) { window.__sent.push(d); }
      close() {}
    };
    window.WebSocket.OPEN = 1;
    window.WebSocket.CONNECTING = 0;
    window.WebSocket.CLOSING = 2;
    window.WebSocket.CLOSED = 3;
  });

  await page.goto("http://localhost:8080");
  await page.waitForTimeout(200);

  await page.screenshot({ path: "/tmp/remote-ui.png", fullPage: false });

  const padBox = await page.locator("#pad").boundingBox();
  const cx = padBox.x + padBox.width / 2;
  const cy = padBox.y + padBox.height / 2;

  async function clearSent() { await page.evaluate(() => { window.__sent = []; }); }
  async function getSent() { return page.evaluate(() => window.__sent.slice()); }
  async function pushFromServer(msg) {
    await page.evaluate((m) => {
      window.__lastWS && window.__lastWS.onmessage({ data: JSON.stringify(m) });
    }, msg);
  }

  function decodeKey(json) {
    try { const m = JSON.parse(json); return m.params && m.params.DataOfCmd; } catch { return "?"; }
  }
  function decodeType(json) {
    try { return JSON.parse(json).type || "?"; } catch { return "?"; }
  }
  function decodeApp(json) {
    try { return JSON.parse(json).appId || "?"; } catch { return "?"; }
  }
  function countKey(arr, key) {
    return arr.filter((j) => decodeKey(j) === key).length;
  }

  async function swipe(fromX, fromY, toX, toY) {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
  async function tap(x, y) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(40);
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
  async function holdElement(selector, ms) {
    const box = await page.locator(selector).boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
    await page.waitForTimeout(60);
  }

  const results = [];
  function record(name, expected, actual) {
    results.push([name, String(expected), String(actual)]);
  }

  // Warmup: the very first synthesised mouse interaction in headless Chromium
  // sometimes drops the pointerup. A throwaway tap settles things before
  // assertions begin.
  await tap(cx, cy);
  await page.waitForTimeout(80);

  // 1: tap center -> KEY_ENTER
  await clearSent();
  await tap(cx, cy);
  record("tap (center)", "KEY_ENTER", decodeKey((await getSent())[0] || ""));

  // 2-5: swipes
  await clearSent(); await swipe(cx - 60, cy, cx + 60, cy);
  record("swipe right", "KEY_RIGHT", decodeKey((await getSent())[0] || ""));
  await clearSent(); await swipe(cx + 60, cy, cx - 60, cy);
  record("swipe left", "KEY_LEFT", decodeKey((await getSent())[0] || ""));
  await clearSent(); await swipe(cx, cy + 60, cx, cy - 60);
  record("swipe up", "KEY_UP", decodeKey((await getSent())[0] || ""));
  await clearSent(); await swipe(cx, cy - 60, cx, cy + 60);
  record("swipe down", "KEY_DOWN", decodeKey((await getSent())[0] || ""));

  // 6: power button (state unknown = sends KEY_POWER)
  await clearSent();
  await page.locator("#power-btn").click();
  record("power (unknown state)", "KEY_POWER", decodeKey((await getSent())[0] || ""));

  // 7: Vol Up tap (single fire)
  await clearSent();
  await page.locator('button[aria-label="Volume up"]').click();
  record("Vol Up tap", "KEY_VOLUP", decodeKey((await getSent())[0] || ""));

  // 8: hold Vol Up ~700ms -> ≥3 KEY_VOLUP via press-and-hold repeat
  await clearSent();
  await holdElement('button[aria-label="Volume up"]', 700);
  const volups = countKey(await getSent(), "KEY_VOLUP");
  record("Vol Up hold ≥3", "≥3", volups >= 3 ? "≥3 (" + volups + ")" : volups);

  // 9: state message -> header reflects "off"
  await pushFromServer({ type: "state", power: "off" });
  await page.waitForTimeout(50);
  const headerText = await page.locator("#status-text").textContent();
  const dotClass = await page.locator("#dot").getAttribute("class");
  record("state=off header", "off / standby", headerText + " / " + (dotClass.includes("standby") ? "standby" : "?"));

  // 10: power button when state=off -> WoL, not KEY_POWER
  await clearSent();
  await page.locator("#power-btn").click();
  const sentAfterWol = await getSent();
  record("power (state=off)", "wol", sentAfterWol.length ? decodeType(sentAfterWol[0]) : "(nothing)");

  // 11: state back to "on" -> power sends KEY_POWER again
  await pushFromServer({ type: "state", power: "on" });
  await page.waitForTimeout(50);
  await clearSent();
  await page.locator("#power-btn").click();
  record("power (state=on)", "KEY_POWER", decodeKey((await getSent())[0] || ""));

  // (pad-held tests must run BEFORE opening the sheet — backdrop covers the pad once it's open)
  // 12: pad hold-swipe right -> continuous KEY_RIGHT while held
  await clearSent();
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy, { steps: 6 });
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForTimeout(80);
  const padRights = countKey(await getSent(), "KEY_RIGHT");
  record("pad hold-right ≥3", "≥3", padRights >= 3 ? "≥3 (" + padRights + ")" : padRights);

  // 13: open sheet, tap number 5
  await clearSent();
  await page.locator("#more-btn").click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: "/tmp/remote-ui-sheet.png", fullPage: false });
  await page.locator(".numpad .btn", { hasText: /^5$/ }).click();
  record("sheet -> number 5", "KEY_5", decodeKey((await getSent())[0] || ""));

  // 13: tap Netflix in sheet -> {type:"app",appId:"3201907018807"}
  await clearSent();
  await page.locator('button[data-app="3201907018807"]').click();
  const netflixSend = (await getSent())[0] || "";
  record("Apps -> Netflix", "3201907018807", decodeApp(netflixSend));

  // 15: click sound toggle persists to localStorage
  const beforeToggle = await page.evaluate(() => localStorage.getItem("clickSound"));
  await page.locator("#click-toggle").click();
  await page.waitForTimeout(60);
  const afterToggle = await page.evaluate(() => localStorage.getItem("clickSound"));
  record("click toggle persists", "different", afterToggle !== beforeToggle ? "different (" + beforeToggle + "->" + afterToggle + ")" : "same");

  // Print
  console.log("\n=== UI smoke test ===");
  let pass = 0, fail = 0;
  for (const [name, expected, actual] of results) {
    const ok = expected === actual || actual.startsWith(expected);
    console.log((ok ? "PASS " : "FAIL ") + name.padEnd(26) + "expected=" + String(expected).padEnd(20) + "actual=" + actual);
    ok ? pass++ : fail++;
  }
  console.log(`\n${pass}/${pass + fail} passed`);

  if (consoleErrs.length) {
    console.log("\nConsole/page errors:");
    consoleErrs.forEach((e) => console.log("  " + e));
  } else {
    console.log("\nNo console errors.");
  }

  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
