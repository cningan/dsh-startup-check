import { defineTool } from "@deepseek-ai/dsh-tools";
import { BUNDLED_SKILL_RANK } from "@deepseek-ai/dsh-skill";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectedText, liveSmoke } from "./smoke.js";
import { killPid, listDshInstances, STALE_SMOKE_SECONDS } from "./instances.js";

export const name = "startup-check";
export const inject = ["tools", "subprocess", "fs", "skills"];

const PROFILE = "web";
const PROFILE_DIR = join(homedir(), ".dsh", "profiles", PROFILE);
const PLUGINS_DIR = join(PROFILE_DIR, "plugins");
const PATCH_FILE = join(PROFILE_DIR, "cordis.patch.yml");

/**
 * Run a command and capture exit code + stdout/stderr text.
 *
 * `cwd` is mandatory as of DSH 0.1.5: `subprocess.spawn` now passes `spec.cwd`
 * straight into its env validation (`validateNoNullByte("options.cwd", spec.cwd)`
 * → `spec.cwd.includes("\0")`), so an omitted `cwd` throws
 * "Cannot read properties of undefined (reading 'includes')" before launch.
 */
async function run(ctx, argv, stdoutMax, stderrMax, signal) {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: PROFILE_DIR,
    graceMs: 1500,
    ...(signal ? { signal } : {}),
    stdio: {
      stdin: "ignore",
      stdout: stdoutMax > 0 ? { maxBytes: stdoutMax } : "ignore",
      stderr: stderrMax > 0 ? { maxBytes: stderrMax } : "ignore",
    },
  });
  const outcome = await handle.done;
  return { exitCode: outcome.exitCode, stdout: collectedText(handle, "stdout"), stderr: collectedText(handle, "stderr") };
}

/**
 * Read a text file through `ctx.fs`; returns null when missing/unreadable.
 *
 * NOTE (restored 2026-09-10): these three helpers were dropped when `liveSmoke`
 * moved into `lib/smoke.js`, but their call sites stayed — so the on-disk file
 * threw `ReferenceError` in a fresh process while every `plugin_check` run kept
 * working, because a running dsh serves the code it booted with. `node --check`
 * and the tree-boot smoke cannot see this: the tool body is never executed.
 */
async function readFileText(ctx, path) {
  try {
    const target = await ctx.fs.resolve(path);
    return await ctx.fs.readText(target);
  } catch (e) {
    return null;
  }
}

/** List directory entries (names) through `ctx.fs`; [] when missing. */
async function listDirNames(ctx, path) {
  try {
    const target = await ctx.fs.resolve(path);
    const entries = await ctx.fs.listDir(target);
    return (entries || []).map((e) => (typeof e === "string" ? e : e.name));
  } catch (e) {
    return [];
  }
}

/** Resolve a local package's filesystem path through `ctx.fs`. */
async function fsPath(ctx, path) {
  try {
    return ctx.fs.processPath(await ctx.fs.resolve(path));
  } catch (e) {
    return null;
  }
}

/**
 * Bundled companion skill: `plugin-fault-diagnosis`.
 *
 * The skill is the "what to do after plugin_check says ok:false" playbook, and
 * it only means anything while this plugin (which owns the tool) is loaded —
 * so it ships inside the package instead of a local skill directory. Same
 * shape as the official bundled provider (`@deepseek-ai/dsh-skill-badge`):
 * `ctx.skills.registerProvider` + a body under `assets/`.
 * Body: `assets/plugin-fault-diagnosis.md` (frontmatter fields reproduced below).
 */
