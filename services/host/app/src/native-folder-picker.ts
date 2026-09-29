import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type FolderPickerPlatform = NodeJS.Platform;
export type FolderPickerCommand = (command: string, args: string[]) => Promise<{ stdout: string }>;

/** Opens the operating system's folder chooser on the machine running Host. */
export async function pickNativeFolder(): Promise<string | null> {
  return createNativeFolderPicker(process.platform, (command, args) => execFile(command, args))();
}

export function createNativeFolderPicker(platform: FolderPickerPlatform, run: FolderPickerCommand): () => Promise<string | null> {
  if (platform === "darwin") {
    return () => pickMacFolder(run);
  }
  if (platform === "win32") {
    return () => pickWindowsFolder(run);
  }
  if (platform === "linux") {
    return () => pickLinuxFolder(run);
  }
  return async () => {
    throw new Error(`Native folder picker is unsupported on Host platform "${platform}".`);
  };
}

async function pickMacFolder(run: FolderPickerCommand): Promise<string | null> {
  try {
    const { stdout } = await run("osascript", ["-e", "POSIX path of (choose folder with prompt \"Choose project folder\")"]);
    return stdout.trim().replace(/\/$/, "") || "/";
  } catch (error) {
    if (isCancelled(error)) {
      return null;
    }
    throw error;
  }
}

async function pickWindowsFolder(run: FolderPickerCommand): Promise<string | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Choose project folder'",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.SelectedPath) }",
  ].join("; ");
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-STA", "-Command", script]);
    return stdout.trim() || null;
  } catch (error) {
    if (isCancelled(error)) {
      return null;
    }
    throw error;
  }
}

async function pickLinuxFolder(run: FolderPickerCommand): Promise<string | null> {
  // Linux desktops commonly provide either GTK's zenity or KDE's kdialog.
  // A headless Host has neither and reports a useful error instead of silently
  // falling back to a browser-based path picker (which cannot return paths).
  try {
    const { stdout } = await run("zenity", ["--file-selection", "--directory", "--title=Choose project folder"]);
    return stdout.trim() || null;
  } catch (error) {
    if (isCancelled(error)) {
      return null;
    }
    if (isMissingExecutable(error)) {
      try {
        const { stdout } = await run("kdialog", ["--getexistingdirectory", ".", "Choose project folder"]);
        return stdout.trim() || null;
      } catch (fallbackError) {
        if (isCancelled(fallbackError)) {
          return null;
        }
        throw new Error("Native folder picker unavailable: install zenity or kdialog on the Host machine.", { cause: fallbackError });
      }
    }
    throw error;
  }
}

function isCancelled(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown };
  if (typeof candidate.stderr === "string" && candidate.stderr.length > 0) {
    return /cancel|user canceled/i.test(candidate.stderr);
  }
  if (typeof candidate.message === "string" && /user canceled/i.test(candidate.message)) {
    return true;
  }
  return candidate.code === 1 || candidate.code === "-128";
}

function isMissingExecutable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
