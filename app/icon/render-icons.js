// Renders icon.svg into the Android launcher icons and splash screens (run with Playwright's Chromium).
//   node app/icon/render-icons.js
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const RES = path.join(__dirname, "..", "..", "android", "app", "src", "main", "res");
const svg = fs.readFileSync(path.join(__dirname, "icon.svg"), "utf8");
const BG = "#ffffff";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  async function render(file, w, h, iconSize, { round = false, bg = BG } = {}) {
    await page.setViewportSize({ width: w, height: h });
    const radius = round ? "50%" : "0";
    await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;background:${bg};border-radius:${radius};overflow:hidden">
      <div style="width:${iconSize}px;height:${iconSize}px">${svg.replace("<svg ", `<svg width="${iconSize}" height="${iconSize}" `)}</div></body></html>`);
    await page.screenshot({ path: file, omitBackground: round });
  }
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    const dir = path.join(RES, `mipmap-${d}`);
    // Legacy icons (Android 7): the whole 108 viewbox scaled into 48 dp shows the cylinder too small; zoom in.
    await render(path.join(dir, "ic_launcher.png"), 48 * k, 48 * k, Math.round(48 * k * 1.5));
    await render(path.join(dir, "ic_launcher_round.png"), 48 * k, 48 * k, Math.round(48 * k * 1.5), { round: true, bg: BG });
    await render(path.join(dir, "ic_launcher_foreground.png"), 108 * k, 108 * k, 108 * k, { bg: "transparent" });
  }
  for (const dir of fs.readdirSync(RES).filter((x) => x.startsWith("drawable"))) {
    const f = path.join(RES, dir, "splash.png");
    if (!fs.existsSync(f)) continue;
    const b = fs.readFileSync(f);
    const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
    await render(f, w, h, Math.round(Math.min(w, h) * 0.5));
  }
  await browser.close();
  console.log("icons rendered");
})();
