# frozen_string_literal: true

class UnbienRelay < Formula
  desc "WebSocket relay for Un Bien remote Pi sessions"
  homepage "https://github.com/georgeharker/un-bien"
  url "https://static.crates.io/crates/un-bien-relay/un-bien-relay-0.7.3.crate"
  sha256 "f4c3a575ebc92e1dfbc61864007129dd8ba1c151b66dac484b41dcdf028832a1"
  license "MIT"

  depends_on "rust" => :build

  def install
    system "cargo", "install", *std_cargo_args
  end

  post_install_steps do
    mkdir_p "lib/unbien-relay", base: :var
    mkdir_p "log/unbien-relay", base: :var
    set_permissions ["lib/unbien-relay", "log/unbien-relay"], "0700", base: :var, recursive: false
  end

  def caveats
    <<~EOS
      The relay listens on all IPv4 interfaces on port 3000.
      Homebrew service state (mesh.db, pairing.db and relay.log) is kept in:
        #{var}/lib/unbien-relay

      Stop any existing relay and preserve its databases before switching services.
      Installation, configuration and migration instructions:
        https://github.com/georgeharker/un-bien/blob/main/docs/homebrew.md
    EOS
  end

  service do
    run opt_bin/"unbien-relay"
    keep_alive true
    working_dir var/"lib/unbien-relay"
    environment_variables UNBIEN_STATE_DIR:  var/"lib/unbien-relay",
                          UNBIEN_RELAY_PORT: "3000",
                          RUST_LOG:          "info"
    log_path var/"log/unbien-relay/stdout.log"
    error_log_path var/"log/unbien-relay/stderr.log"
  end

  test do
    assert_match "unbien-relay #{version}", shell_output("#{bin}/unbien-relay --version")

    port = free_port
    state = testpath/"relay state"
    ENV["UNBIEN_RELAY_PORT"] = port.to_s
    ENV["UNBIEN_STATE_DIR"] = state.to_s
    ENV["UNBIEN_MESH_DB_PATH"] = (state/"mesh.db").to_s
    ENV["UNBIEN_PAIRING_DB_PATH"] = (state/"pairing.db").to_s
    ENV["RUST_LOG"] = "info"

    pid = spawn bin/"unbien-relay", out: "stdout.log", err: "stderr.log"
    begin
      response = shell_output("curl --noproxy '*' --fail --silent --show-error " \
                              "--retry 10 --retry-connrefused --retry-delay 1 --max-time 2 " \
                              "http://127.0.0.1:#{port}/health")
      assert_equal "OK", response
      assert_equal "SQLite format 3\0", (state/"mesh.db").binread(16)
      assert_equal "SQLite format 3\0", (state/"pairing.db").binread(16)
      assert_path_exists state/"relay.log"
    ensure
      Process.kill "INT", pid
      Process.wait pid
    end
  end
end
