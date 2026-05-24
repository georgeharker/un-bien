import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  defaultRenderVars,
  detectPlatform,
  findNodeBinary,
  findSupervisorScript,
  findTemplate,
  launchdPlistPath,
  renderTemplate,
  systemdUnitPath,
} from "./install.js";

/**
 * Pure-function tests for the install module. We do NOT exercise the
 * actual `launchctl`/`systemctl` calls — those are platform-specific +
 * change real OS state. The smoke test for activation is documented in
 * the README and run manually.
 */

describe("detectPlatform", () => {
  test("returns 'macos' or 'linux' on supported platforms", () => {
    const p = detectPlatform();
    expect(["macos", "linux", "unsupported"]).toContain(p);
  });
});

describe("findNodeBinary", () => {
  test("returns process.execPath (absolute)", () => {
    expect(findNodeBinary()).toBe(process.execPath);
    expect(findNodeBinary().startsWith("/")).toBe(true);
  });
});

describe("findSupervisorScript", () => {
  test("ends with bin/supervisord.js (whatever distRoot is)", () => {
    expect(findSupervisorScript().endsWith("/bin/supervisord.js")).toBe(true);
  });
});

describe("findTemplate", () => {
  test("systemd template file exists on disk", () => {
    const p = findTemplate("systemd");
    expect(p.endsWith("systemd.service.template")).toBe(true);
    // The file should be readable from this project's checkout (tests
    // run from pi-extension/, and templates live next to dist/).
    const content = readFileSync(p, "utf8");
    expect(content).toContain("[Service]");
    expect(content).toContain("{NODE}");
    expect(content).toContain("{SUPERVISOR}");
  });

  test("launchd template file exists on disk", () => {
    const p = findTemplate("launchd");
    expect(p.endsWith("launchd.plist.template")).toBe(true);
    const content = readFileSync(p, "utf8");
    expect(content).toContain("<key>Label</key>");
    expect(content).toContain("dev.remotepi.supervisord");
    expect(content).toContain("{NODE}");
    expect(content).toContain("{SUPERVISOR}");
  });
});

describe("renderTemplate", () => {
  const vars = {
    node: "/usr/local/bin/node",
    supervisor: "/Users/x/dist/bin/supervisord.js",
    home: "/Users/x",
    user: "jacob",
    path: "/usr/local/bin:/usr/bin:/bin",
  };

  test("substitutes every placeholder in systemd template", () => {
    const tpl = readFileSync(findTemplate("systemd"), "utf8");
    const out = renderTemplate(tpl, vars);
    expect(out).not.toContain("{NODE}");
    expect(out).not.toContain("{SUPERVISOR}");
    expect(out).not.toContain("{HOME}");
    expect(out).not.toContain("{PATH}");
    expect(out).not.toContain("{USER}");
    expect(out).toContain(vars.node);
    expect(out).toContain(vars.supervisor);
    expect(out).toContain(vars.home);
    expect(out).toContain(vars.path);
  });

  test("substitutes every placeholder in launchd template", () => {
    const tpl = readFileSync(findTemplate("launchd"), "utf8");
    const out = renderTemplate(tpl, vars);
    expect(out).not.toContain("{NODE}");
    expect(out).not.toContain("{SUPERVISOR}");
    expect(out).not.toContain("{HOME}");
    expect(out).not.toContain("{PATH}");
    expect(out).toContain(`<string>${vars.node}</string>`);
    expect(out).toContain(`<string>${vars.supervisor}</string>`);
    expect(out).toContain(`<string>${vars.home}/.pi/remote/supervisord.log</string>`);
  });

  test("global replacement (multiple occurrences of same placeholder)", () => {
    // HOME appears in multiple keys of the launchd plist.
    const tpl = readFileSync(findTemplate("launchd"), "utf8");
    const out = renderTemplate(tpl, vars);
    // No unsubstituted {HOME} anywhere.
    expect(out.match(/\{HOME\}/g)).toBeNull();
    // And the value appears more than once (logs + EnvironmentVariables).
    const matches = out.match(new RegExp(vars.home.replace(/[/.]/g, "\\$&"), "g"));
    expect(matches && matches.length > 1).toBe(true);
  });
});

describe("paths", () => {
  test("systemdUnitPath lives under ~/.config/systemd/user/", () => {
    expect(systemdUnitPath()).toMatch(/\.config\/systemd\/user\/remote-pi-supervisord\.service$/);
  });

  test("launchdPlistPath lives under ~/Library/LaunchAgents/", () => {
    expect(launchdPlistPath()).toMatch(/Library\/LaunchAgents\/dev\.remotepi\.supervisord\.plist$/);
  });
});

describe("defaultRenderVars", () => {
  test("populates all required fields", () => {
    const vars = defaultRenderVars();
    expect(vars.node).toBe(process.execPath);
    expect(vars.supervisor.endsWith("/bin/supervisord.js")).toBe(true);
    expect(vars.home.startsWith("/")).toBe(true);
    expect(vars.user.length).toBeGreaterThan(0);
    expect(vars.path.length).toBeGreaterThan(0);
  });
});
