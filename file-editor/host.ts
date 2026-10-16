import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { editorHostContract } from "./host-contract.js";
import { revealFile } from "./reveal-file.js";

export default experimental_defineHostEntry({
  contract: editorHostContract,
  handlers: {
    revealFile: async (input, context) => {
      await revealFile(input, context.signal);
      return { opened: true as const };
    },
  },
});
