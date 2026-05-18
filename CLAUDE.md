# Remote Pi — Relay (Rust)

Servidor WebSocket **stateless** que pareia conexões por `peer_id` e roteia
ciphertext entre app e pi-extension. **Nunca decifra payload.**

## Stack

- Rust 1.94+ (edição 2024)
- Runtime: `tokio` (full features)
- WebSocket: `tokio-tungstenite`
- Serialização: `serde` + `serde_json`
- Logging: `tracing` + `tracing-subscriber` (NÃO usar `println!`)

## Comandos

- `cargo build` — build dev
- `cargo build --release` — build otimizado
- `cargo run` — roda local
- `RUST_LOG=info cargo run` — com logs visíveis
- `cargo clippy -- -D warnings` — lint estrito (deve passar antes de commit)
- `cargo fmt` — formata
- `cargo test` — testes

## Convenções

- **Erros**: `anyhow::Result<()>` no `main`, `thiserror::Error` em libs internas
- **Async**: tudo via `tokio::spawn` / `tokio::select!`, nada de `std::thread`
- **Logging**: spans com `tracing::info_span!` em handlers, `info!`/`warn!`/`error!`
- **Sem `unwrap()`** em código de produção. Use `?` e propague
- **Sem `clone()` desnecessário** — passe `&` quando possível

## Política de segurança

- Relay **NUNCA** decifra payload — todo conteúdo é ciphertext opaco
- Apenas metadados visíveis: `peer_id`, tamanho, timestamp
- Logs **NÃO** podem conter payload, mesmo cifrado
- Rate limit por `peer_id` e por IP de origem

## NÃO fazer

- Não usar `println!` (use `tracing`)
- Não usar `.unwrap()` ou `.expect()` em paths de produção
- Não logar conteúdo de mensagens
- Não adicionar persistência de payload — relay é stateless
- Não comitar `target/` (já no .gitignore raiz)

## Modo orquestrado

Se receber um prompt começando com `[ORCH:<task-id>]`, leia
`../.orchestration/INSTRUCTIONS.md` antes de qualquer outra ação. Esse marker
indica que outro agente está coordenando o trabalho e tem regras específicas
(onde escrever resultado, não comitar, etc).
