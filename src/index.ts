export function registerRemotePi(): void {
  console.log("[remote-pi] extension stub loaded");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerRemotePi();
}
