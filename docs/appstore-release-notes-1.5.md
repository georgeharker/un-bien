# App Store release notes — 1.5 line (through 1.5.4, build 21)

What's New text, App Store "What's New" field / TestFlight build notes.
Everything since 1.4 (build 8).

## iOS + macOS

- Fixed a bug where some messages could go missing from a conversation
  permanently — they now appear, and older conversations may visibly
  recover messages that were silently absent.
- History sync is reliable and complete after connection hiccups; reopened
  conversations now render everything they recovered, safely.
- Relays are now cryptographically verified: the app pins each relay's
  identity on first connect and refuses the wrong one.
- Machines appear on your home screen as soon as they're launchable —
  including machines on linked relays — without waiting for a refresh.
- The transcript renders tool calls as what they are: highlighted
  JavaScript for script calls, shell coloring for commands and output,
  tidy code blocks instead of raw JSON.
- Double-tap the message bar to jump straight to the newest messages.

## One-liner (if a single field is preferred)

Missing-message fix, reliable history recovery, verified relays, instant
machine availability, and readable tool-call transcripts.
