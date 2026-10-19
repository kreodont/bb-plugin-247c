import type { BbNavigate } from "@get-bb/plugin-sdk/app";

let request = 0;
/** The SDK resolves the project-aware thread route. BB's documented message
 * fragment is applied only after that route opens; never construct a thread
 * URL or replace the host's history state. Browser fragment navigation also
 * works for archived threads and messages outside the initial timeline page. */
export async function openSearchMessage(threadId: string, sequence: number, navigate: Pick<BbNavigate, "toThread">,
  location: Pick<Location, "pathname" | "replace"> = window.location,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 50))) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(threadId) || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid message target.");
  const current = ++request;
  navigate.toThread(threadId);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (current !== request) return;
    const parts = location.pathname.split("/");
    if (parts.at(-2) === "threads" && parts.at(-1) === threadId) {
      location.replace(`#msg=${sequence}`);
      return;
    }
    await wait();
  }
  throw new Error("The chat could not be opened at this message. Try Open chat.");
}
