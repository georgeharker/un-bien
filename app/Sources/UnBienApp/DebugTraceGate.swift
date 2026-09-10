import Foundation

/// Master gate for the per-frame/per-binding DEBUG trace logs (scroll
/// category: binding flips, viewport resizes, live arrivals, STALL gaps,
/// window recomputes, geometry rejects). DEFAULT OFF even in Debug builds:
/// every os.Logger call is captured into an Instruments trace — the volume
/// bloats the trace and makes device symbolication painfully slow (2026-09-10:
/// "copying symbols from iPhone takes ages").
///
/// Enable WITHOUT rebuilding: `defaults write <bundle-id> unbien.dbgTraceScroll 1`
/// (restart the app). Keep it OFF while profiling — the traces are the point.
#if DEBUG
let dbgTraceScroll = UserDefaults.standard.bool(forKey: "unbien.dbgTraceScroll")
#else
let dbgTraceScroll = false
#endif
