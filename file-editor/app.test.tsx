// @vitest-environment jsdom

import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const editor = vi.hoisted(() => ({
  getValue: vi.fn(() => "fixture"),
  setValue: vi.fn(),
  setSelection: vi.fn(),
  revealRangeInCenter: vi.fn(),
  focus: vi.fn(),
  getModel: vi.fn(() => ({
    getLineCount: () => 160,
    getLineMaxColumn: () => 42,
    dispose: vi.fn(),
  })),
  onDidFocusEditorWidget: vi.fn(),
  onDidChangeModelContent: vi.fn(),
  addCommand: vi.fn(),
  updateOptions: vi.fn(),
  dispose: vi.fn(),
}));
const create = vi.hoisted(() => vi.fn(() => editor));
vi.mock("./lib/monaco-loader.js", () => ({
  loadMonaco: async () => ({
    editor: { create },
    KeyMod: { CtrlCmd: 1 },
    KeyCode: { KeyS: 2 },
  }),
  overflowWidgetsNode: () => document.body,
  setOverflowWidgetsTheme: vi.fn(),
}));
vi.mock("./lib/monaco-theme.js", () => ({
  applyCodeTheme: () => ({ name: "test", base: "vs-dark" }),
  editorBackground: () => "black",
}));

const app = await loadPluginApp(() => import("../app"));
const registration = app.fileOpeners[0]!;
const Component = registration.component;
const base: PluginFileOpenerProps = {
  path: "target.ts",
  source: {
    kind: "workspace",
    environmentId: "env_1",
    projectId: null,
    threadId: null,
  },
  Original: () => <div>native</div>,
};
const file = {
  kind: "text",
  content: "fixture",
  sha256: "hash",
  absolutePath: "/fixture/target.ts",
  relativePath: "target.ts",
};
function mount(
  range: PluginFileOpenerProps["experimental_lineRange"],
  read: () => unknown = () => file,
  write: (input: unknown) => unknown = () => ({ outcome: "written", sha256: "saved" }),
  reveal: (input: unknown) => unknown = () => ({ opened: true }),
) {
  return renderSlot(
    registration,
    { ...base, experimental_lineRange: range },
    {
      rpc: { editorAssets: () => ({ baseUrl: "/assets", expiresAtMs: 99999 }), editorRead: read, editorWrite: write, editorReveal: reveal },
    },
  );
}
const range = (startLineNumber: number, endLineNumber = startLineNumber) => ({
  startLineNumber,
  endLineNumber,
});

beforeEach(() => { vi.clearAllMocks(); editor.getValue.mockReturnValue("fixture"); });
afterEach(cleanup);

it("displays and copies the full host-native path while retaining relative RPC targets", async () => {
  const absolutePath = "C:\\Work\\clients\\sample.csv";
  const clipboard = vi.fn().mockResolvedValue(undefined), reveal = vi.fn().mockResolvedValue({ opened: true });
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  try {
    mount(null, () => ({ ...file, absolutePath }), undefined, reveal);
    const copy = await screen.findByRole("button", { name: "Copy file path" });
    await waitFor(() => expect(copy.textContent).toBe(absolutePath));
    fireEvent.click(copy);
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(absolutePath));
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith({ path: "target.ts", source: base.source }));
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("shows the current file in its folder without changing the buffer or saving", async () => {
  const write = vi.fn(), reveal = vi.fn().mockResolvedValue({ opened: true });
  const slot = mount(null, () => file, write, reveal);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("checkbox", { name: "Auto-save" }));
  changeContent("unsaved edits");
  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  await waitFor(() => expect(reveal).toHaveBeenCalledExactlyOnceWith({ path: "target.ts", source: base.source }));
  expect(write).not.toHaveBeenCalled();
  expect(editor.setValue).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
  slot.lifecycle.rerender(<Component {...base} path="next.ts" />);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  await waitFor(() => expect(reveal).toHaveBeenLastCalledWith({ path: "next.ts", source: base.source }));
});

it("reports an unavailable file manager and lets the user retry", async () => {
  const reveal = vi.fn().mockRejectedValue(new Error("Reconnect the file's machine"));
  mount(null, () => file, undefined, reveal);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Reconnect the file's machine"));
  expect(screen.getByRole("button", { name: "Show in folder" })).toHaveProperty("disabled", false);
});

it.each([range(80), range(120, 124)])(
  "selects and reveals the initial target %j after loading",
  async (target) => {
    mount(target);
    await waitFor(() =>
      expect(editor.setSelection).toHaveBeenCalledWith({
        ...target,
        startColumn: 1,
        endColumn: 42,
      }),
    );
    expect(editor.revealRangeInCenter).toHaveBeenCalledWith({
      ...target,
      startColumn: 1,
      endColumn: 42,
    });
  },
);

it.each([null, undefined])(
  "leaves an untargeted initial open alone (%s)",
  async (target) => {
    mount(target);
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(editor.setSelection).not.toHaveBeenCalled();
  },
);

