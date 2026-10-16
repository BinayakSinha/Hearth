// Builds the browser bundles:
//  • public/ui/screen.html — Hearth's MCP App (one self-contained page, served as ui://hearth/screen.html)
//  • public/sim/app-bridge.js — the MCP Apps host bridge, used by the Alexa+ simulator to show that screen
// Run: npm run build:ui   (the outputs are committed, so this is only needed after editing ui/)
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const view = await build({
  entryPoints: ["ui/screen.ts"], bundle: true, format: "esm", target: "es2022", minify: true, write: false,
});
const js = view.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = readFileSync("ui/screen.html", "utf8").replace("/*SCRIPT*/", () => js);
mkdirSync("public/ui", { recursive: true });
writeFileSync("public/ui/screen.html", html);

await build({
  entryPoints: ["ui/app-bridge-entry.ts"], bundle: true, format: "esm", target: "es2022", minify: true,
  outfile: "public/sim/app-bridge.js",
});
console.log(`Built public/ui/screen.html (${Math.round(html.length / 1024)} KB) and public/sim/app-bridge.js`);
