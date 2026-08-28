// Hermetic test baseline. The suite must not inherit the developer's ambient
// `UNBIEN_*` shell env — a real `UNBIEN_DIRECT_CONFIG` (the ops escape
// hatch) makes `directConfig()` win in every test, so "fresh cwd / first-time /
// no-config" assertions see a config the test never wrote. Same class of leak
// for `UNBIEN_RELAY` (relay resolution) and the `UNBIEN_DIR` /
// `UNBIEN_HOME` state-dir overrides.
//
// We UNSET these rather than pin a temp home on purpose. `unbienStateHome()`
// prefers `UNBIEN_HOME`/`UNBIEN_DIR` over `os.homedir()`, and
// pairing/storage isolates by mocking `homedir()` and resolving its home at
// import time — so a global `UNBIEN_HOME` set here is captured before that
// file's beforeEach can re-point it, silently bypassing the mock. Unsetting
// lets every test pick its own isolation (homedir mock, per-cwd temp, or its
// own env assignment) from a clean slate; there is no real `~/.pi/un-bien/
// config.json` in CI, so `globalLocalDefaults()` is already `{}`.
//
// Runs once per test file (vitest `setupFiles`), before its tests. Tests that
// intentionally SET any of these still work — they assign after this.
for (const key of [
  "UNBIEN_DIRECT_CONFIG",
  "UNBIEN_RELAY",
  "UNBIEN_DIR",
  "UNBIEN_HOME",
]) {
  delete process.env[key];
}