it("navigates changed and repeated targets without recreating the editor", async () => {
  const slot = mount(range(80));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  const target = range(120, 124);
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={target} />,
  );
  await waitFor(() =>
    expect(editor.setSelection).toHaveBeenLastCalledWith({
      ...target,
      startColumn: 1,
      endColumn: 42,
    }),
  );
  editor.setSelection.mockClear();
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={target} />,
  );
  expect(editor.setSelection).not.toHaveBeenCalled();
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={{ ...target }} />,
  );
  expect(editor.setSelection).toHaveBeenCalledOnce();
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={null} />,
  );
  expect(editor.setSelection).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  expect(editor.dispose).not.toHaveBeenCalled();
});

it("uses only the latest target when several arrive before the file loads", async () => {
  let resolveRead = (_value: typeof file) => {};
  const pending = new Promise<typeof file>((resolve) => {
    resolveRead = resolve;
  });
  const slot = mount(range(30), () => pending);
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={range(90)} />,
  );
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={range(140)} />,
  );
  await act(async () => resolveRead(file));
  await waitFor(() => expect(editor.setSelection).toHaveBeenCalledOnce());
  expect(editor.setSelection).toHaveBeenLastCalledWith({
    ...range(140),
    startColumn: 1,
    endColumn: 42,
  });
  expect(create).toHaveBeenCalledOnce();
});

it("clamps a target beyond EOF to the final line", async () => {
  mount(range(200, 220));
  await waitFor(() =>
    expect(editor.setSelection).toHaveBeenCalledWith({
      ...range(160),
      startColumn: 1,
      endColumn: 42,
    }),
  );
});

it("does not create or navigate a disposed loading editor", async () => {
  let resolveRead = (_value: typeof file) => {};
  const pending = new Promise<typeof file>((resolve) => {
    resolveRead = resolve;
  });
  const slot = mount(range(80), () => pending);
  slot.lifecycle.unmount();
  await act(async () => resolveRead(file));
  expect(create).not.toHaveBeenCalled();
  expect(editor.setSelection).not.toHaveBeenCalled();
});

it("does not apply a stale target cleared during loading", async () => {
  let resolveRead = (_value: typeof file) => {};
  const pending = new Promise<typeof file>((resolve) => {
    resolveRead = resolve;
  });
  const slot = mount(range(80), () => pending);
  slot.lifecycle.rerender(
    <Component {...base} experimental_lineRange={null} />,
  );
  await act(async () => resolveRead(file));
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(editor.setSelection).not.toHaveBeenCalled();
});


function changeContent(content: string) {
  editor.getValue.mockReturnValue(content);
  act(() => editor.onDidChangeModelContent.mock.calls.at(-1)?.[0]());
}

it("saves from the visible button using the same path and version as the keyboard command", async () => {
  const write = vi.fn(() => ({ outcome: "written", sha256: "saved" }));
  mount(null, () => file, write);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(screen.getByRole("checkbox", { name: "Auto-save" })).toHaveProperty("checked", true);
  changeContent("clicked save");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith({ path: "target.ts", source: base.source, content: "clicked save", expectedSha256: "hash" }));
  await waitFor(() => expect(screen.queryByLabelText("Unsaved changes")).toBeNull());
  changeContent("keyboard save");
  await act(async () => editor.addCommand.mock.calls.at(-1)?.[1]());
  expect(write).toHaveBeenLastCalledWith({ path: "target.ts", source: base.source, content: "keyboard save", expectedSha256: "saved" });
});

it("auto-saves by default, allows opting out, and resets the default for another file", async () => {
  const write = vi.fn(() => ({ outcome: "written", sha256: "saved" }));
  const slot = mount(null, () => file, write);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  vi.useFakeTimers();
  try {
    expect(screen.getByRole("checkbox", { name: "Auto-save" })).toHaveProperty("checked", true);
    changeContent("automatic save");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: "automatic save" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-save" }));
    changeContent("manual save only");
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(write).toHaveBeenCalledTimes(1);
    slot.lifecycle.rerender(<Component {...base} path="another.ts" />);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("checkbox", { name: "Auto-save" })).toHaveProperty("checked", true);
  } finally {
    slot.lifecycle.unmount();
    vi.useRealTimers();
  }
});

it("keeps edits made while a reload is pending", async () => {
  let resolveRead!: (value: typeof file) => void;
  const pending = new Promise<typeof file>((resolve) => { resolveRead = resolve; });
  const read = vi.fn().mockResolvedValueOnce(file).mockReturnValueOnce(pending);
  mount(null, read);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Reload from disk" }));
  changeContent("new typing");
  await act(async () => resolveRead({ ...file, content: "disk version" }));
  expect(editor.setValue).not.toHaveBeenCalled();
  expect(screen.getByText(/You edited the file while it was reloading/)).toBeTruthy();
});
