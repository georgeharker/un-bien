#!/usr/bin/env node
// `unbien-launcher` — thin published wrapper. The launcher daemon itself lives
// in the un-bien extension (@geohar/un-bien, extension/src/bin/launcher.ts), so
// the code stays put in the monorepo while shipping as its own installed
// binary. Importing the extension's exported launcher entry starts the daemon
// (control-room connect + signal handling included).
import "@geohar/un-bien/launcher";
