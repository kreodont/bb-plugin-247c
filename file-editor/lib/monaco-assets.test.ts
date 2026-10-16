import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { monacoAssetDirectory } from "./monaco-assets.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "editor-assets-")); roots.push(root);
  const assets = path.join(root, "dist", "monaco"); mkdirSync(assets, { recursive: true });
  for (const name of ["editor.js", "editor.css", "editor.worker.js"]) writeFileSync(path.join(assets, name), "shipped asset");
  return { root, assets };
}

it("uses shipped assets when Git checkout timestamps make source files appear newer, without a build toolchain", () => {
  const { root, assets } = fixture();
  mkdirSync(path.join(root, "monaco-bundle")); mkdirSync(path.join(root, "scripts"));
  const newer = new Date(Date.now() + 60_000);
  for (const name of ["package.json", "monaco-bundle/editor.js", "scripts/stage-assets.mjs"]) {
    const file = path.join(root, name);
    writeFileSync(file, "throw new Error('Runtime must not build assets')"); utimesSync(file, newer, newer);
  }
  expect(existsSync(path.join(root, "node_modules"))).toBe(false);
  expect(monacoAssetDirectory(root)).toBe(assets);
  expect(monacoAssetDirectory(path.join(root, "dist"))).toBe(assets);
});

it.each(["editor.js", "editor.css", "editor.worker.js"])("reports missing %s with recovery instructions instead of trying to rebuild", missing => {
  const { root, assets } = fixture(); rmSync(path.join(assets, missing));
  expect(() => monacoAssetDirectory(root)).toThrow(/assets are missing or incomplete.*Reinstall/);
});

it("skips an incomplete candidate when another complete shipped bundle exists", () => {
  const { root, assets } = fixture(); mkdirSync(path.join(root, "monaco"));
  writeFileSync(path.join(root, "monaco", "editor.js"), "incomplete");
  expect(monacoAssetDirectory(root)).toBe(assets);
});
