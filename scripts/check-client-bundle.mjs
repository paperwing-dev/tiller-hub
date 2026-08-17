import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const packageRoot = path.resolve(import.meta.dirname, "..");
const clientRoot = path.join(packageRoot, "dist", "client");
const manifestPath = path.join(clientRoot, ".vite", "manifest.json");
const maxStaticGzipBytes = 400_000;
const forbiddenStaticEntries = new Set([
  "src/dashboard-session-route.tsx",
  "src/dashboard-plan-route.tsx",
  "src/dashboard-ship-route.tsx",
  "src/dashboard-settings-routes.tsx",
  "src/NewEnvDialog.tsx",
  "src/StartPlanDialog.tsx",
  "src/SetupWizard.tsx",
  "src/UpdateDialog.tsx",
]);

if (!fs.existsSync(manifestPath)) {
  throw new Error(`Client manifest not found at ${manifestPath}. Run the Hub production build first.`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entry = Object.entries(manifest).find(([, value]) => value?.isEntry);
if (!entry) throw new Error("Client manifest has no entry module.");

const closure = new Set();
const visit = (key) => {
  if (closure.has(key)) return;
  const item = manifest[key];
  if (!item) throw new Error(`Client manifest import ${key} is missing.`);
  closure.add(key);
  for (const imported of item.imports ?? []) visit(imported);
};
visit(entry[0]);

for (const key of closure) {
  const source = manifest[key]?.src ?? key;
  if (forbiddenStaticEntries.has(source)) {
    throw new Error(`Heavy surface ${source} is in the initial static bundle closure.`);
  }
}

const files = new Set(
  [...closure]
    .map((key) => manifest[key]?.file)
    .filter((file) => typeof file === "string" && file.endsWith(".js")),
);
let gzipBytes = 0;
for (const file of files) {
  const absolutePath = path.join(clientRoot, file);
  gzipBytes += gzipSync(fs.readFileSync(absolutePath), { level: 9 }).byteLength;
}

if (gzipBytes > maxStaticGzipBytes) {
  throw new Error(
    `Initial client JavaScript is ${gzipBytes.toLocaleString()} gzip bytes; limit is ${maxStaticGzipBytes.toLocaleString()}.`,
  );
}

console.log(
  `Initial client JavaScript: ${gzipBytes.toLocaleString()} gzip bytes across ${files.size} static file(s).`,
);
