export type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict" };

type WriteResult =
  | { outcome: "written"; sha256: string }
  | { outcome: "conflict"; currentSha256: string | null };

export class SaveController {
  private state: SaveState = { kind: "clean" };
  private sha256: string;
  private autoSave = true;
  private disposed = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: {
    initialSha256: string;
    readContent: () => string;
    write: (content: string, expectedSha256: string | null) => Promise<WriteResult>;
    onState: (state: SaveState) => void;
    delayMs?: number;
  }) {
    this.sha256 = options.initialSha256;
  }

  private publish(state: SaveState) {
    if (this.disposed) return;
    this.state = state;
    this.options.onState(state);
  }

  private cancelTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.cancelTimer();
    if (this.disposed || this.paused || !this.autoSave || this.state.kind !== "dirty") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, this.options.delayMs ?? 1000);
  }

  changed() {
    if (this.disposed) return;
    if (this.state.kind === "clean") this.publish({ kind: "dirty" });
    this.schedule();
  }

  setAutoSave(enabled: boolean) {
    this.autoSave = enabled;
    this.schedule();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.schedule();
  }

  acceptDisk(sha256: string) {
    this.cancelTimer();
    this.sha256 = sha256;
    this.publish({ kind: "clean" });
  }

  fail(message: string) {
    this.cancelTimer();
    this.publish({ kind: "error", message });
  }

  async save(overwrite = false) {
    if (this.disposed || this.paused || this.state.kind === "saving") return;
    if (!overwrite && (this.state.kind === "clean" || this.state.kind === "conflict")) return;
    this.cancelTimer();
    const content = this.options.readContent();
    this.publish({ kind: "saving" });
    try {
      const result = await this.options.write(content, overwrite ? null : this.sha256);
      if (this.disposed) return;
      if (result.outcome === "conflict") {
        this.publish({ kind: "conflict" });
        return;
      }
      this.sha256 = result.sha256;
      this.publish({ kind: this.options.readContent() === content ? "clean" : "dirty" });
      this.schedule();
    } catch {
      this.fail("Save failed. Your changes are still in the editor. Click Save to retry.");
    }
  }

  dispose() {
    this.disposed = true;
    this.cancelTimer();
  }
}
