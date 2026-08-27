// Hermetic test baseline. The suite must not inherit the developer's ambient
// `REMOTE_PI_*` shell env — a real `REMOTE_PI_DIRECT_CONFIG` (the ops escape
// hatch) makes `directConfig()` win in every test, so "fresh cwd / first-time /
// no-config" assertions see a config the test never wrote. Same class of leak
// for `REMOTE_PI_RELAY` (relay resolution) and the `REMOTE_PI_DIR` /
// `REMOTE_PI_HOME` state-dir overrides.
//
// We UNSET these rather than pin a temp home on purpose. `remotePiHome()`
// prefers `REMOTE_PI_HOME`/`REMOTE_PI_DIR` over `os.homedir()`, and
// pairing/storage isolates by mocking `homedir()` and resolving its home at
// import time — so a global `REMOTE_PI_HOME` set here is captured before that
// file's beforeEach can re-point it, silently bypassing the mock. Unsetting
// lets every test pick its own isolation (homedir mock, per-cwd temp, or its
// own env assignment) from a clean slate; there is no real `~/.pi/remote/
// config.json` in CI, so `globalLocalDefaults()` is already `{}`.
//
// Runs once per test file (vitest `setupFiles`), before its tests. Tests that
// intentionally SET any of these still work — they assign after this.
for (const key of [
  "REMOTE_PI_DIRECT_CONFIG",
  "REMOTE_PI_RELAY",
  "REMOTE_PI_DIR",
  "REMOTE_PI_HOME",
]) {
  delete process.env[key];
}
