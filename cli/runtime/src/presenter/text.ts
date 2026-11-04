import type { Presenter } from "./types";
import { sideBorderBox } from "@kb-labs/shared-cli-ui";

export function createTextPresenter(writeResult: (text: string) => void, isQuiet: boolean = false): Presenter {
  const isTTY = process.stdout.isTTY === true;
  return {
    isTTY,
    isQuiet,
    isJSON: false,
    write: (line) => {
      if (!isQuiet) {
        writeResult(line);
      }
    },
    info: (line) => {
      if (!isQuiet) {
        writeResult(line);
      }
    },
    warn: (line) => {
      if (!isQuiet) {
        console.warn(line);
      }
    },
    error: (line) => {
      const box = sideBorderBox({
        title: 'Error',
        sections: [{ items: [String(line)] }],
        status: 'error',
        wrap: process.stderr.isTTY === true,
        width: process.stderr.columns,
      });
      console.error(box);
    },
    json: (_payload) => {
      throw new Error("json() called in text mode");
    },
  };
}

export type TextPresenter = ReturnType<typeof createTextPresenter>;