const SKILL_PROVIDER_NAME = "dsh-startup-check";
const SKILL_BODY_URL = new URL("../assets/plugin-fault-diagnosis.md", import.meta.url);
const SKILL_RESOURCE_BASE = {
  kind: "directory",
  path: fileURLToPath(new URL("../assets/", import.meta.url))
};
const SKILL_CANDIDATE = {
  name: "plugin-fault-diagnosis",
  description: "dsh 插件预检失败（plugin_check 返回 ok:false）后的诊断与修复——读裁决定位坏插件/文件、按错误类型判根因、分「能修／疑似禁用／回退」处置、重跑验证并留痕。触发场景见 whenToUse。",
  whenToUse: "当 plugin_check 返回 ok:false、或用户报告「安装/修改插件后重启打不开/报错」、或需要按 plugin_check 输出定位并修复坏插件时加载。",
  invocation: {
    modelInvocable: true,
    userInvocable: true
  },
  provider: SKILL_PROVIDER_NAME,
  source: "bundled",
  resourceBase: SKILL_RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL
};
/** The bundled provider registered on `ctx.skills`. */
const faultDiagnosisSkillProvider = {
  name: SKILL_PROVIDER_NAME,
  list: () => Promise.resolve([SKILL_CANDIDATE]),
  async get(_candidate) {
    return {
      name: SKILL_CANDIDATE.name,
      description: SKILL_CANDIDATE.description,
      whenToUse: SKILL_CANDIDATE.whenToUse,
      invocation: SKILL_CANDIDATE.invocation,
      provider: SKILL_CANDIDATE.provider,
      source: SKILL_CANDIDATE.source,
      resourceBase: SKILL_RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, "utf8")
    };
  }
};

