import { expect, it } from "vitest";
import { workspacePaths, resolveWorkspaceArtifact, workspaceFileUrl } from "./workspace-path.js";

it.each(["relative/work", "C:work", String.raw`\work`, "", "/work\0"])("rejects an unqualified workspace %j", root => {
  expect(workspacePaths(root)).toBeNull();
});

it.each([
  ["/work", "docs/report.md", "/work/docs/report.md"],
  ["C:/work", "docs/report.md", String.raw`C:\work\docs\report.md`],
  [String.raw`C:\work`, String.raw`docs\report.md`, String.raw`C:\work\docs\report.md`],
  [String.raw`\\server\share\work`, "docs/report.md", String.raw`\\server\share\work\docs\report.md`],
])("resolves artifacts using the workspace format %s", (root, input, path) => {
  expect(resolveWorkspaceArtifact(root, input)).toMatchObject({ path, relative: "docs/report.md" });
});

it.each([
  ["/work", "../secret"], ["C:/work", "../secret"], ["C:/work", String.raw`..\secret`],
  ["C:/work", "D:/work/report.md"], ["C:/work", "C:/work-other/report.md"],
  [String.raw`\\server\share\work`, String.raw`\\server\other\report.md`],
  ["C:/work", "C:report.md"], ["C:/work", "report.md:stream"],
  ["C:/work", String.raw`\\?\C:\work\report.md`], ["C:/work", "."],
])("rejects an unsafe artifact %s / %s", (root, input) => {
  expect(() => resolveWorkspaceArtifact(root, input)).toThrow();
});

it("compares Windows files and protected directories without case sensitivity", () => {
  expect(resolveWorkspaceArtifact("C:/work", "REPORT.md").identity).toBe(resolveWorkspaceArtifact("C:/work", "report.md").identity);
  expect(resolveWorkspaceArtifact("C:/work", ".SSH/config").relative).toBe(".ssh/config");
});

it("builds artifact URLs for the workspace host rather than the server platform", () => {
  expect(workspaceFileUrl("/work/plan.md")).toBe("file:///work/plan.md");
  expect(workspaceFileUrl(String.raw`C:\work\plan #1.md`)).toBe("file:///C:/work/plan%20%231.md");
  expect(workspaceFileUrl(String.raw`\\server\share\plan.md`)).toBe("file://server/share/plan.md");
});
