# Remote Pi — Pi Extension (Node + TypeScript)

Extensão para o [Pi coding agent](https://github.com/earendil-works/pi) que
adiciona o slash command `/remote-pi`. Embarca o SDK do Pi
(`@mariozechner/pi-coding-agent`) e expõe via WebSocket pro relay.

## Stack

- Node 20+ / TypeScript 6
- **Module system**: ESM only (NodeNext). Imports com extensão `.js` mesmo em `.ts`
- Package manager: **pnpm** (não usar npm/yarn)
- Crypto: libsodium-wrappers (Curve25519 + ChaCha20-Poly1305)

## Comandos

- `pnpm install` — instala deps
- `pnpm typecheck` — `tsc --noEmit`, deve passar zero erros
- `pnpm build` — `tsc`, gera `dist/`
- `pnpm dev` — `tsx src/index.ts`, executa direto sem build

## Dependências importantes

- `@mariozechner/pi-coding-agent` — SDK do Pi (`AgentSession`, `SessionManager`, `ModelRegistry`)
- `ws` — WebSocket client

## Convenções

- **Strict TS**: `"strict": true`, sem `any` exceto onde inevitável (use `unknown` + narrow)
- **Imports**: `import { foo } from "./bar.js"` (extensão obrigatória em ESM)
- **Top-level await** ok (ESM permite)
- **Erros**: `class XxxError extends Error` para classes nomeadas, throw cedo no boundary
- **Logging**: `console.log` ok no MVP; depois migrar pra `pino` ou similar

## NÃO fazer

- Não escrever CommonJS (`require`, `module.exports`)
- Não comitar `dist/` (já no .gitignore raiz)
- Não criptografar/descriptografar de forma custom — usar libsodium
- Não introduzir dependência que não seja ESM-friendly

## Modo orquestrado

Se receber um prompt começando com `[ORCH:<task-id>]`, leia
`../.orchestration/INSTRUCTIONS.md` antes de qualquer outra ação. Esse marker
indica que outro agente está coordenando o trabalho e tem regras específicas
(onde escrever resultado, não comitar, etc).