export function apply(ctx) {
  ctx.skills.registerProvider(() => faultDiagnosisSkillProvider);
  ctx.tools.register(defineTool({
    name: "plugin_check",
    description: "Pre-flight check of the dsh web profile's plugin tree before a restart: "
      + "catches 'install a plugin -> it breaks -> restart fails to open' before you restart. "
      + "Checks: (1) syntax of every @local plugin lib/*.js (node --check), "
      + "(2) package.json structure of every @local plugin (main/exports/dsh.client consistency), "
      + "(3) every @local package referenced by cordis.patch.yml actually exists, "
      + "(4) the composed config tree assembles (dsh --profile web --dump-config). "
      + "Pass live:true for (5) a real-boot smoke: spawn an isolated 'dsh --profile web --port 0 --no-open' "
      + "instance on an OS-assigned port and confirm it prints the 'dsh web:' URL, then (7) confirm by the "
      + "process table that the instance really exited (a lingering instance holds a session write lease and "
      + "makes the next session fail to resume with SessionAlreadyOwnedError). "
      + "Pass page:true for (6) the page half of that smoke: load the booted instance in headless Edge "
      + "through CDP and report client-side failures (uncaught exceptions, console/log errors, "
      + "'failed to apply loader entry' style plugin load failures) that the host-only check cannot see. "
      + "Pass sweep:true for (8) an instance audit without booting anything: list every live DSH process "
      + "(isolated smoke instance / web host / other) so stray instances can be found; add killStray:true to "
      + "kill the isolated '--port 0' smoke leftovers by exact pid (web hosts are never killed). "
      + "Run after installing, patching, or editing any plugin. Safe: never restarts or touches the running profile.",
    parameters: {
      target: {
        type: "string",
        description: "Optional: check only one @local plugin name (e.g. 'dsh-ssh') instead of all."
      },
      live: {
        type: "boolean",
        description: "Optional: after static checks, spawn an isolated 'dsh --profile web --port 0 --no-open' instance and confirm it boots (real smoke), then confirm it exited. Heavy: takes ~12s. Never touches the running profile/port."
      },
      page: {
        type: "boolean",
        description: "Optional: also run the page-side half (implies live): load the booted URL in headless Edge through CDP and report page exceptions/console errors. Heavy: ~30-45s. Read-only; uses a throwaway browser profile under %TEMP%. Never touches the running port."
      },
      sweep: {
        type: "boolean",
        description: "Optional: audit live DSH processes (isolated smoke instances / web hosts / other) without booting anything. Use it to explain 'there is always some stray instance'. ~1-2s."
      },
      killStray: {
        type: "boolean",
        description: "Optional, with live/sweep: kill isolated '--port 0' smoke instances by exact pid (taskkill /T /F) after confirming each pid from the process table. Web hosts and other tools are never killed."
      }
    },
    output: {
      schema: { type: "json" },
      render(args, value) {
        return [{ type: "text", text: JSON.stringify(value) }];
      },
    },
    async execute(args, exec) {
      const signal = exec && exec.signal ? exec.signal : undefined;
      const target = String(args.target || "").trim();
      const page = !!args.page;
      const live = !!args.live || page;
      const sweep = !!args.sweep;
      const killStray = !!args.killStray;
      const checks = [];
      let ok = true;

      // ---- (3) patch-referenced @local packages exist ----
      const patchText = await readFileText(ctx, PATCH_FILE);
      if (patchText === null) {
        ok = false;
        checks.push({ name: "patch 引用存在性", ok: false, detail: "cannot read " + PATCH_FILE });
      } else {
        const refs = [...new Set((patchText.match(/name:\s*'(@local\/[^']+)'/g) || [])
          .map((m) => m.replace(/^name:\s*'/, "").replace(/'$/, "")))];
        // Plugin bodies live under profiles/web/plugins (the loader resolves
        // @local/* from there; node_modules/@local junctions are optional).
        const pluginDirs = new Set(await listDirNames(ctx, PLUGINS_DIR));
        const missing = refs.filter((ref) => !pluginDirs.has(ref.replace("@local/", "")));
        if (missing.length > 0) {
          ok = false;
          checks.push({ name: "patch 引用存在性", ok: false, detail: "patch 引用但插件目录不存在: " + missing.join(", ") });
        } else {
          checks.push({ name: "patch 引用存在性", ok: true, detail: refs.length + " 个 @local 引用全部存在" });
        }
      }

      // ---- (1)+(2) per-plugin syntax & package structure ----
      const pluginNames = (await listDirNames(ctx, PLUGINS_DIR)).filter((n) => !n.startsWith("."));
      let syntaxFailures = [];
      let structureFailures = [];
      const checkedNames = [];
      for (const name of pluginNames) {
        if (target && name !== target) continue;
        checkedNames.push(name);
        const pkgText = await readFileText(ctx, join(PLUGINS_DIR, name, "package.json"));
        if (pkgText === null) {
          structureFailures.push(name + ": package.json 缺失");
          continue;
        }
        let pkg;
        try {
          pkg = JSON.parse(pkgText);
        } catch (e) {
          structureFailures.push(name + ": package.json 不是合法 JSON (" + (e.message || e) + ")");
          continue;
        }
        if (typeof pkg.name !== "string" || !pkg.name.startsWith("@local/")) {
          structureFailures.push(name + ": package.json name 应为 @local/* 前缀");
        }
        const mainFile = pkg.main || "lib/index.js";
        const mainPath = await fsPath(ctx, join(PLUGINS_DIR, name, mainFile));
        if (mainPath === null) {
          structureFailures.push(name + ": main(" + mainFile + ") 文件不存在");
        }
        if (pkg.dsh && pkg.dsh.client) {
          const clientSpec = pkg.exports && pkg.exports["./client"];
          if (!clientSpec) {
            structureFailures.push(name + ": 声明了 dsh.client 但 exports 缺 './client' 入口");
          } else {
            const clientTarget = (clientSpec.default || clientSpec) + "";
            const clientPath = await fsPath(ctx, join(PLUGINS_DIR, name, clientTarget.replace(/^\.\//, "")));
            if (clientPath === null) {
              structureFailures.push(name + ": exports['./client'] 指向的文件不存在 (" + clientTarget + ")");
            }
          }
        }
        // syntax check every lib/*.js
        const libNames = (await listDirNames(ctx, join(PLUGINS_DIR, name, "lib")))
          .filter((f) => f.endsWith(".js"));
        for (const file of libNames) {
          const full = join(PLUGINS_DIR, name, "lib", file);
          const procPath = await fsPath(ctx, full);
          if (procPath === null) {
            syntaxFailures.push(name + "/lib/" + file + ": 无法解析路径");
            continue;
          }
          const r = await run(ctx, ["node", "--check", procPath], 0, 8192, signal);
          if (r.exitCode !== 0) {
            syntaxFailures.push(name + "/lib/" + file + ": " + (r.stderr || ("exit " + r.exitCode)).trim().slice(0, 400));
          }
        }
      }
      if (syntaxFailures.length > 0) {
        ok = false;
        checks.push({ name: "语法检查", ok: false, detail: syntaxFailures.join(" | ") });
      } else {
        checks.push({ name: "语法检查", ok: true, detail: (target ? 1 : checkedNames.length) + " 个插件 lib/*.js 语法全部通过" });
      }
      if (structureFailures.length > 0) {
        ok = false;
        checks.push({ name: "package.json 结构", ok: false, detail: structureFailures.join(" | ") });
      } else {
        checks.push({ name: "package.json 结构", ok: true, detail: (target ? 1 : checkedNames.length) + " 个插件结构一致" });
      }

      // ---- (4) config tree assembly ----
      const cfg = await run(ctx, ["cmd.exe", "/c", "dsh", "--profile", PROFILE, "--dump-config"], 256 * 1024, 64 * 1024, signal);
      if (cfg.exitCode !== 0) {
        ok = false;
        checks.push({ name: "配置树组装", ok: false, detail: "dsh --profile " + PROFILE + " --dump-config 失败 (exit " + cfg.exitCode + "): " + (cfg.stderr || cfg.stdout).trim().slice(0, 800) });
      } else {
        const lines = cfg.stdout.split(/\r?\n/).filter(Boolean).length;
        checks.push({ name: "配置树组装", ok: true, detail: "配置树组装成功 (" + lines + " 行)" });
      }

      // ---- (5) optional real-boot smoke (--live) + (6) optional page smoke (page:true) ----
      // 进程表读数是"实例到底退没退"的唯一硬证据：`terminate()` 只是喊一声，而且我们起的是
      // `cmd.exe /c dsh …` —— 直接子进程是 cmd.exe、真正的实例是它的孙子，`handle.done`
      // 只证明 cmd.exe 没了。2026-09-11 实测到的残留正是"父进程已死、实例还在"这种形态。
      const spawnFn = () => ctx.subprocess.spawn.bind(ctx.subprocess);
      const auditInstances = () => listDshInstances({ spawn: spawnFn(), cwd: PROFILE_DIR, signal });
      const killInstances = async (list) => {
        const notes = [];
        for (const inst of list) {
          const result = await killPid({ spawn: spawnFn(), cwd: PROFILE_DIR, pid: inst.pid, signal });
          notes.push("PID " + inst.pid + " → " + result.detail);
        }
        return notes;
      };

      let beforeAudit;
      let smoke;
      if (live) {
        beforeAudit = await auditInstances();
        smoke = await liveSmoke({
          spawn: spawnFn(),
          cwd: PROFILE_DIR,
          profile: PROFILE,
          page,
          signal,
        });
        if (!smoke.hostOk) ok = false;
        checks.push({ name: "实跑冒烟(--live)", ok: smoke.hostOk, detail: smoke.hostDetail });
        if (page) {
          if (!smoke.pageOk) ok = false;
          checks.push({
            name: "页面冒烟(page)",
            ok: smoke.pageOk,
            detail: smoke.pageDetail + (smoke.pageLogs && smoke.pageLogs.length > 0
              ? " | 页面 log 摘录: " + smoke.pageLogs.join(" ; ")
              : ""),
          });
        }
      }

      // ---- (7) 关闭确认 + (8) 残留实例审计 ----
      if (live || sweep) {
        const after = await auditInstances();
        // 启动前那次审计（只有 live 有）是区分"本次起的"与"既有残留"的唯一依据。
        const baselineOk = !!(beforeAudit && beforeAudit.ok);
        const beforePids = new Set(((beforeAudit && beforeAudit.items) || []).map((i) => i.pid));
        const smokeItems = after.ok ? after.items.filter((i) => i.kind === "smoke") : [];
        // 本次起的：只在有基线时才成立；没有基线（sweep-alone，或启动前审计失败）时，
        // 所有隔离实例一律按"既有"处理——宁可少杀，不可误杀别的会话正在跑的冒烟。
        let own = baselineOk ? smokeItems.filter((i) => !beforePids.has(i.pid)) : [];
        let stale = baselineOk ? smokeItems.filter((i) => beforePids.has(i.pid)) : smokeItems;
        const hosts = after.ok ? after.items.filter((i) => i.kind === "host") : [];
        let ownKillNotes = [];
        let staleKillNotes = [];
        let rechecked = false;
        if (killStray && after.ok) {
          // 只清两类：本次泄漏的（有基线可归因）+ 活过 STALE_SMOKE_SECONDS 的既有残留。
          // 存活不足阈值的既有实例可能是别的会话正在用的冒烟 —— 只报不杀。
          const killable = stale.filter((i) => (i.ageSeconds ?? 0) >= STALE_SMOKE_SECONDS);
          if (own.length > 0 || killable.length > 0) {
            ownKillNotes = await killInstances(own);
            staleKillNotes = await killInstances(killable);
            const recheck = await auditInstances();
            if (recheck.ok) {
              rechecked = true;
              const alive = new Set(recheck.items.map((i) => i.pid));
              own = own.filter((i) => alive.has(i.pid));
              stale = stale.filter((i) => alive.has(i.pid));
            }
          }
        }

        if (live) {
          if (!after.ok) {
            checks.push({
              name: "实例关闭",
              ok: true,
              detail: "未测（进程表复查不可用：" + after.detail + "）；引擎侧观察：" + ((smoke && smoke.shutdown && smoke.shutdown.detail) || "无"),
            });
          } else if (!baselineOk) {
            checks.push({
              name: "实例关闭",
              ok: smokeItems.length === 0,
              detail: "未测（启动前审计不可用，无法区分「本次起的」与「既有」）；进程表现有隔离实例 " + smokeItems.length + " 个"
                + (smokeItems.length > 0 ? "（PID " + smokeItems.map((i) => i.pid).join(", ") + "）" : "")
                + "；引擎侧观察：" + ((smoke && smoke.shutdown && smoke.shutdown.detail) || "无"),
            });
          } else if (own.length === 0) {
            checks.push({
              name: "实例关闭",
              ok: true,
              detail: "本次起的隔离实例已退出，进程表无残留（" + ((smoke && smoke.shutdown && smoke.shutdown.detail) || "引擎侧无读数") + "）"
                + (ownKillNotes.length > 0 ? "；由强杀收尾：" + ownKillNotes.join("；") : ""),
            });
          } else {
            ok = false;
            checks.push({
              name: "实例关闭",
              ok: false,
              detail: "本次起的隔离实例仍在运行：" + own.map((i) => "PID " + i.pid + "（已活 " + (i.ageSeconds ?? "?") + "s）").join(", ")
                + "；活着的实例会占住会话写租约，新会话 resume 会报 SessionAlreadyOwnedError。"
                + "精确清理：plugin_check({killStray:true}) 或 taskkill /PID <pid> /T /F"
                + (ownKillNotes.length > 0 ? "；本次已尝试清理：" + ownKillNotes.join("；") + (rechecked ? "" : "（复查未成功，结果未证实）") : ""),
            });
          }
        }

        if (!after.ok) {
          checks.push({ name: "残留实例审计", ok: true, detail: "未测（进程表读不到）：" + after.detail });
        } else {
          const parts = [];
          const killNotes = [...ownKillNotes, ...staleKillNotes];
          if (killNotes.length > 0) {
            parts.push("本次已清理 " + killNotes.length + " 个隔离实例（" + killNotes.join("；") + "）"
              + (rechecked ? "" : "——复查未成功，结果未证实"));
          }
          if (stale.length > 0) {
            const old = stale.filter((i) => (i.ageSeconds ?? 0) >= STALE_SMOKE_SECONDS);
            const fresh = stale.filter((i) => (i.ageSeconds ?? 0) < STALE_SMOKE_SECONDS);
            if (old.length > 0) {
              parts.push("残留隔离实例 " + old.length + " 个（PID " + old.map((i) => i.pid).join(", ") + "）——killStray:true 可精确清理");
            }
            if (fresh.length > 0) {
              parts.push("另有 " + fresh.length + " 个存活不足 " + STALE_SMOKE_SECONDS + "s 的隔离实例（PID "
                + fresh.map((i) => i.pid).join(", ") + "）——可能正被别的会话使用，只报不杀");
            }
          }
          if (hosts.length > 0) {
            parts.push("web 宿主 " + hosts.length + " 个（PID "
              + hosts.map((i) => i.pid + (i.port ? "@" + i.port : "")).join(", ") + "）——本工具只报不碰宿主");
          }
          checks.push({
            name: "残留实例审计",
            ok: true,
            detail: parts.length === 0 ? "进程表无 DSH 残留（" + after.detail + "）" : parts.join("；"),
          });
        }
      }

      return { ok, checks };
    },
  }));
}
