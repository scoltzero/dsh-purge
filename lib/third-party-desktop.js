/**
 * 第三方桌面壳（dsh-desktop / DSH NEXT 这一类 Electron 发行版）的解包支持。
 *
 * 这些发行版把宿主封在自己的 `app.asar` 里，普通 Node 进程写不进归档，于是所有代码补丁
 * 只能跳过（prompt-only）。Electron 本身支持 `resources/app` 目录形式，所以把 asar 解开、
 * 原包改名为备份，宿主下次启动就跑在真实文件上，补丁就能落盘。
 *
 * 全部可逆：`restoreThirdPartyDesktop()` 把 app/ 删掉、备份改回 app.asar。
 */
import fs from "node:fs";
import path from "node:path";
import { commitExtractedDir, extractAsarToSide } from "./extract-asar.js";

/** 原 asar 的备份后缀。 */
export const ASAR_BACKUP_SUFFIX = ".dsh-purge.bak";

function isFile(fp) {
  try {
    return fs.statSync(fp).isFile();
  } catch {
    return false;
  }
}

function isDir(fp) {
  try {
    return fs.statSync(fp).isDirectory();
  } catch {
    return false;
  }
}

/** `resources/app` 里 `@deepseek-ai` 包目录。 */
export function aiBaseOfExtracted(appDir) {
  return path.join(appDir, "node_modules", "@deepseek-ai");
}

/**
 * 认当前进程所在 Electron 应用的 Resources 目录。
 * macOS：`Foo.app/Contents/Resources`；Windows/Linux：可执行文件旁边的 `resources/`。
 * @returns {{appBundle: string, resources: string, asar: string, appDir: string, backup: string, hostRunsInAsar: boolean, sealed: boolean} | null}
 */
export function thirdPartyDesktopTargets(input = {}) {
  const execPath = String(input.execPath ?? process.execPath ?? "");
  const argv = (input.argv ?? process.argv) || [];
  const hostRunsInAsar = (Array.isArray(argv) ? argv : []).some(
    (arg) => typeof arg === "string" && /[\\/]app\.asar[\\/]/.test(arg),
  );
  if (!execPath) return null;

  let resources = "";
  const bundle = /^(.*?\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(execPath);
  if (bundle) {
    resources = path.join(bundle[1], "Contents", "Resources");
  } else {
    const beside = path.join(path.dirname(execPath), "resources");
    if (isDir(beside)) resources = beside;
  }
  if (!resources || !isDir(resources)) return null;

  const asar = path.join(resources, "app.asar");
  const appDir = path.join(resources, "app");
  return {
    appBundle: bundle ? bundle[1] : path.dirname(resources),
    resources,
    asar,
    appDir,
    backup: asar + ASAR_BACKUP_SUFFIX,
    hostRunsInAsar,
    sealed: isFile(asar),
  };
}

/**
 * 把第三方壳的 app.asar 解成 resources/app，原包改名备份。
 * @returns {{ok: boolean, unpacked?: boolean, alreadyUnpacked?: boolean, entries?: number, aiBase?: string, appDir?: string, backup?: string, reason?: string, error?: string}}
 */
export function unpackThirdPartyDesktop(input = {}) {
  const targets = thirdPartyDesktopTargets(input);
  if (!targets) return { ok: false, reason: "unknown-layout" };
  if (!targets.sealed) {
    return {
      ok: true,
      alreadyUnpacked: true,
      appDir: targets.appDir,
      aiBase: aiBaseOfExtracted(targets.appDir),
    };
  }
  let side = null;
  try {
    side = extractAsarToSide(targets.asar, targets.appDir);
    commitExtractedDir(targets.appDir, side.next);
  } catch (error) {
    return { ok: false, reason: "unpack-failed", error: String(error && error.message ? error.message : error) };
  }
  try {
    fs.renameSync(targets.asar, targets.backup);
  } catch (error) {
    // 解包目录已经能跑，但 asar 还在时 Electron 仍然优先用 asar → 让用户知道这一步没成功。
    return {
      ok: false,
      reason: "backup-failed",
      error: String(error && error.message ? error.message : error),
      appDir: targets.appDir,
    };
  }
  return {
    ok: true,
    unpacked: true,
    entries: side.count,
    aiBase: aiBaseOfExtracted(targets.appDir),
    appDir: targets.appDir,
    backup: targets.backup,
  };
}

/**
 * 还原：删掉解包目录、把备份改回 app.asar。
 * @returns {{ok: boolean, restored?: boolean, reason?: string, error?: string}}
 */
export function restoreThirdPartyDesktop(input = {}) {
  const targets = thirdPartyDesktopTargets(input);
  if (!targets) return { ok: false, reason: "unknown-layout" };
  try {
    if (isDir(targets.appDir)) {
      const aside = `${targets.appDir}.dsh-purge-restored-${Date.now()}`;
      fs.renameSync(targets.appDir, aside);
      fs.rmSync(aside, { recursive: true, force: true });
    }
    if (isFile(targets.backup)) fs.renameSync(targets.backup, targets.asar);
  } catch (error) {
    return { ok: false, reason: "restore-failed", error: String(error && error.message ? error.message : error) };
  }
  return { ok: true, restored: true, asar: targets.asar };
}

/** 已经解包（没有 app.asar、但有 resources/app）？ */
export function thirdPartyDesktopUnpacked(input = {}) {
  const targets = thirdPartyDesktopTargets(input);
  if (!targets) return false;
  return !targets.sealed && isDir(targets.appDir);
}
