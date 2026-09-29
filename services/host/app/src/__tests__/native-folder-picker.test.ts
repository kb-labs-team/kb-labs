import { describe, expect, it, vi } from "vitest";
import { createNativeFolderPicker, type FolderPickerCommand } from "../native-folder-picker.js";

describe("native Host folder picker", () => {
  it("uses macOS AppleScript and returns the selected absolute path", async () => {
    const run = vi.fn<FolderPickerCommand>().mockResolvedValue({ stdout: "/Users/alex/work/project/\n" });
    const picker = createNativeFolderPicker("darwin", run);

    await expect(picker()).resolves.toBe("/Users/alex/work/project");
    expect(run).toHaveBeenCalledWith("osascript", ["-e", expect.stringContaining("choose folder")]);
  });

  it("returns null when the user cancels the native dialog", async () => {
    const run = vi.fn<FolderPickerCommand>().mockRejectedValue({ code: 1, stderr: "User canceled." });
    const picker = createNativeFolderPicker("linux", run);
    await expect(picker()).resolves.toBeNull();
  });

  it("uses kdialog on Linux when zenity is not installed", async () => {
    const run = vi.fn<FolderPickerCommand>()
      .mockRejectedValueOnce({ code: "ENOENT" })
      .mockResolvedValueOnce({ stdout: "/home/alex/work/project\n" });
    const picker = createNativeFolderPicker("linux", run);

    await expect(picker()).resolves.toBe("/home/alex/work/project");
    expect(run).toHaveBeenNthCalledWith(2, "kdialog", ["--getexistingdirectory", ".", "Choose project folder"]);
  });

  it("provides an actionable error on headless Linux without a native chooser", async () => {
    const run = vi.fn<FolderPickerCommand>().mockRejectedValue({ code: "ENOENT" });
    const picker = createNativeFolderPicker("linux", run);
    await expect(picker()).rejects.toThrow("install zenity or kdialog on the Host machine");
  });

  it("does not mistake a missing Linux desktop session for user cancellation", async () => {
    const run = vi.fn<FolderPickerCommand>().mockRejectedValue({ code: 1, stderr: "Gtk-WARNING: cannot open display" });
    const picker = createNativeFolderPicker("linux", run);
    await expect(picker()).rejects.toMatchObject({ stderr: "Gtk-WARNING: cannot open display" });
  });
});
